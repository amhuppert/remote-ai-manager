/**
 * Landing a commit that contains exactly one set of owned paths and nothing
 * else (lightweight-parallelism decision D7).
 *
 * Concurrent contexts sharing one lane worktree land one at a time, but their
 * WORK overlaps in time: when this commit runs, every sibling's in-progress
 * edits are sitting in the same worktree, and some of them may already be
 * staged. `git add -A && git commit` cannot express "only mine" against that —
 * it reads and writes the one shared index, so a sibling's staged file rides
 * into the commit and a crash mid-stage leaves the shared index holding half a
 * landing.
 *
 * So the commit is built out of band instead, and each step exists to remove
 * one way the shared worktree could contaminate it:
 *
 *  - a PRIVATE index (`GIT_INDEX_FILE`) seeded from HEAD, so the only entries
 *    that can differ from HEAD are the ones this call stages, and the shared
 *    index is neither read nor written — whatever a sibling staged stays staged,
 *    exactly as it was;
 *  - LITERAL pathspecs (`--literal-pathspecs`), so an authored path containing
 *    `*`, `?`, or a leading `:(`  names that path rather than being interpreted
 *    as a glob or as pathspec magic. Ownership is a set of literal repo paths;
 *    letting git re-read them as patterns would widen the commit past what was
 *    declared;
 *  - a tree written from that private index and committed with `commit-tree`,
 *    then published by a compare-and-swap `update-ref`. Everything before the
 *    ref update is invisible to the repository, so a crash anywhere in the
 *    sequence leaves no partial landing to clean up — only an orphaned index
 *    file and unreferenced objects git already knows how to collect;
 *  - the no-change verdict is the private tree compared against HEAD's tree,
 *    which is scoped to the owned paths by construction. Whole-worktree
 *    `git status` cannot answer this question: a sibling is almost always dirty.
 *
 * Callers hold the session git lock; the compare-and-swap is the backstop for
 * the case where they do not, and for a HEAD that moved while this call ran.
 *
 * The shared index is left exactly as it was found — not as a convenience, but
 * because a sibling is using it, and there is no moment in a concurrent lane
 * when writing it is safe. The consequence is that it keeps the pre-landing
 * blobs for paths now in HEAD, so `git status` reads them back as `MM`: git
 * reporting committed work as work in progress. That staleness is permanent and
 * expected, which makes it the READER's problem to be immune to, not this
 * module's problem to paper over. `hasUncommittedChanges` answers "would `git
 * add -A && git commit` produce a commit" by comparing the worktree against
 * HEAD rather than trusting the index, which is true whatever the index holds.
 * A post-publication refresh here would also reintroduce a crash window: a
 * process dying between the ref update and the refresh would leave exactly the
 * stale index the refresh existed to prevent, and trailer replay classifies the
 * landing as already complete and never re-runs it (R7.3).
 */

import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import path from "node:path";
import { defaultGitClient, type GitClient } from "./client";
import { createLogger } from "../logging";

const logger = createLogger("git-owned-landing");

const MAX_BUFFER = 10 * 1024 * 1024;

/** Above this many nominated paths, stage the whole tree instead of naming them. */
const MAX_PROBE_PATHSPECS = 256;

export interface OwnedLandingRequest {
  /** The lane worktree the owning context ran in. */
  worktreePath: string;
  /** The full commit message, trailer included. */
  message: string;
  /**
   * Repo-relative POSIX paths (files or directories) this landing may commit.
   * Interpreted literally — never as globs or pathspec magic.
   */
  ownedPaths: readonly string[];
}

export type OwnedLandingResult =
  | { status: "committed"; hash: string }
  | { status: "no-changes" };

/** Split NUL-delimited git output, dropping the trailing empty element. */
function splitNul(stdout: string): string[] {
  return stdout.split("\0").filter((entry) => entry.length > 0);
}

/**
 * True when `candidate` is `prefix` itself or sits beneath it.
 *
 * Byte comparison on repo-relative POSIX paths, matching how git resolved the
 * same pathspec: component-aware, so `src/api` does not claim `src/apix`.
 */
function isUnderPrefix(candidate: string, prefix: string): boolean {
  return candidate === prefix || candidate.startsWith(`${prefix}/`);
}

