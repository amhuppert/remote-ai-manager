import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { defaultGitClient, type GitClient } from "./client";
import { createLogger } from "../logging";
import type { DirtyPath } from "@/lib/workflow-graph/errors";

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

/**
 * Ensure {@link CC_ARTIFACTS_IGNORE_PATTERN} is git-ignored for the repo
 * owning `worktreePath` by appending it to the repo's local `info/exclude`. We
 * use `info/exclude` rather than a tracked `.gitignore` so the rule never
 * itself appears as an uncommitted change, and because it lives in the shared
 * common git dir it covers the session worktree and every forked lane worktree
 * at once. Idempotent.
 */
export async function ensureCcArtifactsExcluded(
  worktreePath: string,
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
    .some((line) => line.trim() === CC_ARTIFACTS_IGNORE_PATTERN);
  if (alreadyExcluded) {
    return;
  }

  const needsLeadingNewline = current.length > 0 && !current.endsWith("\n");
  await mkdir(path.dirname(excludePath), { recursive: true });
  await appendFile(
    excludePath,
    `${needsLeadingNewline ? "\n" : ""}${CC_ARTIFACTS_IGNORE_PATTERN}\n`,
  );
}

export type MergeMainResult =
  | { status: "clean" }
  | { status: "conflicts"; conflictFiles: string[] };

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
  | { kind: "cas-lost"; actualTargetSha: string };

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
          error: err instanceof Error ? err.message : String(err),
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
    try {
      await git(worktreePath, ["rev-parse", "-q", "--verify", "MERGE_HEAD"]);
    } catch {
      return false;
    }
    await git(worktreePath, ["merge", "--abort"]);
    logger.info("git.abortInProgressMerge.aborted", { worktreePath });
    return true;
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
      const { stdout: diffOut } = await git(worktreePath, [
        "diff",
        "--name-only",
        "--diff-filter=U",
      ]);

      const conflictFiles = diffOut
        .split("\n")
        .map((f) => f.trim())
        .filter(Boolean);

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

    const parkedRef = `refs/cc-merges/${jobId}`;
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
    const parkedRef = `refs/cc-merges/${jobId}`;

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
        // No staged changes -> feature already matches target; surface as
        // empty-conflicts since there is nothing to publish.
        return {
          kind: "conflicts",
          expectedTargetSha: targetSha,
          conflictFiles: [],
        };
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
          error: err instanceof Error ? err.message : String(err),
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
      // CAS lost: capture the current target tip so the caller can decide
      // whether to re-prepare. Parked ref is intentionally retained.
      const { stdout } = await git(projectPath, ["rev-parse", targetRef]);
      const actualTargetSha = stdout.trim();
      logger.info("git.publishPreparedMerge.cas_lost", {
        projectPath,
        targetBranch,
        expectedTargetSha,
        actualTargetSha,
        error: err instanceof Error ? err.message : String(err),
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
        const message = err instanceof Error ? err.message : String(err);
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
          error: err instanceof Error ? err.message : String(err),
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
export const mergeTargetIntoFeature = defaultOps.mergeTargetIntoFeature;
export const discoverTargetCheckout = defaultOps.discoverTargetCheckout;
export const prepareSquashMerge = defaultOps.prepareSquashMerge;
export const publishPreparedMerge = defaultOps.publishPreparedMerge;
