import path from "node:path";
import type { GitClient } from "@/lib/git/client";
import { inspectInProgressMerge } from "@/lib/git/conflict-markers";
import { createOwnedLandingOperations } from "@/lib/git/owned-landing";
import { createWorktreeOperations } from "@/lib/git/worktree";
import type { FrozenLaneProvisioner, ParallelWorktrees } from "@/lib/workflow-graph/parallel-worktrees";

/**
 * The Git effects of isolated lanes, behind one port so the Workspace executor
 * decides grants, order and outcomes while this module owns commands. Every
 * effect that moves a branch carries a marker in its commit message, so a
 * restart finds it by the operation that made it rather than by a matching
 * tree.
 */
export interface LaneGit {
  /** The commit a branch points at. */
  head(projectPath: string, branch: string): Promise<string>;
  /**
   * Creates the lane worktree on a new branch starting at `base` and runs its
   * setup. A worktree whose setup finished before is adopted as it is; one
   * whose setup never finished is refused, never removed. Returns the commit
   * the lane starts from.
   */
  provision(input: {
    projectPath: string;
    sessionName: string;
    sessionWorktreePath: string;
    laneId: string;
    worktreePath: string;
    branch: string;
    base: string;
  }): Promise<{ baseline: string }>;
  /**
   * Commits the working-tree content of `paths` (every path when null) onto
   * the worktree's checked-out branch, leaving other paths alone.
   */
  land(input: {
    worktreePath: string;
    paths: string[] | null;
    message: string;
  }): Promise<
    { kind: "committed"; commit: string } | { kind: "unchanged"; head: string }
  >;
  /** The commit reachable from `branch` whose message carries `marker`, if any. */
  findMarked(input: {
    projectPath: string;
    branch: string;
    marker: string;
  }): Promise<string | null>;
  /**
   * Undoes a merge in progress only while its conflicts are unresolved; a
   * resolved merge, and one whose state cannot be read, are somebody's work
   * and are kept.
   */
  abortUnresolvedMerge(worktreePath: string): Promise<"aborted" | "kept" | "none">;
  /** Whether a merge is in progress in the worktree. */
  mergeInProgress(worktreePath: string): Promise<boolean>;
  /**
   * Merges `commit` into the worktree's branch; on conflicts the merge is
   * aborted and the conflicting files are named.
   */
  mergeInto(input: {
    worktreePath: string;
    commit: string;
    message: string;
  }): Promise<{ kind: "merged" } | { kind: "conflicts"; files: string[] }>;
  /** Tracked changes, staged or not, and non-ignored untracked files in a worktree. */
  dirtyPaths(worktreePath: string): Promise<string[]>;
  /**
   * Changes in a worktree's files against its HEAD, and non-ignored untracked
   * files, without reading its index: a landing interrupted before resyncing
   * the index leaves entries that differ from HEAD while the files do not.
   */
  unlandedPaths(worktreePath: string): Promise<string[]>;
  /** Resets index entries of `paths` (every path when null) to HEAD, leaving files alone. */
  resyncIndex(input: { worktreePath: string; paths: string[] | null }): Promise<void>;
  /** The session's Git lock CC's own commit and merge jobs take, if it is free now. */
  trySessionLock(projectPath: string, sessionName: string): (() => void) | null;
  /**
   * Publishes the lane branch's tree onto `targetBranch` as one commit whose
   * parent is `expectedHead`, and refreshes the target worktree. Run holding
   * the target worktree and the session's Git lock: it refuses unless that
   * worktree still checks out `targetBranch` at `expectedHead`, holds no merge
   * and no changes, and the lane contains `expectedHead`.
   */
  publish(input: {
    projectPath: string;
    sessionName: string;
    laneBranch: string;
    targetBranch: string;
    targetWorktreePath: string;
    expectedHead: string;
    message: string;
    jobId: string;
  }): Promise<
    | { kind: "published"; commit: string }
    | { kind: "unchanged" }
    | { kind: "stale"; head: string }
    | { kind: "blocked"; detail: string }
    | { kind: "failed"; detail: string }
    /** The branch moved to `commit`, but the worktree could not be refreshed. */
    | { kind: "refresh_failed"; commit: string; detail: string }
  >;
  /**
   * After a crash between moving the target branch to `to` and refreshing its
   * worktree: `complete` when the worktree already holds `to`; `refreshed`
   * when it still held exactly `from` and was brought to `to`; `diverged`
   * when it holds anything else, which is left untouched.
   */
  completePublication(input: {
    targetWorktreePath: string;
    from: string;
    to: string;
  }): Promise<"complete" | "refreshed" | "diverged">;
  /**
   * Removes the lane worktree and its branch once they hold exactly the
   * publication `published` made of them; keeps a lane holding anything more.
   */
  remove(input: {
    projectPath: string;
    worktreePath: string;
    branch: string;
    published: string;
  }): Promise<{ kind: "removed" } | { kind: "kept"; detail: string }>;
}

