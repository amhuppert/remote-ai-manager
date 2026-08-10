import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID, createHash } from "node:crypto";
import { unlink as unlinkDefault } from "node:fs/promises";
import type { SessionDiff, FileDiff, DiffHunk, DiffLine } from "./schemas";
import { defaultGitClient, type GitClient } from "./client";
import { createLogger } from "@/lib/logging";
import { timed } from "@/lib/logging/timed";

const logger = createLogger("diff");

const MAX_BUFFER = 10 * 1024 * 1024;

/* ------------------------------------------------------------------ */
/*  DI for computeDiff                                                 */
/* ------------------------------------------------------------------ */

export interface ComputeDiffDeps {
  gitClient: GitClient;
  unlink(path: string): Promise<void>;
}

const defaultComputeDiffDeps: ComputeDiffDeps = {
  gitClient: defaultGitClient,
  unlink: unlinkDefault,
};

// Cache the parsed SessionDiff per worktree path, keyed on a cheap token built
// from `git rev-parse HEAD` + a hash of `git status --porcelain=v1 -z`. Polling
// clients hit /diff many times per minute; the read-tree/add-A/diff sequence is
// ~1.5s exclusive per call on large worktrees. When HEAD and the working tree
// porcelain are unchanged, the diff is by definition identical — return the
// cached object by reference so React Query short-circuits re-renders.
const DIFF_CACHE_MAX = 100;

interface DiffCacheEntry {
  token: string;
  diff: SessionDiff;
}

const diffCache = new Map<string, DiffCacheEntry>();

export function _resetDiffCacheForTesting(): void {
  diffCache.clear();
}

async function computeCacheToken(
  worktreePath: string,
  deps: ComputeDiffDeps,
): Promise<string | null> {
  try {
    const opts = { maxBuffer: MAX_BUFFER };
    const head = await deps.gitClient.git(
      ["rev-parse", "HEAD"],
      worktreePath,
      opts,
    );
    const status = await deps.gitClient.git(
      ["status", "--porcelain=v1", "-z"],
      worktreePath,
      opts,
    );
    const statusHash = createHash("sha1").update(status.stdout).digest("hex");
    return `${head.stdout.trim()}:${statusHash}`;
  } catch {
    return null;
  }
}

/**
 * Compute a git diff of uncommitted changes in the session worktree.
 * Uses a temporary index so that untracked files are included in the diff
 * without modifying the real index. Diffs the working tree against HEAD
 * so only truly uncommitted changes are shown.
 */
export async function computeDiff(
  worktreePath: string,
  deps: ComputeDiffDeps = defaultComputeDiffDeps,
): Promise<SessionDiff> {
  return timed(
    logger,
    "diff.compute",
    { worktreePath },
    async () => {
      const token = await computeCacheToken(worktreePath, deps);
      if (token !== null) {
        const cached = diffCache.get(worktreePath);
        if (cached && cached.token === token) {
          return cached.diff;
        }
      }

      const diff = await computeDiffImpl(worktreePath, deps);

      if (token !== null) {
        if (diffCache.size >= DIFF_CACHE_MAX) {
          const firstKey = diffCache.keys().next().value;
          if (firstKey !== undefined) diffCache.delete(firstKey);
        }
        diffCache.set(worktreePath, { token, diff });
      }

      return diff;
    },
    (result) => ({ fileCount: result.files.length }),
  );
}

/**
 * How much of a worktree a candidate identity and patch cover.
 *
 * `wholeTree` is the historical reading and stays the reading for a full-access
 * context: everything `add -A` stages. `owned` is the reading for a context
 * confined by a file-ownership envelope, where the worktree is shared with
 * concurrent siblings — so "the candidate" has to mean the context's own
 * declared subset, and nothing a sibling is doing in its own paths (R15).
 *
 * An `owned` scope with no paths is the read-only grade, not a degenerate
 * whole-tree one: a context with no write surface produces no changes, and
 * showing it the shared worktree's whole delta would show it every sibling's
 * work as if it were its own.
 */
export type CandidateScope =
  | { mode: "wholeTree" }
  | { mode: "owned"; ownedPaths: readonly string[] };

export const WHOLE_TREE_CANDIDATE_SCOPE: CandidateScope = { mode: "wholeTree" };

/**
 * Owned repo-relative paths as git pathspecs.
 *
 * `:(literal)` is load-bearing: an authored ownership entry is a literal path
 * (a glob is a spec non-goal), so a filename containing `*`, `?`, or `[` must
 * match itself and nothing else. Passed raw, `a/st*ar.txt` would also pull
 * `a/steer.txt` into the subset, widening what a validator reviews and what the
 * frozen identity covers.
 */
