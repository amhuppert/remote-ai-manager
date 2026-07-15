/**
 * Rebase XState v5 Machine.
 *
 * Replays a session branch onto another branch, auto-resolving conflicts one
 * replayed commit at a time:
 *
 *   verifyingBranch → checkingClean → resolvingOnto → rebasing
 *      ├─ (clean)     → completed
 *      └─ (conflicts) → resolvingConflicts → continuingRebase
 *                          ├─ (clean)         → completed
 *                          ├─ (next conflict) → resolvingConflicts   (loop, bounded)
 *                          └─ (resolve fails / rounds exhausted) → abortingRebase → failed
 *
 * A dirty worktree fails fast (rebase requires a clean tree); an unresolvable
 * conflict aborts the rebase so the branch is restored to its pre-rebase tip.
 * The target branch is never modified.
 */

import { setup, assign, fromPromise } from "xstate";
import type {
  RebaseContext,
  RebaseInput,
  RebaseEvent,
  RebaseOutput,
} from "./types";
import type {
  GetCurrentBranchInput,
  GetCurrentBranchOutput,
  CheckTrackedChangesInput,
  CheckTrackedChangesOutput,
  ResolveOntoInput,
  ResolveOntoOutput,
  StartRebaseInput,
  ContinueRebaseInput,
  RebaseStepOutput,
  ResolveConflictsInput,
  ResolveConflictsOutput,
  AbortRebaseInput,
  AbortRebaseOutput,
} from "./actors";
import {
  getCurrentBranchActor,
  checkTrackedChangesActor,
  resolveOntoActor,
  startRebaseActor,
  continueRebaseActor,
  resolveConflictsActor,
  abortRebaseActor,
} from "./actors";
import { errorAssign, extractErrorMessage } from "../utils";

const SCHEMA_VERSION = 1;

/** Exported type alias so consumers can accept the machine or `.provide()` variants. */
export type RebaseMachineType = typeof rebaseMachine;

