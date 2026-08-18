/**
 * Repairing the shared index of a lane worktree before a whole-tree writer runs
 * in it.
 *
 * This is the counterpart to the landing primitive, NOT a part of it. An owned
 * landing publishes through a private index and writes back only the entries
 * for the paths it committed (decision D7), because those are the only entries
 * ownership guarantees no sibling is also using. Everything else in the index
 * is out of its reach: a sibling's staged state, drift from any other source,
 * and its own best-effort write-back when that fails.
 *
 * `hasUncommittedChanges` is immune to whatever the index holds, so nothing the
 * ENGINE does is affected. An AGENT is a different matter: `git commit -a`
 * builds its commit from the shared index, and for a path the index holds no
 * entry for, committing publishes the file's deletion — a self-commit silently
 * reverting work another context landed. A stale blob or a lingering entry
 * survives `commit -a` as an ordinary modification; only the missing-entry
 * shape destroys content.
 *
 * So the index is resynced only at moments the engine has made safe: when it
 * hands the lane to a full-access member before the first turn, or when a
 * quiescent worktree lane becomes either side of a join. Lane placement forbids a
 * full-access member from running concurrently with any other write-capable
 * member, and join admission waits for its source lanes to become idle, so no
 * sibling's staged state exists to clobber. Enveloped members never need this
 * for their own turns — they cannot write outside their prefixes, so they
 * cannot run git at all.
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