function ownedPathspecs(ownedPaths: readonly string[]): string[] {
  return ownedPaths.map((ownedPath) => `:(literal)${ownedPath}`);
}

interface TemporaryIndexOpts {
  maxBuffer: number;
  env: { GIT_INDEX_FILE: string };
}

/**
 * The owned pathspecs that currently match something `add` would stage.
 *
 * `add` dies on a pathspec matching nothing, and an owned path a context has
 * not created yet is perfectly legitimate — so each spec is probed before it
 * reaches `add`. The probe is `ls-files`, which tolerates an unmatched
 * pathspec, run one spec at a time against the same temporary index so the
 * MATCH decision stays inside git's own pathspec engine. Comparing `ls-files`
 * output against the declared paths in JS instead would be a lexical fallback
 * that disagrees with `add` wherever the two resolve differently — under
 * `core.ignorecase` most obviously — and a spec wrongly judged unmatched would
 * leave real owned changes outside both the patch and the frozen identity.
 *
 * Between `--cached` and `--others --exclude-standard` the probe sees exactly
 * what `add -A` would stage: tracked entries, including ones deleted from the
 * worktree, plus untracked non-ignored files.
 */
async function stageableOwnedPathspecs(
  worktreePath: string,
  ownedPaths: readonly string[],
  deps: ComputeDiffDeps,
  tmpOpts: TemporaryIndexOpts,
): Promise<string[]> {
  const probed = await Promise.all(
    ownedPathspecs(ownedPaths).map(async (spec) => {
      const { stdout } = await deps.gitClient.git(
        [
          "ls-files",
          "-z",
          "--cached",
          "--others",
          "--exclude-standard",
          "--",
          spec,
        ],
        worktreePath,
        tmpOpts,
      );
      return stdout.length > 0 ? spec : null;
    }),
  );
  return probed.filter((spec): spec is string => spec !== null);
}

/**
 * Bring the temporary index up to the working tree for exactly what the scope
 * covers.
 *
 * Restricting the staging of an owned scope is a correctness requirement, not
 * an optimization. `add -A` reads every path in the worktree, and an enveloped
 * context's worktree is shared with siblings that are writing theirs right now:
 * a file replaced, truncated, removed, or created in a form git cannot index
 * aborts the whole command ("fatal: adding files failed"). Staged unscoped, a
 * sibling mid-turn would therefore collapse THIS context's candidate into an
 * unresolvable one over work it does not own — and a validation round cannot
 * open, or re-verify, against a candidate it cannot read (R15).
 *
 * A read-only scope stages nothing at all: it owns no path that could differ
 * from HEAD, so there is nothing about the shared worktree it needs to read.
 */
async function stageScope(
  worktreePath: string,
  scope: CandidateScope,
  deps: ComputeDiffDeps,
  tmpOpts: TemporaryIndexOpts,
): Promise<void> {
  if (scope.mode === "wholeTree") {
    await deps.gitClient.git(["add", "-A"], worktreePath, tmpOpts);
    return;
  }
  if (scope.ownedPaths.length === 0) return;
  const specs = await stageableOwnedPathspecs(
    worktreePath,
    scope.ownedPaths,
    deps,
    tmpOpts,
  );
  if (specs.length === 0) return;
  await deps.gitClient.git(
    ["add", "-A", "--", ...specs],
    worktreePath,
    tmpOpts,
  );
}

/**
 * Build the temporary index every reader of "the working tree as a candidate"
 * shares — seeded from the HEAD tree, then brought up to the working tree over
 * the scope's paths — and hand it to `run` as the git options that address it.
 *
 * The real index is never touched, which is what lets a caller stage untracked
 * files without disturbing the session's own staging area. What is staged is
 * exactly what lands inside the resulting content: untracked files and file
 * modes are in, gitignored paths are out, and under an owned scope so is every
 * path the context does not own.
 *
 * Shared rather than duplicated so the diff a validator reads and the tree hash
 * a validation round freezes on cannot describe two different candidates.
 */
