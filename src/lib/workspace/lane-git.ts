import path from "node:path";
import type { GitClient } from "@/lib/git/client";
import { inspectInProgressMerge } from "@/lib/git/conflict-markers";
import { createOwnedLandingOperations } from "@/lib/git/owned-landing";
import { createWorktreeOperations } from "@/lib/git/worktree";
import type {
  FrozenLaneProvisioner,
  ParallelWorktrees,
} from "./parallel-worktrees";

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
  abortUnresolvedMerge(
    worktreePath: string,
  ): Promise<"aborted" | "kept" | "none">;
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
  /**
   * Changes in a worktree's files against its HEAD, and non-ignored untracked
   * files, without reading its index: a landing interrupted before resyncing
   * the index leaves entries that differ from HEAD while the files do not.
   */
  unlandedPaths(worktreePath: string): Promise<string[]>;
  /** Resets index entries of `paths` (every path when null) to HEAD, leaving files alone. */
  resyncIndex(input: {
    worktreePath: string;
    paths: string[] | null;
  }): Promise<void>;
  /**
   * The session's Git lock CC's own commit, merge, rebase and conflict jobs
   * take: held now, or busy, naming the job that holds it when one can be named.
   */
  trySessionLock(projectPath: string, sessionName: string): SessionLockAttempt;
  /**
   * Publishes the lane branch's tree onto `targetBranch` as one commit whose
   * parent is `expectedHead`, fast-forwarding the target worktree to it with
   * Git's own checks, which keep every uncommitted change the lane does not
   * touch. Run holding the target worktree and the session's Git lock: it
   * refuses unless that worktree still checks out `targetBranch` at
   * `expectedHead` with no merge in progress, and the lane contains
   * `expectedHead`. Refused without changing the branch, index or worktree
   * when uncommitted changes, untracked or ignored files are in the way of
   * the lane's files (`blocked`). `git_locked` while another Git process holds
   * the session worktree's index lock or the session branch's ref lock (or
   * left one behind); a ref lock refuses only after the merge wrote the
   * lane's files and index, which a new attempt accepts as they are.
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
    /** Another Git process holds `lock`, or left it behind: wait for it to go, then try again. */
    | { kind: "git_locked"; lock: string }
  >;
  /** Whether a lock file `publish` reported is still there. */
  lockHeld(lock: string): boolean;
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

/** A CC job holding a session's Git lock. */
export interface SessionJob {
  jobId: string;
  jobType: string;
}

export type SessionLockAttempt =
  | { kind: "held"; release(): void }
  | { kind: "busy"; job: SessionJob | null };

export interface LaneGitDeps {
  git: GitClient;
  exists(filePath: string): boolean;
  writeFile(filePath: string, content: string): Promise<void>;
  worktrees: FrozenLaneProvisioner & Pick<ParallelWorktrees, "disposeLane">;
  /** The single-flight lock CC's own commit and merge jobs take on a session. */
  acquireSessionLock(projectPath: string, sessionName: string): () => void;
  isSessionBusy(projectPath: string, sessionName: string): boolean;
  /** The CC job running in a session, which holds its Git lock while it runs; null when none is. */
  sessionJob(projectPath: string, sessionName: string): SessionJob | null;
  /**
   * The hooks directory publication's merge runs; `/dev/null` (none) unless a
   * test interleaves a commit with the merge through a hook.
   */
  mergeHooksPath?: string;
}

const MAX_BUFFER = 64 * 1024 * 1024;

/** Written into a lane's Git directory once its setup finished, so a retry can tell a ready lane from a half-made one. */
const LANE_READY = "cc-lane-ready";

/** What a failed Git command printed: its stderr, or its message when it printed nothing. */
function gitFailure(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const stderr =
    "stderr" in error && typeof error.stderr === "string" ? error.stderr : "";
  return stderr.trim() || error.message;
}

/** Git refusing a checkout because files are in the way, as `git merge` words it. */
const IN_THE_WAY =
  /would be (overwritten|removed|lost) by merge|would lose untracked files|not uptodate/;

/**
 * The lock file Git could not create because it exists. The path runs to the
 * last `': File exists` on its line, so a path holding an apostrophe is whole.
 */
const LOCK_EXISTS = /Unable to create '(.+)': File exists/;

/**
 * Git's refusal as one line: each heading with the paths listed under it,
 * without its advice (which suggests the stash every worktree shares).
 */
function describeInTheWay(stderr: string): string {
  const sections: Array<{ heading: string; paths: string[] }> = [];
  for (const line of stderr.split("\n")) {
    if (line.startsWith("\t")) {
      sections.at(-1)?.paths.push(line.trim());
      continue;
    }
    const text = line.replace(/^error: /, "").trim();
    if (text === "" || text === "Aborting" || text.startsWith("Please "))
      continue;
    sections.push({ heading: text, paths: [] });
  }
  return sections
    .map(({ heading, paths }) =>
      paths.length === 0 ? heading : `${heading} ${paths.join(", ")}`,
    )
    .join("; ");
}