/** The trailer naming the Workspace operation that made a commit. */
export function landingMarker(cause: string): string {
  return `CC-Landing: ${cause}`;
}

export function publicationMarker(cause: string): string {
  return `CC-Publication: ${cause}`;
}

export interface LaneGitDeps {
  git: GitClient;
  exists(filePath: string): boolean;
  writeFile(filePath: string, content: string): Promise<void>;
  worktrees: FrozenLaneProvisioner & Pick<ParallelWorktrees, "disposeLane">;
  /** The single-flight lock CC's own commit and merge jobs take on a session. */
  acquireSessionLock(projectPath: string, sessionName: string): () => void;
  isSessionBusy(projectPath: string, sessionName: string): boolean;
}

const MAX_BUFFER = 64 * 1024 * 1024;

/** Written into a lane's Git directory once its setup finished, so a retry can tell a ready lane from a half-made one. */
const LANE_READY = "cc-lane-ready";

/** Tracked changes and untracked files that are not ignored, from `git status --porcelain -z`. */
export function parseStatusPaths(output: string): string[] {
  const entries = output.split("\0");
  const paths: string[] = [];
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index];
    if (entry === undefined || entry.length < 4) continue;
    paths.push(entry.slice(3));
    // A rename or copy is followed by its original path.
    if (entry[0] === "R" || entry[0] === "C") index++;
  }
  return paths;
}

