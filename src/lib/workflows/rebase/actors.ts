/**
 * Actor logic (fromPromise) for the Rebase workflow.
 *
 * Each actor wraps a canonical function via a lazy dynamic import and provides
 * typed input/output for the XState machine to invoke. The conflict resolver is
 * the same one Smart Merge uses (`@/lib/sessions/conflict-resolution`): it reads
 * markers straight from the worktree and never runs git itself, so it is
 * identical whether a merge or a rebase produced the conflict.
 */

import { fromPromise } from "xstate";
import type { RebaseOnto, RebaseStepResult } from "@/lib/git/rebase";
import type { ConflictEntry } from "@/lib/jobs/schemas";
import { resolveSessionConversationId } from "../validation-fix/actors";

// ============================================================
// Actor Input/Output Types
// ============================================================

export interface GetCurrentBranchInput {
  worktreePath: string;
}
export interface GetCurrentBranchOutput {
  branch: string | null;
}

export interface CheckTrackedChangesInput {
  worktreePath: string;
}
export interface CheckTrackedChangesOutput {
  hasChanges: boolean;
}

export interface ResolveOntoInput {
  worktreePath: string;
  onto: RebaseOnto;
}
export interface ResolveOntoOutput {
  ref: string;
  label: string;
}

export interface StartRebaseInput {
  worktreePath: string;
  ontoRef: string;
}

export interface ContinueRebaseInput {
  worktreePath: string;
}

export type RebaseStepOutput = RebaseStepResult;

export interface ResolveConflictsInput {
  worktreePath: string;
  projectPath: string;
  sessionName: string;
  conversationId?: string;
  conflictFiles?: string[];
}
export interface ResolveConflictsOutput {
  status: "resolved" | "failed";
  conflicts: ConflictEntry[];
  partialConflicts?: ConflictEntry[];
}

export interface AbortRebaseInput {
  worktreePath: string;
}
export type AbortRebaseOutput = void;

// ============================================================
// Actor Definitions
// ============================================================

/** Read the worktree's currently checked-out branch (null = detached HEAD). */
export const getCurrentBranchActor = fromPromise<
  GetCurrentBranchOutput,
  GetCurrentBranchInput
>(async ({ input }) => {
  const { getCurrentBranch } = await import("@/lib/git/commits");
  const branch = await getCurrentBranch(input.worktreePath);
  return { branch };
});

/** Whether the worktree has changes to tracked files (blocks a rebase). */
export const checkTrackedChangesActor = fromPromise<
  CheckTrackedChangesOutput,
  CheckTrackedChangesInput
>(async ({ input }) => {
  const { worktreeHasTrackedChanges } = await import("@/lib/git/rebase");
  const hasChanges = await worktreeHasTrackedChanges(input.worktreePath);
  return { hasChanges };
});

/** Resolve the rebase target (fetch a remote / verify a local branch). */
export const resolveOntoActor = fromPromise<
  ResolveOntoOutput,
  ResolveOntoInput
>(async ({ input }) => {
  const { resolveRebaseOnto } = await import("@/lib/git/rebase");
  return resolveRebaseOnto(input.worktreePath, input.onto);
});

/** Begin the rebase, replaying the session's commits onto the resolved ref. */
export const startRebaseActor = fromPromise<RebaseStepOutput, StartRebaseInput>(
  async ({ input }) => {
    const { startRebase } = await import("@/lib/git/rebase");
    return startRebase(input.worktreePath, input.ontoRef);
  },
);

/** Advance the rebase after the current commit's conflicts were resolved. */
export const continueRebaseActor = fromPromise<
  RebaseStepOutput,
  ContinueRebaseInput
>(async ({ input }) => {
  const { continueRebase } = await import("@/lib/git/rebase");
  return continueRebase(input.worktreePath);
});

/** Resolve the current commit's conflicts via the conversation actor. */
export const resolveConflictsActor = fromPromise<
  ResolveConflictsOutput,
  ResolveConflictsInput
>(async ({ input }) => {
  const { resolveConflicts } =
    await import("@/lib/sessions/conflict-resolution");
  const conversationId =
    input.conversationId ??
    (await resolveSessionConversationId(input.projectPath, input.sessionName));
  const result = await resolveConflicts({
    worktreePath: input.worktreePath,
    projectPath: input.projectPath,
    sessionName: input.sessionName,
    conversationId,
    conflictFiles: input.conflictFiles,
  });
  if (result.status === "resolved") {
    return { status: "resolved", conflicts: result.conflicts };
  }
  // The rebase machine has a single failure branch, so the resolver's
  // unresolved/infrastructure split collapses here; only the merge machine
  // routes them apart today.
  return {
    status: "failed",
    conflicts: [],
    partialConflicts:
      result.status === "unresolved" ? result.partialConflicts : undefined,
  };
});

/** Abort the in-progress rebase, restoring the branch to its pre-rebase tip. */
export const abortRebaseActor = fromPromise<
  AbortRebaseOutput,
  AbortRebaseInput
>(async ({ input }) => {
  const { abortRebase } = await import("@/lib/git/rebase");
  await abortRebase(input.worktreePath);
});