async function withTemporaryIndex<T>(
  worktreePath: string,
  scope: CandidateScope,
  deps: ComputeDiffDeps,
  run: (opts: TemporaryIndexOpts) => Promise<T>,
): Promise<T | null> {
  const tmpIndex = join(tmpdir(), `cc-diff-${randomUUID()}`);
  try {
    const tmpOpts: TemporaryIndexOpts = {
      maxBuffer: MAX_BUFFER,
      env: { GIT_INDEX_FILE: tmpIndex },
    };
    await deps.gitClient.git(["read-tree", "HEAD"], worktreePath, tmpOpts);
    await stageScope(worktreePath, scope, deps, tmpOpts);
    return await run(tmpOpts);
  } catch {
    return null;
  } finally {
    await deps.unlink(tmpIndex).catch(() => {});
  }
}

/** Byte-order comparison, so an identity does not depend on the host locale. */
function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

interface OwnedIndexEntry {
  mode: string;
  objectId: string;
  path: string;
}

/**
 * Parse `ls-files -s -z` records (`<mode> <objectId> <stage>\t<path>`).
 *
 * An unparseable record throws rather than being skipped. A dropped entry would
 * make a real owned change invisible to the identity, which is the one failure
 * mode a frozen candidate cannot tolerate; the throw surfaces as an unresolvable
 * candidate, and an unresolvable candidate stops a round from opening.
 */
function parseOwnedIndexEntries(raw: string): OwnedIndexEntry[] {
  const entries: OwnedIndexEntry[] = [];
  for (const record of raw.split("\0")) {
    if (record.length === 0) continue;
    // `.` spans newlines: `-z` output is unquoted, so a filename may contain one.
    const [, mode, objectId, , path] =
      /^(\d+) ([0-9a-f]+) (\d+)\t(.+)$/s.exec(record) ?? [];
    if (mode === undefined || objectId === undefined || path === undefined) {
      throw new Error(`unparseable index entry: ${JSON.stringify(record)}`);
    }
    entries.push({ mode, objectId, path });
  }
  return entries;
}

/**
 * The content identity of an owned subset: the declared paths plus the index
 * entry (mode, blob id, path) each one currently resolves to.
 *
 * The declared paths are inside the digest, not just the entries, so widening
 * ownership to a still-empty directory is drift rather than a silent no-op. A
 * deletion is carried by absence — an owned path present at the lane base and
 * gone now contributes no entry, which is a different digest from the one where
 * it is still there.
 *
 * Length-prefixed fields so no path or mode can forge a field boundary: two
 * different subsets cannot collide by embedding a delimiter in a filename.
 */