export function createLaneGit(deps: LaneGitDeps): LaneGit {
  const git = async (cwd: string, args: string[]): Promise<string> =>
    (await deps.git.git(args, cwd, { maxBuffer: MAX_BUFFER })).stdout;
  const operations = createWorktreeOperations(deps.git);
  const landing = createOwnedLandingOperations(deps.git);

  async function dirtyPaths(worktreePath: string): Promise<string[]> {
    return parseStatusPaths(
      await git(worktreePath, ["status", "--porcelain", "-z", "--untracked-files=all"]),
    );
  }

  /** Working files that differ from HEAD, untracked ones not ignored included, judged without the shared index. */
  const unlandedPaths = (worktreePath: string): Promise<string[]> =>
    landing.worktreeChangesFromHead(worktreePath);

  /**
   * Files on disk at paths Git starts tracking between `from` and `to`, which
   * moving the worktree would overwrite. Status never shows them when ignored.
   */
  async function replacedUntracked(worktreePath: string, from: string, to: string): Promise<string[]> {
    const added = await git(worktreePath, ["diff", "--name-only", "-z", "--no-renames", "--diff-filter=A", from, to]);
    return added
      .split("\0")
      .filter((file) => file.length > 0 && deps.exists(path.join(worktreePath, file)))
      .sort();
  }

  async function mergeInProgress(worktreePath: string): Promise<boolean> {
    try {
      await git(worktreePath, ["rev-parse", "-q", "--verify", "MERGE_HEAD"]);
      return true;
    } catch {
      return false;
    }
  }

  return {
    async head(projectPath, branch) {
      return (await git(projectPath, ["rev-parse", "--verify", `refs/heads/${branch}^{commit}`])).trim();
    },

    async provision(input) {
      const readyMarker = async () =>
        path.resolve(
          input.worktreePath,
          (await git(input.worktreePath, ["rev-parse", "--git-path", LANE_READY])).trim(),
        );
      if (deps.exists(input.worktreePath) && !deps.exists(await readyMarker()))
        throw new Error(
          `The lane worktree ${input.worktreePath} exists, but its setup never finished. Remove it and its branch (git worktree remove --force ${input.worktreePath} && git branch -D ${input.branch}), then ask for a new attempt.`,
        );
      // Where the run named it at launch, whatever names new lanes now.
      await deps.worktrees.provisionLaneAt(
        {
          projectPath: input.projectPath,
          sessionName: input.sessionName,
          sessionDir: path.basename(input.sessionWorktreePath),
          sessionBranch: input.base,
          laneId: input.laneId,
        },
        { worktreePath: input.worktreePath, branchName: input.branch },
      );
      await deps.writeFile(await readyMarker(), "ready\n");
      return { baseline: (await git(input.worktreePath, ["rev-parse", "HEAD"])).trim() };
    },

    async land({ worktreePath, paths, message }) {
      const headOf = async () => (await git(worktreePath, ["rev-parse", "HEAD"])).trim();
      if (paths !== null) {
        // Other members may have work in progress elsewhere in the lane: a private index stages only the scope.
        const result = await landing.commitOwnedPaths({ worktreePath, message, ownedPaths: paths });
        return result.status === "committed"
          ? { kind: "committed", commit: result.hash }
          : { kind: "unchanged", head: await headOf() };
      }
      // A full scope owns the whole lane, and nothing else uses it while it lands.
      await git(worktreePath, ["add", "-A"]);
      const staged = (await git(worktreePath, ["diff", "--cached", "--name-only"])).trim();
      if (staged.length === 0) return { kind: "unchanged", head: await headOf() };
      await git(worktreePath, ["commit", "--no-verify", "-m", message]);
      return { kind: "committed", commit: await headOf() };
    },

    async findMarked({ projectPath, branch, marker }) {
      const found = (
        await git(projectPath, [
          "log",
          `refs/heads/${branch}`,
          "--fixed-strings",
          `--grep=${marker}`,
          "--format=%H",
          "-n",
          "1",
        ])
      ).trim();
      return found.length > 0 ? found : null;
    },

    mergeInProgress,

    async abortUnresolvedMerge(worktreePath) {
      try {
        const merge = await inspectInProgressMerge(worktreePath, deps.git);
        if (merge.kind === "none") return "none";
        if (merge.kind === "resolved") return "kept";
      } catch {
        return "kept";
      }
      await git(worktreePath, ["merge", "--abort"]);
      return "aborted";
    },

    async mergeInto({ worktreePath, commit, message }) {
      try {
        await git(worktreePath, ["merge", "--no-ff", "--no-verify", "-m", message, commit]);
        return { kind: "merged" };
      } catch (error) {
        const files = (
          await git(worktreePath, ["diff", "--name-only", "--diff-filter=U"])
        )
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line.length > 0);
        try {
          await git(worktreePath, ["rev-parse", "-q", "--verify", "MERGE_HEAD"]);
          await git(worktreePath, ["merge", "--abort"]);
        } catch {
          // No merge in progress: the merge refused before starting.
        }
        if (files.length === 0) throw error;
        return { kind: "conflicts", files };
      }
    },

    dirtyPaths,

    unlandedPaths,

    async resyncIndex({ worktreePath, paths }) {
      await git(worktreePath, ["--literal-pathspecs", "reset", "-q", "HEAD", "--", ...(paths ?? ["."])]);
    },

    trySessionLock(projectPath, sessionName) {
      // Asked first: a refused acquisition is logged, and publication retries while a job runs.
      if (deps.isSessionBusy(projectPath, sessionName)) return null;
      try {
        return deps.acquireSessionLock(projectPath, sessionName);
      } catch {
        return null;
      }
    },

    async publish(input) {
      const checkedOut = (
        await git(input.targetWorktreePath, ["symbolic-ref", "-q", "HEAD"]).catch(() => "")
      ).trim();
      if (checkedOut !== `refs/heads/${input.targetBranch}`)
        return {
          kind: "blocked",
          detail: `The session worktree has ${checkedOut === "" ? "a detached HEAD" : checkedOut.replace(/^refs\/heads\//, "branch ")} checked out, not branch ${input.targetBranch}. Check out ${input.targetBranch} again, then ask for a new attempt.`,
        };
      const head = (
        await git(input.projectPath, ["rev-parse", "--verify", `refs/heads/${input.targetBranch}^{commit}`])
      ).trim();
      if (head !== input.expectedHead) return { kind: "stale", head };
      if (await mergeInProgress(input.targetWorktreePath))
        return {
          kind: "blocked",
          detail: `The session worktree has a merge in progress. Finish or abort it, then ask for a new attempt.`,
        };
      const dirty = await dirtyPaths(input.targetWorktreePath);
      if (dirty.length > 0)
        return {
          kind: "blocked",
          detail: `The session worktree has changes publication would overwrite or leave behind: ${dirty.join(", ")}. Commit or remove them, then ask for a new attempt.`,
        };
      const laneHead = (
        await git(input.projectPath, ["rev-parse", "--verify", `refs/heads/${input.laneBranch}^{commit}`])
      ).trim();
      try {
        await git(input.projectPath, ["merge-base", "--is-ancestor", input.expectedHead, laneHead]);
      } catch {
        return {
          kind: "failed",
          detail: `The lane does not contain the session head ${input.expectedHead} its checks ran against; it would publish a merge nothing checked.`,
        };
      }
      const replaced = await replacedUntracked(input.targetWorktreePath, input.expectedHead, laneHead);
      if (replaced.length > 0)
        return {
          kind: "blocked",
          detail: `The session worktree holds files the lane starts tracking, which publication would overwrite: ${replaced.join(", ")}. Move them aside, then ask for a new attempt.`,
        };
      const prepared = await operations.prepareSquashMerge({
        projectPath: input.projectPath,
        featureBranch: input.laneBranch,
        featureSha: laneHead,
        targetBranch: input.targetBranch,
        targetSha: input.expectedHead,
        message: input.message,
        jobId: input.jobId,
      });
      if (prepared.kind === "up-to-date") return { kind: "unchanged" };
      if (prepared.kind === "conflicts")
        return {
          kind: "failed",
          detail: `The lane does not apply to ${input.expectedHead}: ${prepared.conflictFiles.join(", ")}`,
        };
      const published = await operations.publishPreparedMerge({
        projectPath: input.projectPath,
        targetBranch: input.targetBranch,
        preparedSha: prepared.preparedSha,
        expectedTargetSha: prepared.expectedTargetSha,
        parkedRef: prepared.parkedRef,
        cleanTargetWorktreePath: input.targetWorktreePath,
      });
      if (published.kind === "cas-lost")
        return { kind: "stale", head: published.actualTargetSha };
      if (published.kind === "publish-failed") return { kind: "failed", detail: published.error };
      if (published.refreshWarning !== undefined)
        return { kind: "refresh_failed", commit: published.mergeHash, detail: published.refreshWarning };
      return { kind: "published", commit: published.mergeHash };
    },

    async completePublication({ targetWorktreePath, from, to }) {
      const head = (await git(targetWorktreePath, ["rev-parse", "HEAD"])).trim();
      if (head !== to) return "diverged";
      const holds = async (commit: string): Promise<boolean> => {
        try {
          await git(targetWorktreePath, ["diff", "--quiet", commit]);
          await git(targetWorktreePath, ["diff", "--quiet", "--cached", commit]);
        } catch {
          return false;
        }
        const untracked = await git(targetWorktreePath, ["ls-files", "--others", "--exclude-standard"]);
        return untracked.trim().length === 0;
      };
      if (await holds(to)) return "complete";
      if (!(await holds(from))) return "diverged";
      if ((await replacedUntracked(targetWorktreePath, from, to)).length > 0) return "diverged";
      // Exactly the old tree: the refresh the publication owed and never made.
      await git(targetWorktreePath, ["reset", "-q", "--hard", to]);
      return "refreshed";
    },

    async remove({ projectPath, worktreePath, branch, published }) {
      const unlanded = await unlandedPaths(worktreePath);
      if (unlanded.length > 0)
        return { kind: "kept", detail: `${worktreePath} holds changes: ${unlanded.join(", ")}` };
      // A publication squashes the lane onto a head it contains, so its tree is the lane's.
      const tree = async (revision: string) => (await git(worktreePath, ["rev-parse", `${revision}^{tree}`])).trim();
      const expected = await tree(published);
      for (const revision of ["HEAD", `refs/heads/${branch}`])
        if ((await tree(revision)) !== expected)
          return { kind: "kept", detail: `${revision} in ${worktreePath} holds work beyond the publication ${published}` };
      const result = await deps.worktrees.disposeLane({ projectPath, worktreePath, branchName: branch });
      if (result.status === "failed") throw new Error(result.reason);
      return { kind: "removed" };
    },
  };
}
