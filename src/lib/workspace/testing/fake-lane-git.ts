import type { LaneGit } from "../lane-git";

/**
 * An in-memory repository for lane tests: branch heads, commit messages,
 * dirty paths per worktree, and merge results. Landing commits whatever the
 * lane worktree holds; publishing moves the target head only if it is still
 * the expected one.
 */
export function createFakeLaneGit(initial: Record<string, string> = {}) {
  const heads = new Map<string, string>(Object.entries(initial));
  const messages = new Map<string, string>();
  const dirt = new Map<string, string[]>();
  const branchOf = new Map<string, string>();
  let commits = 0;
  const state = {
    heads,
    messages,
    dirt,
    /** Files the next merges conflict in; empty merges cleanly. */
    conflicts: [] as string[],
    landed: [] as Array<{ worktreePath: string; paths: string[] | null; message: string }>,
    merges: [] as string[],
    removed: [] as string[],
    provisioned: [] as Array<{ worktreePath: string; base: string }>,
    provisionFails: null as string | null,
    /** Runs as publication starts its final step, as an owner commit landing then would. */
    beforePublish: () => {},
    /** When set, merges wait for it: a publication still merging. */
    mergeGate: null as Promise<void> | null,
    /** When set, reading a lane's unlanded paths waits for it: a publication still inspecting the lane. */
    inspectGate: null as Promise<void> | null,
    /** Worktrees holding a merge in progress. */
    midMerge: new Set<string>(),
    /** How many more times the session's Git lock reads as taken. */
    lockBusy: 0,
    /** The branch a worktree has checked out, when not the one publication expects. */
    checkedOut: new Map<string, string>(),
    /** What publication's final step reports instead of publishing, when set. */
    publishOutcome: null as Awaited<ReturnType<LaneGit["publish"]>> | null,
    /** What a recovery finds in the session worktree. */
    refresh: "complete" as "complete" | "refreshed" | "diverged",
    resynced: [] as Array<{ worktreePath: string; paths: string[] | null }>,
    /** Session worktrees a recovery finished a publication in. */
    completed: [] as string[],
  };
  const commit = (branch: string, message: string): string => {
    commits += 1;
    const sha = `c${commits}`;
    heads.set(branch, sha);
    messages.set(sha, message);
    return sha;
  };
  const git: LaneGit = {
    async head(_project, branch) {
      const head = heads.get(branch);
      if (head === undefined) throw new Error(`No branch ${branch}`);
      return head;
    },
    async provision(input) {
      if (state.provisionFails !== null) throw new Error(state.provisionFails);
      state.provisioned.push({ worktreePath: input.worktreePath, base: input.base });
      heads.set(input.branch, input.base);
      branchOf.set(input.worktreePath, input.branch);
      return { baseline: input.base };
    },
    async land({ worktreePath, paths, message }) {
      state.landed.push({ worktreePath, paths, message });
      const branch = branchOf.get(worktreePath) ?? "";
      if ((dirt.get(worktreePath) ?? []).length === 0)
        return { kind: "unchanged", head: heads.get(branch) ?? "" };
      dirt.set(worktreePath, []);
      return { kind: "committed", commit: commit(branch, message) };
    },
    async findMarked({ branch, marker }) {
      for (const [sha, message] of messages)
        if (message.includes(marker) && heads.get(branch) === sha) return sha;
      return null;
    },
    async abortMerge(worktreePath) {
      state.midMerge.delete(worktreePath);
    },
    async abortUnresolvedMerge(worktreePath) {
      if (!state.midMerge.has(worktreePath)) return "none";
      state.midMerge.delete(worktreePath);
      return "aborted";
    },
    async mergeInProgress(worktreePath) {
      return state.midMerge.has(worktreePath);
    },
    async mergeInto({ worktreePath, commit: incoming }) {
      if (state.mergeGate !== null) await state.mergeGate;
      state.merges.push(incoming);
      if (state.conflicts.length > 0) return { kind: "conflicts", files: state.conflicts };
      commit(branchOf.get(worktreePath) ?? "", `Merge ${incoming}`);
      return { kind: "merged" };
    },
    async dirtyPaths(worktreePath) {
      return dirt.get(worktreePath) ?? [];
    },
    async unlandedPaths(worktreePath) {
      if (state.inspectGate !== null) await state.inspectGate;
      return dirt.get(worktreePath) ?? [];
    },
    async resyncIndex(input) {
      state.resynced.push(input);
    },
    trySessionLock() {
      if (state.lockBusy > 0) {
        state.lockBusy -= 1;
        return null;
      }
      return () => {};
    },
    async publish({ targetBranch, targetWorktreePath, expectedHead, message }) {
      state.beforePublish();
      if (state.publishOutcome !== null) return state.publishOutcome;
      const other = state.checkedOut.get(targetWorktreePath);
      if (other !== undefined) return { kind: "blocked", detail: `The session worktree has branch ${other} checked out` };
      const head = heads.get(targetBranch) ?? "";
      if (head !== expectedHead) return { kind: "stale", head };
      const dirty = dirt.get(targetWorktreePath) ?? [];
      if (dirty.length > 0)
        return { kind: "blocked", detail: `The session worktree has changes publication would overwrite or leave behind: ${dirty.join(", ")}` };
      return { kind: "published", commit: commit(targetBranch, message) };
    },
    async completePublication({ targetWorktreePath }) {
      state.completed.push(targetWorktreePath);
      return state.refresh;
    },
    async remove({ worktreePath }) {
      if ((dirt.get(worktreePath) ?? []).length > 0) return { kind: "kept", detail: `${worktreePath} holds changes` };
      state.removed.push(worktreePath);
      return { kind: "removed" };
    },
  };
  return {
    git,
    state,
    /** Registers an existing lane worktree on its branch, as provisioning would. */
    adopt(worktreePath: string, branch: string): void {
      branchOf.set(worktreePath, branch);
    },
  };
}
