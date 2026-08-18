import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { defaultGitClient, type GitClient } from "./client";
import { isMergeInProgress } from "./conflict-markers";
import { createLogger } from "../logging";
import type { DirtyPath } from "@/lib/workflow-graph/errors";
import { getErrorMessage } from "@/lib/shared/errors";

const logger = createLogger("git-worktree");

const MAX_BUFFER = 10 * 1024 * 1024;

/**
 * Worktree-relative namespace CC and its agents use for ephemeral artifacts:
 * alignment documents (the charter renders from the DB, shared docs flow
 * through the central store), validation and dev-server logs, and agent
 * scratch such as live-run evidence. None of it belongs in published history —
 * lane auto-commits stage with `git add -A`, so without this rule scratch is
 * swept into session branches and merged to main, and uncommitted scratch
 * trips the dirty-start gate and halts the final join.
 */
export const CC_ARTIFACTS_IGNORE_PATTERN = ".cc/";

/**
 * Parse output of `git status --porcelain` into structured dirty-path entries.
 * The first two bytes of each line are the status code (e.g. ` M`, `M `, `??`,
 * `R `); the path starts at byte 3. Renames use the form `R  old -> new`; we
 * record the destination path.
 */
export function parseDirtyPaths(porcelain: string): DirtyPath[] {
  const out: DirtyPath[] = [];
  for (const rawLine of porcelain.split("\n")) {
    if (rawLine.length === 0) continue;
    const statusCode = rawLine.slice(0, 2);
    const rest = rawLine.slice(3);
    if (rest.length === 0) continue;
    const arrowIdx = rest.indexOf(" -> ");
    const path = arrowIdx >= 0 ? rest.slice(arrowIdx + " -> ".length) : rest;
    out.push({
      path,
      statusCode,
      tracked: !statusCode.startsWith("??"),
    });
  }
  return out;
}

/**
 * Read the uncommitted (tracked and untracked) changes in a worktree via
 * `git status --porcelain`. Git omits ignored files by default, so the result
 * is every non-ignored change. Used as a pre-flight gate: a graph workflow lane
 * worktree forks from the committed session branch, so any uncommitted change
 * in the session worktree is invisible to lanes.
 */
export async function readWorktreeDirtyPaths(
  worktreePath: string,
  client: GitClient = defaultGitClient,
): Promise<DirtyPath[]> {
  const { stdout } = await client.git(["status", "--porcelain"], worktreePath);
  return parseDirtyPaths(stdout);
}

// ============================================================
// Attributable worktree status (porcelain v2)
// ============================================================

export type WorktreeStatusEntryKind =
  | "changed"
  | "renamed"
  | "unmerged"
  | "untracked"
  | "ignored";

export interface WorktreeStatusEntry {
  /** Repo-relative path, raw bytes — never git's C-style quoted form. */
  readonly path: string;
  /** A rename or copy's source path; null for every other record. */
  readonly originalPath: string | null;
  readonly kind: WorktreeStatusEntryKind;
}

/**
 * How many space-separated fields precede the path in each porcelain v2 record
 * kind. From `git status --porcelain=v2`:
 *   1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>
 *   2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <path>   (+ <origPath>)
 *   u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>
 */
const V2_FIELDS_BEFORE_PATH: Readonly<Record<string, number>> = {
  "1": 8,
  "2": 9,
  u: 10,
};

/** Take everything after the first `count` space-separated fields. */
function pathAfterFields(record: string, count: number): string | null {
  let cursor = 0;
  for (let field = 0; field < count; field += 1) {
    const next = record.indexOf(" ", cursor);
    if (next === -1) return null;
    cursor = next + 1;
  }
  return cursor < record.length ? record.slice(cursor) : null;
}

/**
 * Git marks an ignored or untracked DIRECTORY with a trailing slash. The
 * slash is a shape annotation rather than part of the name — no file can end
 * with one — so it is dropped here and the entry compares as the path it is.
 */