export const rebaseMachine = setup({
  types: {
    context: {} as RebaseContext,
    events: {} as RebaseEvent,
    input: {} as RebaseInput,
    output: {} as RebaseOutput,
  },
  actors: {
    getCurrentBranch: getCurrentBranchActor as ReturnType<
      typeof fromPromise<GetCurrentBranchOutput, GetCurrentBranchInput>
    >,
    checkTrackedChanges: checkTrackedChangesActor as ReturnType<
      typeof fromPromise<CheckTrackedChangesOutput, CheckTrackedChangesInput>
    >,
    resolveOnto: resolveOntoActor as ReturnType<
      typeof fromPromise<ResolveOntoOutput, ResolveOntoInput>
    >,
    startRebase: startRebaseActor as ReturnType<
      typeof fromPromise<RebaseStepOutput, StartRebaseInput>
    >,
    continueRebase: continueRebaseActor as ReturnType<
      typeof fromPromise<RebaseStepOutput, ContinueRebaseInput>
    >,
    resolveConflicts: resolveConflictsActor as ReturnType<
      typeof fromPromise<ResolveConflictsOutput, ResolveConflictsInput>
    >,
    abortRebase: abortRebaseActor as ReturnType<
      typeof fromPromise<AbortRebaseOutput, AbortRebaseInput>
    >,
  },
  guards: {
    branchMatchesExpected: ({ context, event }) => {
      const e = event as unknown as { output: GetCurrentBranchOutput };
      return e.output.branch === context.branchName;
    },
    hasTrackedChanges: ({ event }) => {
      const e = event as unknown as { output: CheckTrackedChangesOutput };
      return e.output.hasChanges;
    },
    stepCompleted: ({ event }) => {
      const e = event as unknown as { output: RebaseStepOutput };
      return e.output.status === "completed";
    },
    resolutionSucceeded: ({ event }) => {
      const e = event as unknown as { output: ResolveConflictsOutput };
      return e.output.status === "resolved";
    },
    conflictRoundsRemaining: ({ context }) =>
      context.conflictRound < context.maxConflictRounds,
  },
}).createMachine({
  id: "rebase",
  context: ({ input }) => ({
    _schemaVersion: SCHEMA_VERSION,
    jobId: input.jobId,
    projectPath: input.projectPath,
    projectName: input.projectName,
    sessionName: input.sessionName,
    startedAt: new Date().toISOString(),
    completedAt: null,
    branchName: input.branchName,
    worktreePath: input.worktreePath,
    conversationId: input.conversationId ?? null,
    onto: input.onto,
    ontoRef: null,
    ontoLabel: null,
    conflictFiles: [],
    conflictRound: 0,
    maxConflictRounds: input.maxConflictRounds ?? 50,
    phase: null,
    error: null,
    finalStatus: null,
  }),
  initial: "verifyingBranch",
  states: {
    /** Verify the worktree is still on the expected session branch. */
    verifyingBranch: {
      entry: assign({ phase: "checking-branch" as const }),
      invoke: {
        src: "getCurrentBranch",
        input: ({ context }) => ({ worktreePath: context.worktreePath }),
        onDone: [
          { guard: "branchMatchesExpected", target: "checkingClean" },
          {
            target: "failed",
            actions: assign({
              error: ({ context, event }) => {
                const actual = event.output.branch;
                if (actual === null) {
                  return `Worktree ${context.worktreePath} is in detached HEAD state; expected branch ${context.branchName}`;
                }
                return `Worktree ${context.worktreePath} is on branch ${actual}; expected ${context.branchName}`;
              },
              completedAt: () => new Date().toISOString(),
            }),
          },
        ],
        onError: { target: "failed", actions: errorAssign() },
      },
    },

    /**
     * A rebase requires a clean working tree; reject a dirty one so the user
     * commits (or discards) first rather than losing uncommitted work.
     */
    checkingClean: {
      entry: assign({ phase: "checking-clean" as const }),
      invoke: {
        src: "checkTrackedChanges",
        input: ({ context }) => ({ worktreePath: context.worktreePath }),
        onDone: [
          {
            guard: "hasTrackedChanges",
            target: "failed",
            actions: assign({
              error:
                "Rebase blocked: the worktree has uncommitted changes. Commit (or /commit) them first, then rebase.",
              completedAt: () => new Date().toISOString(),
            }),
          },
          { target: "resolvingOnto" },
        ],
        onError: { target: "failed", actions: errorAssign() },
      },
    },

    /** Resolve the rebase target: fetch a remote, or verify a local branch. */
    resolvingOnto: {
      entry: assign({ phase: "resolving-onto" as const }),
      invoke: {
        src: "resolveOnto",
        input: ({ context }) => ({
          worktreePath: context.worktreePath,
          onto: context.onto,
        }),
        onDone: {
          target: "rebasing",
          actions: assign({
            ontoRef: ({ event }) => event.output.ref,
            ontoLabel: ({ event }) => event.output.label,
          }),
        },
        onError: { target: "failed", actions: errorAssign() },
      },
    },

    rebasing: {
      entry: assign({ phase: "rebasing" as const }),
      invoke: {
        src: "startRebase",
        input: ({ context }) => ({
          worktreePath: context.worktreePath,
          ontoRef: context.ontoRef ?? "",
        }),
        onDone: [
          { guard: "stepCompleted", target: "completed" },
          {
            target: "resolvingConflicts",
            actions: assign({
              conflictFiles: ({ event }) =>
                event.output.status === "conflicts"
                  ? event.output.conflictFiles
                  : [],
            }),
          },
        ],
        onError: { target: "failed", actions: errorAssign() },
      },
    },

    resolvingConflicts: {
      entry: assign({
        phase: "resolving-conflicts" as const,
        conflictRound: ({ context }) => context.conflictRound + 1,
      }),
      invoke: {
        src: "resolveConflicts",
        input: ({ context }) => ({
          worktreePath: context.worktreePath,
          projectPath: context.projectPath,
          sessionName: context.sessionName,
          conversationId: context.conversationId ?? undefined,
          conflictFiles: context.conflictFiles,
        }),
        onDone: [
          { guard: "resolutionSucceeded", target: "continuingRebase" },
          {
            target: "abortingRebase",
            actions: assign({
              conflictFiles: ({ event }) =>
                (event.output.partialConflicts ?? []).map((c) => c.file),
              error: ({ event }) => {
                const files = (event.output.partialConflicts ?? [])
                  .map((c) => c.file)
                  .join(", ");
                return `Automatic conflict resolution failed${
                  files ? ` on: ${files}` : ""
                }. The rebase was aborted and the branch restored.`;
              },
            }),
          },
        ],
        onError: {
          target: "abortingRebase",
          actions: assign({
            error: ({ event }) =>
              `Automatic conflict resolution errored: ${extractErrorMessage(
                event.error,
              )}. The rebase was aborted and the branch restored.`,
          }),
        },
      },
    },

    continuingRebase: {
      entry: assign({ phase: "continuing" as const }),
      invoke: {
        src: "continueRebase",
        input: ({ context }) => ({ worktreePath: context.worktreePath }),
        onDone: [
          { guard: "stepCompleted", target: "completed" },
          {
            guard: "conflictRoundsRemaining",
            target: "resolvingConflicts",
            actions: assign({
              conflictFiles: ({ event }) =>
                event.output.status === "conflicts"
                  ? event.output.conflictFiles
                  : [],
            }),
          },
          {
            target: "abortingRebase",
            actions: assign({
              error: ({ context }) =>
                `Rebase still conflicting after ${context.maxConflictRounds} resolution rounds. The rebase was aborted and the branch restored.`,
            }),
          },
        ],
        onError: {
          target: "abortingRebase",
          actions: assign({
            error: ({ event }) =>
              `Rebase could not continue: ${extractErrorMessage(
                event.error,
              )}. The rebase was aborted and the branch restored.`,
          }),
        },
      },
    },

    /**
     * Restore the branch to its pre-rebase tip. `error` is already set by the
     * transition that routed here; the abort is best-effort — even if it throws
     * we still land in `failed` with the original cause.
     */
    abortingRebase: {
      entry: assign({ phase: "aborting" as const }),
      invoke: {
        src: "abortRebase",
        input: ({ context }) => ({ worktreePath: context.worktreePath }),
        onDone: "failed",
        onError: "failed",
      },
    },

    // ============================================================
    // Terminal states
    // ============================================================

    completed: {
      type: "final",
      entry: assign({
        finalStatus: "completed" as const,
        phase: null,
        completedAt: () => new Date().toISOString(),
      }),
    },

    failed: {
      type: "final",
      entry: assign({
        finalStatus: "failed" as const,
        phase: null,
        completedAt: () => new Date().toISOString(),
      }),
    },
  },
  output: ({ context }) => ({
    status: context.finalStatus ?? ("failed" as const),
    error: context.error,
    conflictFiles: context.conflictFiles,
    ontoLabel: context.ontoLabel,
    phase: context.phase,
  }),
});
