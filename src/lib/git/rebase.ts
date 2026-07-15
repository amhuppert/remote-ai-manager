/**
 * Git rebase primitives for replaying a session branch onto another branch.
 *
 * A deep module hiding the parts of `git rebase` that make it awkward to drive
 * programmatically behind a handful of intention-revealing verbs:
 *
 *  - The editor is disabled (`-c core.editor=true`) so a replayed commit never
 *    blocks waiting for interactive input.
 *  - A rebase conflicts *once per replayed commit*, so the orchestrator resolves
 *    and calls {@link continueRebase} repeatedly. When conflict resolution makes
 *    a commit empty (its changes already exist in the new base), git refuses to
 *    continue and asks for `--skip`; this module performs that skip internally so
 *    callers only ever see `completed` or the next `conflicts`.
 *  - Remote targets are fetched and pinned to a concrete sha so a concurrent
 *    fetch cannot move the target out from under an in-flight rebase.
 *
 * Unlike the smart-merge machinery, nothing here touches the target branch — a
 * rebase only rewrites the session branch's own history.
 */

import { defaultGitClient, type GitClient } from "./client";
import { parseDirtyPaths } from "./worktree";

const MAX_BUFFER = 10 * 1024 * 1024;

/** Result of a single rebase step (start, continue, or an internal skip). */
export type RebaseStepResult =
  | { status: "completed" }
  | { status: "conflicts"; conflictFiles: string[] };

/** Where to replay the session branch's commits onto. */
export type RebaseOnto =
  | { kind: "local"; branch: string }
  | { kind: "remote"; remote: string; branch: string };

/** The resolved rebase target: a concrete ref to hand `git rebase`, plus a
 *  human label (`main` / `origin/main`) for notices and logs. */
export interface ResolvedRebaseOnto {
  ref: string;
  label: string;
}

/** Flatten an exec-style error's streams so we can classify git's outcome. */
function errText(err: unknown): string {
  if (err instanceof Error) {
    const e = err as Error & { stderr?: string; stdout?: string };
    return `${e.stderr ?? ""}\n${e.stdout ?? ""}\n${e.message}`;
  }
  return String(err);
}

function isConflict(text: string): boolean {
  return (
    text.includes("CONFLICT") ||
    text.includes("could not apply") ||
    text.includes("Merge conflict")
  );
}

/**
 * A replayed commit became empty (typically because conflict resolution kept
 * the base side, so the patch is already present). Git stops and suggests
 * `--skip`; we detect that so the loop can drop the commit and advance.
 */
function isEmptyPatch(text: string): boolean {
  return (
    /nothing to commit/i.test(text) ||
    /forget to use ['"]?git add/i.test(text) ||
    /git rebase --skip/i.test(text) ||
    /patch (?:is|failed).*empty/i.test(text) ||
    /is now empty/i.test(text)
  );
}

export function createRebaseOperations(client: GitClient = defaultGitClient) {
  function git(
    cwd: string,
    args: string[],
  ): Promise<{ stdout: string; stderr: string }> {
    return client.git(args, cwd, { maxBuffer: MAX_BUFFER });
  }

  /** List files with unresolved conflicts (unmerged index entries). */
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

  /**
   * Whether the worktree has changes to *tracked* files. Untracked files do not
   * block a rebase (git preserves them), so they do not count — this mirrors
   * git's own precondition rather than the broader "any dirty" check.
   */
  async function worktreeHasTrackedChanges(
    worktreePath: string,
  ): Promise<boolean> {
    const { stdout } = await git(worktreePath, ["status", "--porcelain"]);
    return parseDirtyPaths(stdout).some((p) => p.tracked);
  }

  /**
   * Resolve the rebase target to a concrete ref. Remote targets are fetched and
   * pinned to the fetched sha (stable for the duration of the rebase); local
   * targets are verified to exist and rebased onto by name (readable in the
   * reflog). Throws a caller-facing error when a local branch is missing.
   */
  async function resolveRebaseOnto(
    worktreePath: string,
    onto: RebaseOnto,
  ): Promise<ResolvedRebaseOnto> {
    if (onto.kind === "remote") {
      await git(worktreePath, ["fetch", onto.remote, onto.branch]);
      const { stdout } = await git(worktreePath, ["rev-parse", "FETCH_HEAD"]);
      const ref = stdout.trim();
      if (!ref) {
        throw new Error(
          `Fetched ${onto.remote} ${onto.branch} but FETCH_HEAD resolved to nothing`,
        );
      }
      return { ref, label: `${onto.remote}/${onto.branch}` };
    }

    try {
      await git(worktreePath, [
        "rev-parse",
        "--verify",
        "--quiet",
        `refs/heads/${onto.branch}`,
      ]);
    } catch {
      throw new Error(
        `Cannot rebase: local branch '${onto.branch}' does not exist`,
      );
    }
    return { ref: onto.branch, label: onto.branch };
  }

  /**
   * Run one rebase step with the editor disabled and classify the outcome.
   * Recurses through `--skip` when the current commit became empty, so the
   * caller only observes `completed` or the next `conflicts`.
   */
  async function runStep(
    worktreePath: string,
    stepArgs: string[],
  ): Promise<RebaseStepResult> {
    try {
      await git(worktreePath, ["-c", "core.editor=true", ...stepArgs]);
      return { status: "completed" };
    } catch (err) {
      const text = errText(err);
      if (isEmptyPatch(text)) {
        return runStep(worktreePath, ["rebase", "--skip"]);
      }
      if (isConflict(text)) {
        return {
          status: "conflicts",
          conflictFiles: await listUnmergedFiles(worktreePath),
        };
      }
      throw err;
    }
  }

  /** Begin replaying the session branch's commits onto `ontoRef`. */
  function startRebase(
    worktreePath: string,
    ontoRef: string,
  ): Promise<RebaseStepResult> {
    return runStep(worktreePath, ["rebase", ontoRef]);
  }

  /** Advance the rebase after the current commit's conflicts were resolved. */
  function continueRebase(worktreePath: string): Promise<RebaseStepResult> {
    return runStep(worktreePath, ["rebase", "--continue"]);
  }

  /** Abort the in-progress rebase, restoring the branch to its pre-rebase tip. */
  async function abortRebase(worktreePath: string): Promise<void> {
    await git(worktreePath, ["rebase", "--abort"]);
  }

  return {
    resolveRebaseOnto,
    startRebase,
    continueRebase,
    abortRebase,
    worktreeHasTrackedChanges,
    listUnmergedFiles,
  };
}

// ============================================================
// Default singleton exports
// ============================================================

const defaultOps = createRebaseOperations();

export const resolveRebaseOnto = defaultOps.resolveRebaseOnto;
export const startRebase = defaultOps.startRebase;
export const continueRebase = defaultOps.continueRebase;
export const abortRebase = defaultOps.abortRebase;
export const worktreeHasTrackedChanges = defaultOps.worktreeHasTrackedChanges;