export function createOwnedLandingOperations(
  client: GitClient = defaultGitClient,
) {
  async function git(
    worktreePath: string,
    args: string[],
    indexFile?: string,
  ): Promise<string> {
    const { stdout } = await client.git(args, worktreePath, {
      maxBuffer: MAX_BUFFER,
      ...(indexFile === undefined
        ? {}
        : { env: { GIT_INDEX_FILE: indexFile } }),
    });
    return stdout;
  }

  /**
   * Narrow the owned prefixes to the ones git can act on.
   *
   * `git add` fails outright on a pathspec that matches nothing (a path the
   * context never created) and on one whose only matches are ignored, and a
   * failed landing is a halt. `ls-files` answers the same match question
   * without failing, so the prefixes that would have aborted the add are simply
   * the ones with nothing to contribute.
   */
  async function selectStageablePrefixes(
    worktreePath: string,
    indexFile: string,
    ownedPaths: readonly string[],
  ): Promise<string[]> {
    if (ownedPaths.length === 0) return [];
    const stdout = await git(
      worktreePath,
      [
        "--literal-pathspecs",
        "ls-files",
        "-z",
        "--cached",
        "--others",
        "--exclude-standard",
        "--",
        ...ownedPaths,
      ],
      indexFile,
    );
    const matched = splitNul(stdout);
    return ownedPaths.filter((prefix) =>
      matched.some((file) => isUnderPrefix(file, prefix)),
    );
  }

  /**
   * Whether the working tree's content is exactly HEAD's — the question
   * "would `git add -A && git commit` produce a commit" asked in reverse.
   *
   * This is the reader half of the same contract {@link commitOwnedPaths}
   * writes under. Because a landing publishes through a private index, the
   * shared index in a lane worktree routinely disagrees with HEAD: it holds
   * pre-landing blobs for modified paths, no entry at all for added ones, and a
   * lingering entry for deleted ones. Every ordinary probe reads through that
   * index, so `git status` reports committed work as pending and `git diff
   * HEAD` reports a landed-but-unindexed file as deleted. Believing either one
   * sends a whole-tree commit into `git add -A` followed by "nothing to
   * commit".
   *
   * So the probes are used only to NOMINATE paths, and the verdict comes from
   * a private index seeded from HEAD: stage the nominees into it, write the
   * tree, and compare. Restricting the staging to nominees is what keeps this
   * affordable — a clean tree hashes nothing, and a tree clean apart from a
   * just-landed prefix hashes only that prefix — and it is sound because a path
   * neither probe names matches the index, which matches HEAD.
   */
  async function worktreeMatchesHead(worktreePath: string): Promise<boolean> {
    const headTree = (
      await git(worktreePath, ["rev-parse", "HEAD^{tree}"])
    ).trim();

    const [diffOut, othersOut] = await Promise.all([
      git(worktreePath, [
        "--literal-pathspecs",
        "diff",
        "--name-only",
        "-z",
        "HEAD",
      ]),
      git(worktreePath, [
        "--literal-pathspecs",
        "ls-files",
        "-z",
        "--others",
        "--exclude-standard",
      ]),
    ]);
    const candidates = [
      ...new Set([...splitNul(diffOut), ...splitNul(othersOut)]),
    ];
    if (candidates.length === 0) return true;

    const gitDir = (
      await git(worktreePath, ["rev-parse", "--absolute-git-dir"])
    ).trim();
    const indexFile = path.join(gitDir, `cc-probe-${randomUUID()}.index`);
    try {
      await git(worktreePath, ["read-tree", "HEAD"], indexFile);
      // Past a certain width, naming every nominee costs more than re-walking
      // the tree — and the command line has a hard limit the nominee list does
      // not. `--all` with no pathspec stages the same content either way.
      const scope =
        candidates.length > MAX_PROBE_PATHSPECS ? [] : ["--", ...candidates];
      await git(
        worktreePath,
        ["--literal-pathspecs", "add", "--all", ...scope],
        indexFile,
      );
      const tree = (await git(worktreePath, ["write-tree"], indexFile)).trim();
      return tree === headTree;
    } finally {
      await rm(indexFile, { force: true });
    }
  }

  async function commitOwnedPaths(
    request: OwnedLandingRequest,
  ): Promise<OwnedLandingResult> {
    const { worktreePath, message, ownedPaths } = request;
    if (!message.trim()) {
      throw new Error("Commit message cannot be empty");
    }

    const headSha = (await git(worktreePath, ["rev-parse", "HEAD"])).trim();
    const headTree = (
      await git(worktreePath, ["rev-parse", "HEAD^{tree}"])
    ).trim();
    // The checked-out branch is read from the worktree rather than taken from
    // the caller: it is the ref `commit-tree` output has to replace for HEAD to
    // move, and a detached lane worktree has no such ref to update.
    const branchRef = (
      await git(worktreePath, ["symbolic-ref", "HEAD"])
    ).trim();

    const gitDir = (
      await git(worktreePath, ["rev-parse", "--absolute-git-dir"])
    ).trim();
    // Kept inside the git directory (per-worktree for a linked worktree) so the
    // private index shares a filesystem with the object store and cannot leak
    // into the tree the landing is about to commit.
    const indexFile = path.join(gitDir, `cc-landing-${randomUUID()}.index`);

    try {
      await git(worktreePath, ["read-tree", headSha], indexFile);

      const stageable = await selectStageablePrefixes(
        worktreePath,
        indexFile,
        ownedPaths,
      );
      if (stageable.length > 0) {
        await git(
          worktreePath,
          ["--literal-pathspecs", "add", "--all", "--", ...stageable],
          indexFile,
        );
      }

      const tree = (await git(worktreePath, ["write-tree"], indexFile)).trim();
      if (tree === headTree) {
        logger.info("git.ownedLanding.noChanges", {
          worktreePath,
          ownedPathCount: ownedPaths.length,
        });
        return { status: "no-changes" };
      }

      const hash = (
        await git(worktreePath, [
          "commit-tree",
          tree,
          "-p",
          headSha,
          "-m",
          message,
        ])
      ).trim();

      // Compare-and-swap against the HEAD this tree was built on: a landing
      // that raced another one publishes nothing rather than discarding the
      // commit it did not see.
      await git(worktreePath, [
        "update-ref",
        "-m",
        "command-center: owned landing",
        branchRef,
        hash,
        headSha,
      ]);

      logger.info("git.ownedLanding.committed", {
        worktreePath,
        branchRef,
        hash,
        ownedPathCount: ownedPaths.length,
        stagedPrefixCount: stageable.length,
      });
      return { status: "committed", hash };
    } finally {
      await rm(indexFile, { force: true });
    }
  }

  return { commitOwnedPaths, worktreeMatchesHead };
}

// ============================================================
// Default singleton exports
// ============================================================

const defaultOps = createOwnedLandingOperations();

export const commitOwnedPaths = defaultOps.commitOwnedPaths;
export const worktreeMatchesHead = defaultOps.worktreeMatchesHead;