function stripDirectoryMarker(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

/**
 * Parse NUL-delimited `git status --porcelain=v2 -z` output.
 *
 * Porcelain v1 cannot answer the ownership question this feeds: it C-quotes any
 * path containing a newline, a quote, or a non-ASCII byte, and it spells a
 * rename as `old -> new` inside a single space-delimited line — so the two
 * endpoints cannot be separated without re-parsing an ambiguous encoding. v2
 * with `-z` emits raw bytes and puts a rename's source in its own NUL-delimited
 * field, which is why both endpoints survive here: a rename OUT of one member's
 * ownership and INTO another's is two attributions, and dropping either would
 * either miss real drift or blame the wrong member for a legitimate move.
 */
export function parseWorktreeStatusV2(stdout: string): WorktreeStatusEntry[] {
  const fields = stdout.split("\0");
  const entries: WorktreeStatusEntry[] = [];

  for (let index = 0; index < fields.length; index += 1) {
    const record = fields[index];
    if (record === undefined || record.length === 0) continue;
    // `--branch` headers, which callers here never request but which cost
    // nothing to tolerate.
    if (record.startsWith("#")) continue;

    const marker = record.slice(0, 1);
    if (marker === "?" || marker === "!") {
      const value = record.slice(2);
      if (value.length === 0) continue;
      entries.push({
        path: stripDirectoryMarker(value),
        originalPath: null,
        kind: marker === "?" ? "untracked" : "ignored",
      });
      continue;
    }

    const fieldsBeforePath = V2_FIELDS_BEFORE_PATH[marker];
    if (fieldsBeforePath === undefined) continue;
    const value = pathAfterFields(record, fieldsBeforePath);
    if (value === null) continue;

    if (marker === "2") {
      // The rename source is the NEXT field, not part of this record.
      index += 1;
      const originalPath = fields[index] ?? null;
      entries.push({
        path: value,
        originalPath:
          originalPath !== null && originalPath.length > 0
            ? originalPath
            : null,
        kind: "renamed",
      });
      continue;
    }

    entries.push({
      path: value,
      originalPath: null,
      kind: marker === "u" ? "unmerged" : "changed",
    });
  }

  return entries;
}

/**
 * Enumerate everything in a worktree that differs from HEAD, one entry per
 * path.
 *
 * `--untracked-files=all` is not optional for this caller: the collapsed
 * default reports a new directory as a single entry, and a directory is not
 * something ownership can be judged against.
 *
 * Ignored paths are NOT included, and no caller asks for them: `git status`
 * can only name them as the matching pattern does — `node_modules/` collapses
 * to a single entry however many files are inside it — so the report cannot
 * distinguish an appearance inside an ignored directory from the directory
 * standing still.
 */
export async function readWorktreeStatusV2(
  worktreePath: string,
  client: GitClient = defaultGitClient,
): Promise<WorktreeStatusEntry[]> {
  const { stdout } = await client.git(
    ["status", "--porcelain=v2", "-z", "--untracked-files=all"],
    worktreePath,
    { maxBuffer: MAX_BUFFER },
  );
  return parseWorktreeStatusV2(stdout);
}

/**
 * Ensure `pattern` is git-ignored for the repo owning `worktreePath` by
 * appending it to the repo's local `info/exclude`. We use `info/exclude`
 * rather than a tracked `.gitignore` so the rule never itself appears as an
 * uncommitted change, and because it lives in the shared common git dir it
 * covers the session worktree and every forked lane worktree at once.
 * Idempotent. Throws when `worktreePath` is not inside a git repository —
 * callers that create excluded files must establish the rule FIRST and treat
 * a failure here as "do not create the file".
 */
export async function ensureExcludePattern(
  worktreePath: string,
  pattern: string,
  client: GitClient = defaultGitClient,
): Promise<void> {
  const { stdout } = await client.git(
    ["rev-parse", "--git-common-dir"],
    worktreePath,
  );
  const commonDir = stdout.trim();
  const absoluteCommonDir = path.isAbsolute(commonDir)
    ? commonDir
    : path.join(worktreePath, commonDir);
  const excludePath = path.join(absoluteCommonDir, "info", "exclude");

  let current = "";
  try {
    current = await readFile(excludePath, "utf-8");
  } catch {
    // info/exclude may not exist yet; we create it below.
  }

  const alreadyExcluded = current
    .split("\n")
    .some((line) => line.trim() === pattern);
  if (alreadyExcluded) {
    return;
  }

  const needsLeadingNewline = current.length > 0 && !current.endsWith("\n");
  await mkdir(path.dirname(excludePath), { recursive: true });
  await appendFile(
    excludePath,
    `${needsLeadingNewline ? "\n" : ""}${pattern}\n`,
  );
}

/**
 * Ensure {@link CC_ARTIFACTS_IGNORE_PATTERN} is git-ignored for the repo
 * owning `worktreePath`. See {@link ensureExcludePattern}.
 */
export async function ensureCcArtifactsExcluded(
  worktreePath: string,
  client: GitClient = defaultGitClient,
): Promise<void> {
  await ensureExcludePattern(worktreePath, CC_ARTIFACTS_IGNORE_PATTERN, client);
}

export type MergeMainResult =
  | { status: "clean" }
  | { status: "conflicts"; conflictFiles: string[] };

/**
 * Namespace holding prepared squash-merge commits between prepare and publish.
 * A parked commit is reachable only through its ref, so the ref IS the
 * candidate's lifetime: it names the owning job, and deleting it hands the
 * commit to git's gc.
 */
export const PARKED_MERGE_REF_PREFIX = "refs/cc-merges/";

export interface ParkedMergeRef {
  ref: string;
  /** The job that prepared the commit — the ref's name below the prefix. */
  jobId: string;
}

export type TargetCheckoutState =
  | { kind: "not-checked-out" }
  | { kind: "clean"; worktreePath: string }
  | { kind: "dirty"; worktreePath: string; trackedDirtyPaths: DirtyPath[] };

export interface PrepareSquashMergeInput {
  projectPath: string;
  featureBranch: string;
  featureSha: string;
  targetBranch: string;
  /** Target tip captured by the caller immediately before invocation. */
  targetSha: string;
  message: string;
  jobId: string;
  /** Force a specific path; when omitted, auto-detects from `git --version`. */
  forcePath?: "plumbing" | "fallback";
}

export type PrepareResult =
  | {
      kind: "prepared";
      preparedSha: string;
      expectedTargetSha: string;
      parkedRef: string;
    }
  /**
   * The merge is a no-op: the target already contains everything the branch
   * carries, so there is no commit to park and nothing to publish. Distinct
   * from `conflicts` with an empty file list, which reads as a failure, and
   * from `prepared`, which would land an empty commit on the target.
   */
  | {
      kind: "up-to-date";
      expectedTargetSha: string;
    }
  | {
      kind: "conflicts";
      expectedTargetSha: string;
      conflictFiles: string[];
    };

export interface PublishPreparedMergeInput {
  projectPath: string;
  targetBranch: string;
  preparedSha: string;
  expectedTargetSha: string;
  parkedRef: string;
  /** When non-null, the prepared commit will be reset into this worktree
   *  (the target branch's checkout) after a successful CAS. Refresh failures
   *  are non-fatal and surfaced as `refreshWarning`. */
  cleanTargetWorktreePath: string | null;
}

export type PublishResult =
  | { kind: "published"; mergeHash: string; refreshWarning?: string }
  | { kind: "cas-lost"; actualTargetSha: string }
  /** The CAS update failed while the target tip still held `expectedTargetSha`:
   *  the ref never moved, so re-preparing cannot help (stale ref lock,
   *  permissions, a corrupt ref store). Carries the underlying git error. */
  | { kind: "publish-failed"; error: string };

/**
 * Parse the conflict-info section emitted by `git merge-tree --write-tree -z`
 * on exit code 1. Output format (NUL-separated): `<treeOID>\0<entry>\0...\0\0<messages>`
 * where each entry is `<mode> SP <oid> SP <stage> TAB <path>`. Stages 1/2/3
 * yield base/ours/theirs entries for each conflicted path; we return unique paths.
 */
export function parseMergeTreeConflicts(stdout: string): string[] {
  const [firstSection = ""] = stdout.split("\x00\x00");
  const parts = firstSection.split("\x00");
  const paths = new Set<string>();
  for (let i = 1; i < parts.length; i++) {
    const entry = parts[i];
    if (!entry) continue;
    const tabIdx = entry.indexOf("\t");
    if (tabIdx < 0) continue;
    const path = entry.slice(tabIdx + 1);
    if (path) paths.add(path);
  }
  return Array.from(paths);
}

interface ExecLikeError extends Error {
  code?: number | string;
  stdout?: string;
  stderr?: string;
}

function isExecError(err: unknown): err is ExecLikeError {
  return err instanceof Error;
}

interface WorktreeListEntry {
  worktreePath: string;
  branch: string | null;
}

/**
 * Parse output of `git worktree list --porcelain` into entries.
 * Each entry block is delimited by a blank line and starts with `worktree <path>`.
 * Branch lines look like `branch refs/heads/<name>`; detached worktrees emit
 * `detached` instead and have no branch.
 */
export function parseWorktreeList(porcelain: string): WorktreeListEntry[] {
  const entries: WorktreeListEntry[] = [];
  for (const block of porcelain.split(/\n\n+/)) {
    let worktreePath: string | null = null;
    let branch: string | null = null;
    for (const line of block.split("\n")) {
      if (line.startsWith("worktree ")) {
        worktreePath = line.slice("worktree ".length).trim();
      } else if (line.startsWith("branch refs/heads/")) {
        branch = line.slice("branch refs/heads/".length).trim();
      }
    }
    if (worktreePath !== null) {
      entries.push({ worktreePath, branch });
    }
  }
  return entries;
}

/**
 * Create a worktree-level git operations module (merge / squash merge) backed
 * by the given GitClient. Tests can inject a fake client.
 */
/**
 * Parse `git --version` output (e.g. "git version 2.39.2\n") into a numeric
 * [major, minor, patch] tuple. Returns null when the output cannot be parsed.
 */
export function parseGitVersion(
  versionOutput: string,
): [number, number, number] | null {
  const match = versionOutput.match(/git version (\d+)\.(\d+)(?:\.(\d+))?/);
  if (!match) return null;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = match[3] !== undefined ? Number(match[3]) : 0;
  if (
    !Number.isFinite(major) ||
    !Number.isFinite(minor) ||
    !Number.isFinite(patch)
  ) {
    return null;
  }
  return [major, minor, patch];
}

/** `git merge-tree --write-tree` requires git >= 2.38.0. */
function supportsMergeTreeWriteTree(
  version: [number, number, number] | null,
): boolean {
  if (!version) return false;
  const [major, minor] = version;
  if (major > 2) return true;
  if (major < 2) return false;
  return minor >= 38;
}

export function createWorktreeOperations(client: GitClient = defaultGitClient) {
  async function git(
    cwd: string,
    args: string[],
  ): Promise<{ stdout: string; stderr: string }> {
    return client.git(args, cwd, { maxBuffer: MAX_BUFFER });
  }

  let cachedVersion: Promise<[number, number, number] | null> | null = null;
  function getGitVersion(
    cwd: string,
  ): Promise<[number, number, number] | null> {
    if (cachedVersion !== null) return cachedVersion;
    cachedVersion = (async () => {
      try {
        const { stdout } = await git(cwd, ["--version"]);
        return parseGitVersion(stdout);
      } catch (err) {
        logger.warn("git.version.probe_failed", {
          error: getErrorMessage(err),
        });
        return null;
      }
    })();
    return cachedVersion;
  }

  /** Abort an unconcluded merge (MERGE_HEAD present) in the given worktree.
   *  Returns whether an abort happened. A worktree with no merge in progress
   *  is left untouched — including one where an operator manually resolved
   *  and committed the merge. */
  async function abortInProgressMerge(worktreePath: string): Promise<boolean> {
    if (!(await isMergeInProgress(worktreePath, client))) return false;
    await git(worktreePath, ["merge", "--abort"]);
    logger.info("git.abortInProgressMerge.aborted", { worktreePath });
    return true;
  }

  /**
   * Every prepared-merge commit parked in this repository, with the job id that
   * owns it. A ref whose job is finished is unreachable garbage the startup
   * sweep collects; nothing else reads `refs/cc-merges/`.
   */
  async function listParkedMergeRefs(
    projectPath: string,
  ): Promise<ParkedMergeRef[]> {
    const { stdout } = await git(projectPath, [
      "for-each-ref",
      "--format=%(refname)",
      PARKED_MERGE_REF_PREFIX,
    ]);
    return stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((ref) => ref.startsWith(PARKED_MERGE_REF_PREFIX))
      .map((ref) => ({
        ref,
        jobId: ref.slice(PARKED_MERGE_REF_PREFIX.length),
      }));
  }

  /**
   * Drop a parked prepared-merge commit, leaving it unreachable for git's own
   * gc. Returns whether a ref was there to delete — `update-ref -d` succeeds on
   * a ref that never existed, so the probe is what makes the answer honest. The
   * observed SHA is passed as the expected old value so a ref replaced between
   * the probe and the delete is left alone.
   */
  async function deleteParkedMergeRef(
    projectPath: string,
    parkedRef: string,
  ): Promise<boolean> {
    let parkedSha: string;
    try {
      const { stdout } = await git(projectPath, [
        "rev-parse",
        "--verify",
        parkedRef,
      ]);
      parkedSha = stdout.trim();
    } catch {
      return false;
    }
    if (parkedSha.length === 0) return false;
    await git(projectPath, ["update-ref", "-d", parkedRef, parkedSha]);
    logger.info("git.parkedMergeRef.deleted", {
      projectPath,
      parkedRef,
      parkedSha,
    });
    return true;
  }

  /** List files with unresolved merge conflicts (unmerged index entries). */
  async function listUnmergedFiles(worktreePath: string): Promise<string[]> {
    const { stdout } = await git(worktreePath, [
      "diff",
      "--name-only",
      "--diff-filter=U",
    ]);
    return stdout
      .split("\n")
      .map((f) => f.trim())
      .filter(Boolean);
  }

  /** Merge the target branch into the current feature branch in the given worktree.
   *  On conflict the worktree is left in conflict state (merge is NOT aborted). */
  async function mergeTargetIntoFeature(
    worktreePath: string,
    targetBranch = "main",
  ): Promise<MergeMainResult> {
    try {
      await git(worktreePath, ["merge", targetBranch]);
      return { status: "clean" };
    } catch (err) {
      const errObj = err as Error & { stderr?: string; stdout?: string };
      const stderr = errObj.stderr ?? "";
      const stdout = errObj.stdout ?? "";
      const message = errObj.message ?? "";
      const combined = `${stderr}\n${stdout}\n${message}`;

      const isConflict =
        combined.includes("CONFLICT") || combined.includes("merge conflict");

      if (!isConflict) {
        throw err;
      }

      // List conflicted (unmerged) files — do NOT abort the merge
      const conflictFiles = await listUnmergedFiles(worktreePath);

      logger.info("git.mergeTarget.conflicts", { worktreePath, conflictFiles });

      return { status: "conflicts", conflictFiles };
    }
  }

  async function prepareSquashMergePlumbing(
    input: PrepareSquashMergeInput,
  ): Promise<PrepareResult> {
    const { projectPath, featureSha, targetSha, message, jobId } = input;

    let treeOid: string;
    try {
      const { stdout } = await git(projectPath, [
        "merge-tree",
        "--write-tree",
        "-z",
        targetSha,
        featureSha,
      ]);
      treeOid = (stdout.split("\x00")[0] ?? "").trim();
      if (!treeOid) {
        throw new Error("git merge-tree returned no tree OID");
      }
    } catch (err) {
      if (isExecError(err) && err.code === 1) {
        const conflictFiles = parseMergeTreeConflicts(err.stdout ?? "");
        return {
          kind: "conflicts",
          expectedTargetSha: targetSha,
          conflictFiles,
        };
      }
      throw err;
    }

    const { stdout: targetTreeOut } = await git(projectPath, [
      "rev-parse",
      `${targetSha}^{tree}`,
    ]);
    if (treeOid === targetTreeOut.trim()) {
      logger.info("git.prepareSquashMerge.plumbing.up_to_date", {
        projectPath,
        jobId,
        expectedTargetSha: targetSha,
      });
      return { kind: "up-to-date", expectedTargetSha: targetSha };
    }

    const { stdout: commitOut } = await git(projectPath, [
      "commit-tree",
      treeOid,
      "-p",
      targetSha,
      "-m",
      message,
    ]);
    const preparedSha = commitOut.trim();
    if (!preparedSha) {
      throw new Error("git commit-tree returned no commit OID");
    }

    const parkedRef = `${PARKED_MERGE_REF_PREFIX}${jobId}`;
    await git(projectPath, ["update-ref", parkedRef, preparedSha]);

    logger.info("git.prepareSquashMerge.plumbing.success", {
      projectPath,
      jobId,
      preparedSha,
      expectedTargetSha: targetSha,
      parkedRef,
    });

    return {
      kind: "prepared",
      preparedSha,
      expectedTargetSha: targetSha,
      parkedRef,
    };
  }

  async function prepareSquashMergeFallback(
    input: PrepareSquashMergeInput,
  ): Promise<PrepareResult> {
    const { projectPath, featureBranch, targetSha, message, jobId } = input;
    const tempWorktreePath = `${projectPath}/.worktrees/__merge_${jobId}`;
    const parkedRef = `${PARKED_MERGE_REF_PREFIX}${jobId}`;

    await git(projectPath, [
      "worktree",
      "add",
      "--detach",
      tempWorktreePath,
      targetSha,
    ]);

    try {
      // Run the squash inside the detached temp worktree.
      try {
        await git(tempWorktreePath, ["merge", "--squash", featureBranch]);
      } catch (err) {
        const combined = isExecError(err)
          ? `${err.stderr ?? ""}\n${err.stdout ?? ""}\n${err.message}`
          : String(err);
        const isConflict =
          combined.includes("CONFLICT") || combined.includes("merge conflict");
        if (!isConflict) throw err;

        const { stdout: diffOut } = await git(tempWorktreePath, [
          "diff",
          "--name-only",
          "--diff-filter=U",
        ]);
        const conflictFiles = diffOut
          .split("\n")
          .map((f) => f.trim())
          .filter(Boolean);

        return {
          kind: "conflicts",
          expectedTargetSha: targetSha,
          conflictFiles,
        };
      }

      const { stdout: stagedOut } = await git(tempWorktreePath, [
        "diff",
        "--cached",
        "--name-only",
      ]);
      if (stagedOut.trim().length === 0) {
        // The squash staged nothing: the target already holds the branch's
        // work, so there is no commit to prepare.
        logger.info("git.prepareSquashMerge.fallback.up_to_date", {
          projectPath,
          jobId,
          expectedTargetSha: targetSha,
        });
        return { kind: "up-to-date", expectedTargetSha: targetSha };
      }

      await git(tempWorktreePath, ["commit", "--no-verify", "-m", message]);

      const { stdout: revOut } = await git(tempWorktreePath, [
        "rev-parse",
        "HEAD",
      ]);
      const preparedSha = revOut.trim();
      if (!preparedSha) {
        throw new Error("git rev-parse HEAD returned empty output");
      }

      await git(projectPath, ["update-ref", parkedRef, preparedSha]);

      logger.info("git.prepareSquashMerge.fallback.success", {
        projectPath,
        jobId,
        preparedSha,
        expectedTargetSha: targetSha,
        parkedRef,
        tempWorktreePath,
      });

      return {
        kind: "prepared",
        preparedSha,
        expectedTargetSha: targetSha,
        parkedRef,
      };
    } finally {
      await git(projectPath, [
        "worktree",
        "remove",
        "-f",
        tempWorktreePath,
      ]).catch((err) => {
        logger.warn("git.prepareSquashMerge.fallback.cleanup_failed", {
          projectPath,
          tempWorktreePath,
          error: getErrorMessage(err),
        });
      });
    }
  }

  async function prepareSquashMerge(
    input: PrepareSquashMergeInput,
  ): Promise<PrepareResult> {
    let path: "plumbing" | "fallback";
    if (input.forcePath) {
      path = input.forcePath;
    } else {
      const version = await getGitVersion(input.projectPath);
      path = supportsMergeTreeWriteTree(version) ? "plumbing" : "fallback";
      logger.info("git.prepareSquashMerge.auto_detect", {
        projectPath: input.projectPath,
        gitVersion: version ? version.join(".") : "unknown",
        selectedPath: path,
      });
    }
    if (path === "plumbing") {
      return prepareSquashMergePlumbing(input);
    }
    return prepareSquashMergeFallback(input);
  }

  async function publishPreparedMerge(
    input: PublishPreparedMergeInput,
  ): Promise<PublishResult> {
    const {
      projectPath,
      targetBranch,
      preparedSha,
      expectedTargetSha,
      parkedRef,
      cleanTargetWorktreePath,
    } = input;
    const targetRef = `refs/heads/${targetBranch}`;

    try {
      await git(projectPath, [
        "update-ref",
        targetRef,
        preparedSha,
        expectedTargetSha,
      ]);
    } catch (err) {
      // An update-ref failure only means CAS loss when the tip actually moved;
      // the parked ref is retained either way.
      const { stdout } = await git(projectPath, ["rev-parse", targetRef]);
      const actualTargetSha = stdout.trim();
      const stderr = isExecError(err) ? (err.stderr ?? "") : "";
      const error =
        (stderr || getErrorMessage(err)).trim() || "git update-ref failed";

      if (actualTargetSha === expectedTargetSha) {
        logger.error("git.publishPreparedMerge.publish_failed", {
          projectPath,
          targetBranch,
          expectedTargetSha,
          error,
        });
        return { kind: "publish-failed", error };
      }

      logger.info("git.publishPreparedMerge.cas_lost", {
        projectPath,
        targetBranch,
        expectedTargetSha,
        actualTargetSha,
        error,
      });
      return { kind: "cas-lost", actualTargetSha };
    }

    // CAS succeeded — refresh the clean target worktree if one was provided.
    let refreshWarning: string | undefined;
    if (cleanTargetWorktreePath !== null) {
      try {
        await git(cleanTargetWorktreePath, ["reset", "--hard", preparedSha]);
      } catch (err) {
        const stderr = isExecError(err) ? (err.stderr ?? "") : "";
        const message = getErrorMessage(err);
        refreshWarning =
          (stderr || message).trim() || "worktree refresh failed";
        logger.warn("git.publishPreparedMerge.refresh_failed", {
          projectPath,
          cleanTargetWorktreePath,
          preparedSha,
          refreshWarning,
        });
      }
    }

    // Delete the parked ref now that the merge has landed.
    await git(projectPath, ["update-ref", "-d", parkedRef, preparedSha]).catch(
      (err) => {
        logger.warn("git.publishPreparedMerge.parked_ref_delete_failed", {
          projectPath,
          parkedRef,
          preparedSha,
          error: getErrorMessage(err),
        });
      },
    );

    logger.info("git.publishPreparedMerge.success", {
      projectPath,
      targetBranch,
      preparedSha,
      refreshed:
        cleanTargetWorktreePath !== null && refreshWarning === undefined,
      refreshWarning,
    });

    return refreshWarning === undefined
      ? { kind: "published", mergeHash: preparedSha }
      : { kind: "published", mergeHash: preparedSha, refreshWarning };
  }

  /** Classify the target branch's checkout as not-checked-out / clean / dirty.
   *  Reads `git worktree list --porcelain` and (when matching) `git status
   *  --porcelain` in the matching worktree; untracked files do not count as dirty. */
  async function discoverTargetCheckout(
    projectPath: string,
    targetBranch: string,
  ): Promise<TargetCheckoutState> {
    const { stdout } = await git(projectPath, [
      "worktree",
      "list",
      "--porcelain",
    ]);
    const entries = parseWorktreeList(stdout);
    const match = entries.find((e) => e.branch === targetBranch);
    if (!match) return { kind: "not-checked-out" };

    const { stdout: statusOut } = await git(match.worktreePath, [
      "status",
      "--porcelain",
    ]);
    const trackedDirty = parseDirtyPaths(statusOut).filter((p) => p.tracked);
    if (trackedDirty.length === 0) {
      return { kind: "clean", worktreePath: match.worktreePath };
    }
    return {
      kind: "dirty",
      worktreePath: match.worktreePath,
      trackedDirtyPaths: trackedDirty,
    };
  }

  return {
    abortInProgressMerge,
    listUnmergedFiles,
    listParkedMergeRefs,
    deleteParkedMergeRef,
    mergeTargetIntoFeature,
    discoverTargetCheckout,
    prepareSquashMerge,
    publishPreparedMerge,
  };
}

// ============================================================
// Default singleton exports
// ============================================================

const defaultOps = createWorktreeOperations();

export const abortInProgressMerge = defaultOps.abortInProgressMerge;
export const listUnmergedFiles = defaultOps.listUnmergedFiles;
export const listParkedMergeRefs = defaultOps.listParkedMergeRefs;
export const deleteParkedMergeRef = defaultOps.deleteParkedMergeRef;
export const mergeTargetIntoFeature = defaultOps.mergeTargetIntoFeature;
export const discoverTargetCheckout = defaultOps.discoverTargetCheckout;
export const prepareSquashMerge = defaultOps.prepareSquashMerge;
export const publishPreparedMerge = defaultOps.publishPreparedMerge;