export function createLaneGit(deps: LaneGitDeps): LaneGit {
  const git = async (cwd: string, args: string[]): Promise<string> =>
    (await deps.git.git(args, cwd, { maxBuffer: MAX_BUFFER })).stdout;
  const operations = createWorktreeOperations(deps.git);
  const landing = createOwnedLandingOperations(deps.git);

  /** Working files that differ from HEAD, untracked ones not ignored included, judged without the shared index. */
  const unlandedPaths = (worktreePath: string): Promise<string[]> =>
    landing.worktreeChangesFromHead(worktreePath);

  const branchHead = async (
    projectPath: string,
    branch: string,
  ): Promise<string> =>
    (
      await git(projectPath, [
        "rev-parse",
        "--verify",
        `refs/heads/${branch}^{commit}`,
      ])
    ).trim();

  /**
   * The locks whose holder a publication waits out: the target worktree's
   * index lock and its branch's ref lock (which lives in the common Git
   * directory). Any other lock Git cannot take fails the publication.
   */
  async function sessionLocks(
    worktreePath: string,
    branch: string,
  ): Promise<string[]> {
    const gitPath = async (name: string) =>
      path.resolve(
        worktreePath,
        (await git(worktreePath, ["rev-parse", "--git-path", name])).trim(),
      );
    return [
      await gitPath("index.lock"),
      await gitPath(`refs/heads/${branch}.lock`),
    ];
  }

  /**
   * Fast-forwards the target worktree's branch to the prepared commit, and
   * classifies the result by where the branch ends up, not by Git's exit
   * status. Hooks are off; the explicit options override repository and
   * branch merge settings (`mergeOptions=--squash` would otherwise exit 0
   * without moving the branch); `--no-autostash` keeps Git off the stash
   * every worktree shares; `--no-overwrite-ignore` refuses ignored files in
   * the way. Git writes the index and files before it moves the branch with
   * the old head as the expected value, so a commit landing in between
   * fails the move rather than reverting the lane.
   */
  async function fastForward(input: {
    projectPath: string;
    targetBranch: string;
    targetWorktreePath: string;
    expectedHead: string;
    prepared: string;
  }): Promise<
    | { kind: "published"; commit: string }
    | { kind: "stale"; head: string }
    | { kind: "blocked"; detail: string }
    | { kind: "failed"; detail: string }
    | { kind: "git_locked"; lock: string }
  > {
    let failure: string | null = null;
    try {
      await git(input.targetWorktreePath, [
        "-c",
        `core.hooksPath=${deps.mergeHooksPath ?? "/dev/null"}`,
        "merge",
        "-q",
        "--ff-only",
        "--no-squash",
        "--no-overwrite-ignore",
        "--no-autostash",
        "--no-verify-signatures",
        input.prepared,
      ]);
    } catch (error) {
      failure = gitFailure(error);
    }
    const head = await branchHead(input.projectPath, input.targetBranch);
    if (head === input.prepared)
      return { kind: "published", commit: input.prepared };
    if (failure === null)
      return {
        kind: "failed",
        detail: `Git reported the merge of the publication ${input.prepared} done, but branch ${input.targetBranch} is at ${head}. Check the session's Git configuration and hooks, then ask for a new attempt.`,
      };
    // The branch moved under the merge: a new attempt integrates the new head.
    if (head !== input.expectedHead) return { kind: "stale", head };
    const lock = LOCK_EXISTS.exec(failure)?.[1];
    if (
      lock !== undefined &&
      (
        await sessionLocks(input.targetWorktreePath, input.targetBranch)
      ).includes(lock)
    )
      return { kind: "git_locked", lock };
    if (IN_THE_WAY.test(failure))
      return {
        kind: "blocked",
        detail: `Uncommitted work in the session worktree is in the way of the lane's files, so nothing was published or changed. ${describeInTheWay(failure)}. Commit, move or remove it, then ask for a new attempt.`,
      };
    return {
      kind: "failed",
      detail: `Publishing into the session worktree failed: ${failure}`,
    };
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
      return (
        await git(projectPath, [
          "rev-parse",
          "--verify",
          `refs/heads/${branch}^{commit}`,
        ])
      ).trim();
    },

    async provision(input) {
      const readyMarker = async () =>
        path.resolve(
          input.worktreePath,
          (
            await git(input.worktreePath, [
              "rev-parse",
              "--git-path",
              LANE_READY,
            ])
          ).trim(),
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
      return {
        baseline: (await git(input.worktreePath, ["rev-parse", "HEAD"])).trim(),
      };
    },

    async land({ worktreePath, paths, message }) {
      const headOf = async () =>
        (await git(worktreePath, ["rev-parse", "HEAD"])).trim();
      if (paths !== null) {
        // Other members may have work in progress elsewhere in the lane: a private index stages only the scope.
        const result = await landing.commitOwnedPaths({
          worktreePath,
          message,
          ownedPaths: paths,
        });
        return result.status === "committed"
          ? { kind: "committed", commit: result.hash }
          : { kind: "unchanged", head: await headOf() };
      }
      // A full scope owns the whole lane, and nothing else uses it while it lands.
      await git(worktreePath, ["add", "-A"]);
      const staged = (
        await git(worktreePath, ["diff", "--cached", "--name-only"])
      ).trim();
      if (staged.length === 0)
        return { kind: "unchanged", head: await headOf() };
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
        await git(worktreePath, [
          "merge",
          "--no-ff",
          "--no-verify",
          "-m",
          message,
          commit,
        ]);
        return { kind: "merged" };
      } catch (error) {
        const files = (
          await git(worktreePath, ["diff", "--name-only", "--diff-filter=U"])
        )
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line.length > 0);
        try {
          await git(worktreePath, [
            "rev-parse",
            "-q",
            "--verify",
            "MERGE_HEAD",
          ]);
          await git(worktreePath, ["merge", "--abort"]);
        } catch {
          // No merge in progress: the merge refused before starting.
        }
        if (files.length === 0) throw error;
        return { kind: "conflicts", files };
      }
    },

    unlandedPaths,

    lockHeld: (lock) => deps.exists(lock),

    async resyncIndex({ worktreePath, paths }) {
      await git(worktreePath, [
        "--literal-pathspecs",
        "reset",
        "-q",
        "HEAD",
        "--",
        ...(paths ?? ["."]),
      ]);
    },

    trySessionLock(projectPath, sessionName) {
      const busy = (): SessionLockAttempt => ({
        kind: "busy",
        job: deps.sessionJob(projectPath, sessionName),
      });
      // Asked first: a refused acquisition is logged, and publication retries while a job runs.
      if (deps.isSessionBusy(projectPath, sessionName)) return busy();
      try {
        return {
          kind: "held",
          release: deps.acquireSessionLock(projectPath, sessionName),
        };
      } catch {
        return busy();
      }
    },

    async publish(input) {
      const checkedOut = (
        await git(input.targetWorktreePath, [
          "symbolic-ref",
          "-q",
          "HEAD",
        ]).catch(() => "")
      ).trim();
      if (checkedOut !== `refs/heads/${input.targetBranch}`)
        return {
          kind: "blocked",
          detail: `The session worktree has ${checkedOut === "" ? "a detached HEAD" : checkedOut.replace(/^refs\/heads\//, "branch ")} checked out, not branch ${input.targetBranch}. Check out ${input.targetBranch} again, then ask for a new attempt.`,
        };
      const head = await branchHead(input.projectPath, input.targetBranch);
      if (head !== input.expectedHead) return { kind: "stale", head };
      if (await mergeInProgress(input.targetWorktreePath))
        return {
          kind: "blocked",
          detail: `The session worktree has a merge in progress. Finish or abort it, then ask for a new attempt.`,
        };
      const laneHead = await branchHead(input.projectPath, input.laneBranch);
      try {
        await git(input.projectPath, [
          "merge-base",
          "--is-ancestor",
          input.expectedHead,
          laneHead,
        ]);
      } catch {
        return {
          kind: "failed",
          detail: `The lane does not contain the session head ${input.expectedHead} its checks ran against; it would publish a merge nothing checked.`,
        };
      }
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
      try {
        return await fastForward({
          projectPath: input.projectPath,
          targetBranch: input.targetBranch,
          targetWorktreePath: input.targetWorktreePath,
          expectedHead: input.expectedHead,
          prepared: prepared.preparedSha,
        });
      } finally {
        // Each attempt prepares its own commit; a published one is on the branch.
        await operations
          .deleteParkedMergeRef(input.projectPath, prepared.parkedRef)
          .catch(() => false);
      }
    },

    async remove({ projectPath, worktreePath, branch, published }) {
      const unlanded = await unlandedPaths(worktreePath);
      if (unlanded.length > 0)
        return {
          kind: "kept",
          detail: `${worktreePath} holds changes: ${unlanded.join(", ")}`,
        };
      // A publication squashes the lane onto a head it contains, so its tree is the lane's.
      const tree = async (revision: string) =>
        (await git(worktreePath, ["rev-parse", `${revision}^{tree}`])).trim();
      const expected = await tree(published);
      for (const revision of ["HEAD", `refs/heads/${branch}`])
        if ((await tree(revision)) !== expected)
          return {
            kind: "kept",
            detail: `${revision} in ${worktreePath} holds work beyond the publication ${published}`,
          };
      const result = await deps.worktrees.disposeLane({
        projectPath,
        worktreePath,
        branchName: branch,
      });
      if (result.status === "failed") throw new Error(result.reason);
      return { kind: "removed" };
    },
  };
}
