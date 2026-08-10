/**
 * Repairing the shared index of a lane worktree before a whole-tree writer runs
 * in it.
 *
 * This is the counterpart to the landing primitive, NOT a part of it. An owned
 * landing publishes through a private index and deliberately leaves the shared
 * one untouched (decision D7), because a sibling is using it and there is no
 * moment during a concurrent landing when writing it is safe. The cost is that
 * the shared index keeps describing the pre-landing tree.
 *
 * `hasUncommittedChanges` is immune to that staleness, so nothing the ENGINE
 * does is affected. An AGENT is a different matter: `git commit -a` builds its
 * commit from the shared index, and for a path a sibling's landing ADDED the
 * index holds no entry at all. Committing that index publishes the file's
 * deletion — a self-commit silently reverting work another context landed. A
 * stale blob or a lingering entry survives `commit -a` as an ordinary
 * modification; only the added-path shape destroys content.
 *
 * So the index is resynced at the one moment it is provably safe: when the
 * engine hands the lane to a full-access member, before its first turn. Lane
 * placement forbids a full-access member from running concurrently with any
 * other write-capable member, so at that instant nobody else's staged state
 * exists to clobber. Enveloped members never need this — they cannot write
 * outside their own prefixes, so they cannot run git at all.
 *
 * Idempotent and derived: it recomputes from HEAD every time, so a failure or a
 * crash is repaired by the next dispatch rather than leaving a gap that later
 * work silently depends on.
 */

import { defaultGitClient, type GitClient } from "./client";

/**
 * Point the worktree's shared index back at HEAD, leaving working-tree files
 * untouched.
 *
 * A mixed `git reset` rather than `read-tree HEAD`: both replace the entries,
 * but only reset also refreshes the stat cache, so the following `git status`
 * does not report every path in the tree as modified until something re-hashes
 * it.
 */
export async function resyncSharedIndexToHead(
  worktreePath: string,
  client: GitClient = defaultGitClient,
): Promise<void> {
  await client.git(["reset", "--mixed", "--quiet", "HEAD"], worktreePath);
}