function digestOwnedSubset(
  ownedPaths: readonly string[],
  entries: readonly OwnedIndexEntry[],
): string {
  const field = (value: string): string =>
    `${Buffer.byteLength(value, "utf8")}:${value}`;
  const canonical = [
    ...[...ownedPaths]
      .sort(compareStrings)
      .map((path) => `path ${field(path)}`),
    ...[...entries]
      .sort((left, right) => compareStrings(left.path, right.path))
      .map(
        (entry) =>
          `entry ${field(entry.mode)}${field(entry.objectId)}${field(entry.path)}`,
      ),
  ].join("\n");
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

/**
 * Read a scope's identity out of an already-built temporary index.
 *
 * A whole-tree scope writes the index as a tree object. An owned scope cannot:
 * the index is still seeded from the whole HEAD tree, so `write-tree` would
 * hash every path in the repository and move whenever a sibling landed a commit
 * — one of the two things a scoped identity exists to be stable under.
 * Restricting the READ as well (`ls-files` under the owned pathspecs) yields an
 * identity over exactly the subset, from the same index the patch is read from.
 */
async function readScopeIdentity(
  worktreePath: string,
  scope: CandidateScope,
  deps: ComputeDiffDeps,
  tmpOpts: TemporaryIndexOpts,
): Promise<string> {
  if (scope.mode === "wholeTree") {
    const { stdout } = await deps.gitClient.git(
      ["write-tree"],
      worktreePath,
      tmpOpts,
    );
    return stdout.trim();
  }
  if (scope.ownedPaths.length === 0) return digestOwnedSubset([], []);
  const { stdout } = await deps.gitClient.git(
    ["ls-files", "-s", "-z", "--", ...ownedPathspecs(scope.ownedPaths)],
    worktreePath,
    tmpOpts,
  );
  return digestOwnedSubset(scope.ownedPaths, parseOwnedIndexEntries(stdout));
}

/** The patch a scope covers, read out of the same already-built index. */
async function readScopeRawDiff(
  worktreePath: string,
  scope: CandidateScope,
  deps: ComputeDiffDeps,
  tmpOpts: TemporaryIndexOpts,
): Promise<string> {
  // No pathspec means "every path" to git, so an empty owned subset must never
  // reach the command: a read-only context would be handed the shared
  // worktree's entire delta as its own change set.
  if (scope.mode === "owned" && scope.ownedPaths.length === 0) return "";
  const { stdout } = await deps.gitClient.git(
    [
      "diff",
      "--cached",
      "HEAD",
      "--unified=3",
      ...(scope.mode === "owned"
        ? ["--", ...ownedPathspecs(scope.ownedPaths)]
        : []),
    ],
    worktreePath,
    tmpOpts,
  );
  return stdout;
}

/**
 * The identity of the worktree's candidate content, read from the same
 * temporary index {@link computeDiff} builds.
 *
 * This is a content identity for "what a reviewer is looking at" — it moves for
 * any change the rendered diff would show, including a content-only edit to an
 * already-modified file, which the porcelain-based diff cache token cannot see.
 * For that reason it deliberately does not participate in that cache.
 *
 * Its FORM follows the scope: a git tree object id for a whole-tree scope, and
 * an owned-subset digest for a scoped one. The two are never comparable, which
 * is why a caller that persists one also records which scope produced it.
 *
 * Null when git state cannot be resolved (not a repository, no HEAD, git
 * failure): the caller decides what an unresolvable identity means rather than
 * receiving a fabricated one.
 */
export async function computeCandidateTreeHash(
  worktreePath: string,
  scope: CandidateScope = WHOLE_TREE_CANDIDATE_SCOPE,
  deps: ComputeDiffDeps = defaultComputeDiffDeps,
): Promise<string | null> {
  const hash = await withTemporaryIndex(worktreePath, scope, deps, (tmpOpts) =>
    readScopeIdentity(worktreePath, scope, deps, tmpOpts),
  );
  return hash === null || hash.length === 0 ? null : hash;
}

/**
 * Whether anything inside the scope is uncommitted — the cheap porcelain probe
 * that tells a genuinely clean candidate apart from a degraded read.
 *
 * Scoped for the same reason the patch is: in a shared lane worktree a sibling's
 * dirt is not this context's dirt, and an unscoped probe would report a clean
 * owned subset as dirty and then find nothing to show for it. A read-only scope
 * is clean by construction and asks git nothing.
 *
 * Throws when git itself cannot answer, so an unavailable git is distinguishable
 * from a clean worktree.
 */
export async function hasCandidateScopeChanges(
  worktreePath: string,
  scope: CandidateScope = WHOLE_TREE_CANDIDATE_SCOPE,
  deps: ComputeDiffDeps = defaultComputeDiffDeps,
): Promise<boolean> {
  if (scope.mode === "owned" && scope.ownedPaths.length === 0) return false;
  const { stdout } = await deps.gitClient.git(
    [
      "status",
      "--porcelain",
      "--untracked-files=all",
      ...(scope.mode === "owned"
        ? ["--", ...ownedPathspecs(scope.ownedPaths)]
        : []),
    ],
    worktreePath,
    { maxBuffer: MAX_BUFFER },
  );
  return stdout.trim().length > 0;
}

/**
 * A candidate's content identity together with the patch that identity spans.
 *
 * `treeHash` is whatever {@link computeCandidateTreeHash} yields for the scope
 * the snapshot was read under — a git tree object id whole-tree, an owned-subset
 * digest scoped.
 */
export interface CandidateSnapshot {
  treeHash: string;
  diff: SessionDiff;
}

/**
 * Read the candidate ONCE: the tree object and the patch against HEAD, both
 * produced from a single temporary index.
 *
 * The pairing is the point. {@link computeDiff} is cached on HEAD plus a
 * porcelain hash, and porcelain cannot see a content-only edit to a file that
 * was already modified — so a reader that took its tree hash from
 * {@link computeCandidateTreeHash} and its patch from the cache could hold a
 * patch OLDER than the tree it claims to describe. A validation round certifies
 * a tree hash on the strength of what its reviewers read, so it reads through
 * here instead: same index, same instant, no cache.
 *
 * Null when the temporary-index sequence fails, so an unresolvable candidate is
 * distinguishable from a clean one rather than collapsing into an empty diff.
 *
 * `scope` decides what "the candidate" means. Under an owned scope both reads
 * are restricted to the same owned pathspecs, so the identity a round freezes
 * and the bytes its validators are shown describe one and the same subset — and
 * a sibling writing or landing its own paths moves neither.
 */
export async function computeCandidateSnapshot(
  worktreePath: string,
  scope: CandidateScope = WHOLE_TREE_CANDIDATE_SCOPE,
  deps: ComputeDiffDeps = defaultComputeDiffDeps,
): Promise<CandidateSnapshot | null> {
  const snapshot = await withTemporaryIndex(
    worktreePath,
    scope,
    deps,
    async (tmpOpts) => {
      const treeHash = await readScopeIdentity(
        worktreePath,
        scope,
        deps,
        tmpOpts,
      );
      const rawDiff = await readScopeRawDiff(
        worktreePath,
        scope,
        deps,
        tmpOpts,
      );
      return { treeHash: treeHash.trim(), rawDiff };
    },
  );

  if (snapshot === null || snapshot.treeHash.length === 0) return null;

  return {
    treeHash: snapshot.treeHash,
    diff: snapshot.rawDiff.trim()
      ? parseDiff(snapshot.rawDiff)
      : { files: [], totalAdditions: 0, totalDeletions: 0 },
  };
}

async function computeDiffImpl(
  worktreePath: string,
  deps: ComputeDiffDeps,
): Promise<SessionDiff> {
  const rawDiff = await withTemporaryIndex(
    worktreePath,
    WHOLE_TREE_CANDIDATE_SCOPE,
    deps,
    async (tmpOpts) => {
      // Diff the temp index (working tree) against HEAD — uncommitted changes only
      const { stdout } = await deps.gitClient.git(
        ["diff", "--cached", "HEAD", "--unified=3"],
        worktreePath,
        tmpOpts,
      );
      return stdout;
    },
  );

  // A null result means the temp-index sequence failed; an empty diff and a
  // failed diff both render as "no uncommitted changes" here, as before.
  if (rawDiff === null || !rawDiff.trim()) {
    return { files: [], totalAdditions: 0, totalDeletions: 0 };
  }

  return parseDiff(rawDiff);
}

/** Parse unified diff output into structured data */
export function parseDiff(raw: string): SessionDiff {
  const files: FileDiff[] = [];
  const lines = raw.split("\n");

  let currentFile: FileDiff | null = null;
  let currentHunk: DiffHunk | null = null;

  for (const line of lines) {
    // New file header: diff --git a/path b/path
    if (line.startsWith("diff --git ")) {
      if (currentFile) {
        if (currentHunk) {
          currentFile.hunks.push(currentHunk);
          currentHunk = null;
        }
        files.push(currentFile);
      }

      // Extract file path from "diff --git a/foo b/foo"
      const match = /^diff --git a\/(.*?) b\/(.*)$/.exec(line);
      const filePath = match?.[2] ?? line;

      currentFile = {
        filePath,
        additions: 0,
        deletions: 0,
        hunks: [],
      };
      continue;
    }

    // Skip index, ---, +++ lines
    if (
      line.startsWith("index ") ||
      line.startsWith("--- ") ||
      line.startsWith("+++ ") ||
      line.startsWith("new file mode") ||
      line.startsWith("deleted file mode") ||
      line.startsWith("old mode") ||
      line.startsWith("new mode")
    ) {
      continue;
    }

    // Hunk header: @@ -a,b +c,d @@
    if (line.startsWith("@@")) {
      if (currentHunk && currentFile) {
        currentFile.hunks.push(currentHunk);
      }
      currentHunk = {
        header: line,
        lines: [{ type: "hunk-header", content: line }],
      };
      continue;
    }

    if (!currentHunk || !currentFile) continue;

    // Addition
    if (line.startsWith("+")) {
      const diffLine: DiffLine = {
        type: "add",
        content: line.slice(1),
      };
      currentHunk.lines.push(diffLine);
      currentFile.additions++;
      continue;
    }

    // Deletion
    if (line.startsWith("-")) {
      const diffLine: DiffLine = {
        type: "remove",
        content: line.slice(1),
      };
      currentHunk.lines.push(diffLine);
      currentFile.deletions++;
      continue;
    }

    // Context line (starts with space or is empty)
    if (line.startsWith(" ") || line === "") {
      currentHunk.lines.push({
        type: "context",
        content: line.startsWith(" ") ? line.slice(1) : "",
      });
    }
  }

  // Push final file/hunk
  if (currentFile) {
    if (currentHunk) {
      currentFile.hunks.push(currentHunk);
    }
    files.push(currentFile);
  }

  const totalAdditions = files.reduce((sum, f) => sum + f.additions, 0);
  const totalDeletions = files.reduce((sum, f) => sum + f.deletions, 0);

  return { files, totalAdditions, totalDeletions };
}
