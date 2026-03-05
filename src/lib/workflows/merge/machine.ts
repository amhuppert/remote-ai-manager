/**
 * Smart Merge XState v5 Machine.
 *
 * Models the full merge pipeline with conflict resolution and validation:
 *
 *   routing → checkingUncommitted → committingUncommitted → mergingMain
 *                                                         ↓
 *                                         (clean) → validating → squashMerging → completed
 *                                         (conflicts + autoResolve) → resolvingConflicts → committingResolution → validating
 *                                         (conflicts + !autoResolve) → conflicts (final)
 *
 *   routing → resolvingConflicts (for resolve-conflicts jobs)
 *
 *   validating → (fail + autoResolve) → fixingValidation → committingFix → revalidating → squashMerging
 *             → (fail + !autoResolve) → failed (final)
 */

import { setup, assign, fromPromise } from "xstate";
import type {
  MergeContext,
  MergeInput,
  MergeEvent,
  MergeOutput,
} from "./types";
import type {
  CheckUncommittedInput,
  CheckUncommittedOutput,
  CommitChangesInput,
  CommitChangesOutput,
  MergeMainInput,
  MergeMainOutput,
  ResolveConflictsInput,
  ResolveConflictsOutput,
  RunValidationInput,
  RunValidationOutput,
  FixValidationInput,
  FixValidationOutput,
  SquashMergeInput,
  SquashMergeOutput,
} from "./actors";
import {
  checkUncommitted,
  commitChangesActor,
  mergeMain,
  resolveConflictsActor,
  runValidation,
  fixValidation,
  squashMergeActor,
} from "./actors";

const SCHEMA_VERSION = 1;

/**
 * Extract error message including gitOutput if present.
 * The original imperative code concatenated message + gitOutput.
 */
function extractErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    const errObj = error as Error & { gitOutput?: string };
    const parts: string[] = [errObj.message];
    if (errObj.gitOutput) parts.push(errObj.gitOutput);
    return parts.join("\n");
  }
  return String(error);
}

/** Exported type alias so consumers can accept the machine or `.provide()` variants. */
export type MergeMachineType = typeof mergeMachine;

export const mergeMachine = setup({
  types: {
    context: {} as MergeContext,
    events: {} as MergeEvent,
    input: {} as MergeInput,
    output: {} as MergeOutput,
  },
  actors: {
    checkUncommitted: checkUncommitted as ReturnType<
      typeof fromPromise<CheckUncommittedOutput, CheckUncommittedInput>
    >,
    commitChanges: commitChangesActor as ReturnType<
      typeof fromPromise<CommitChangesOutput, CommitChangesInput>
    >,
    mergeMain: mergeMain as ReturnType<
      typeof fromPromise<MergeMainOutput, MergeMainInput>
    >,
    resolveConflicts: resolveConflictsActor as ReturnType<
      typeof fromPromise<ResolveConflictsOutput, ResolveConflictsInput>
    >,
    runValidation: runValidation as ReturnType<
      typeof fromPromise<RunValidationOutput, RunValidationInput>
    >,
    fixValidation: fixValidation as ReturnType<
      typeof fromPromise<FixValidationOutput, FixValidationInput>
    >,
    squashMerge: squashMergeActor as ReturnType<
      typeof fromPromise<SquashMergeOutput, SquashMergeInput>
    >,
  },
  guards: {
    isResolveConflictsJob: ({ context }) =>
      context.jobType === "resolve-conflicts",
    hasUncommittedChanges: ({ event }) => {
      const e = event as unknown as { output: CheckUncommittedOutput };
      return e.output.hasChanges;
    },
    mergeHadConflicts: ({ event }) => {
      const e = event as unknown as { output: MergeMainOutput };
      return e.output.status === "conflicts";
    },
    shouldAutoResolve: ({ context }) => context.autoResolve,
    resolutionSucceeded: ({ event }) => {
      const e = event as unknown as { output: ResolveConflictsOutput };
      return e.output.status === "resolved";
    },
    fixSucceeded: ({ event }) => {
      const e = event as unknown as { output: FixValidationOutput };
      return e.output.status === "fixed";
    },
  },
  actions: {
    onTerminal: () => {
      // Override via .provide() for notifications, SSE broadcast, etc.
    },
  },
}).createMachine({
  id: "smartMerge",
  context: ({ input }) => ({
    _schemaVersion: SCHEMA_VERSION,
    jobId: input.jobId,
    projectPath: input.projectPath,
    projectName: input.projectName,
    sessionName: input.sessionName,
    startedAt: new Date().toISOString(),
    completedAt: null,
    message: input.message,
    branchName: input.branchName,
    worktreePath: input.worktreePath,
    jobType: input.jobType ?? "merge",
    autoResolve: input.autoResolve,
    squashMerge: true,
    conflictFiles: [],
    conflictAnalysis: null,
    decisions: input.decisions ?? null,
    phase: null,
    error: null,
    mergeHash: null,
    commitHash: null,
    validationTimeoutMs: input.validationTimeoutMs ?? 300_000,
    finalStatus: null,
  }),
  initial: "routing",
  states: {
    /**
     * Routing state: resolve-conflicts jobs skip directly to resolvingConflicts.
     * Merge jobs start with the full pipeline.
     * This is a transient state (not observable via subscribe).
     */
    routing: {
      always: [
        { guard: "isResolveConflictsJob", target: "resolvingConflicts" },
        { target: "checkingUncommitted" },
      ],
    },

    checkingUncommitted: {
      entry: assign({ phase: "committing-uncommitted" as const }),
      invoke: {
        src: "checkUncommitted",
        input: ({ context }) => ({ worktreePath: context.worktreePath }),
        onDone: [
          {
            guard: "hasUncommittedChanges",
            target: "committingUncommitted",
          },
          {
            target: "mergingMain",
          },
        ],
        onError: {
          target: "failed",
          actions: assign({
            error: ({ event }) => extractErrorMessage(event.error),
            completedAt: () => new Date().toISOString(),
          }),
        },
      },
    },

    committingUncommitted: {
      invoke: {
        src: "commitChanges",
        input: ({ context }) => ({
          worktreePath: context.worktreePath,
          message: "WIP: uncommitted changes",
          skipHooks: true,
        }),
        onDone: "mergingMain",
        onError: {
          target: "failed",
          actions: assign({
            error: ({ event }) => extractErrorMessage(event.error),
            completedAt: () => new Date().toISOString(),
          }),
        },
      },
    },

    mergingMain: {
      entry: assign({ phase: "merging-main" as const }),
      invoke: {
        src: "mergeMain",
        input: ({ context }) => ({ worktreePath: context.worktreePath }),
        onDone: [
          {
            guard: "mergeHadConflicts",
            actions: assign({
              conflictFiles: ({ event }) => event.output.conflictFiles,
            }),
            target: "conflictsDetected",
          },
          {
            target: "validating",
          },
        ],
        onError: {
          target: "failed",
          actions: assign({
            error: ({ event }) => extractErrorMessage(event.error),
            completedAt: () => new Date().toISOString(),
          }),
        },
      },
    },

    conflictsDetected: {
      always: [
        { guard: "shouldAutoResolve", target: "resolvingConflicts" },
        { target: "conflicts" },
      ],
    },

    resolvingConflicts: {
      entry: assign({ phase: "resolving-conflicts" as const }),
      invoke: {
        src: "resolveConflicts",
        input: ({ context }) => ({
          worktreePath: context.worktreePath,
          decisions: context.decisions ?? undefined,
        }),
        onDone: [
          {
            guard: "resolutionSucceeded",
            actions: assign({
              conflictAnalysis: ({ event }) => event.output.conflicts,
            }),
            target: "committingResolution",
          },
          {
            // Resolution failed — store partial results and go to conflicts
            actions: assign({
              conflictAnalysis: ({ event }) =>
                event.output.partialConflicts ?? null,
            }),
            target: "conflicts",
          },
        ],
        onError: {
          target: "failed",
          actions: assign({
            error: ({ event }) => extractErrorMessage(event.error),
            completedAt: () => new Date().toISOString(),
          }),
        },
      },
    },

    committingResolution: {
      invoke: {
        src: "commitChanges",
        input: ({ context }) => ({
          worktreePath: context.worktreePath,
          message: "resolve merge conflicts",
          skipHooks: true,
        }),
        onDone: "validating",
        onError: {
          target: "failed",
          actions: assign({
            error: ({ event }) => extractErrorMessage(event.error),
            completedAt: () => new Date().toISOString(),
          }),
        },
      },
    },

    validating: {
      entry: assign({ phase: "validating" as const }),
      invoke: {
        src: "runValidation",
        input: ({ context }) => ({
          projectPath: context.projectPath,
          worktreePath: context.worktreePath,
          sessionName: context.sessionName,
          branchName: context.branchName,
          timeoutMs: context.validationTimeoutMs,
        }),
        onDone: "squashMerging",
        onError: [
          {
            guard: "shouldAutoResolve",
            actions: assign({
              error: ({ event }) => extractErrorMessage(event.error),
            }),
            target: "fixingValidation",
          },
          {
            target: "failed",
            actions: assign({
              error: ({ event }) => extractErrorMessage(event.error),
              completedAt: () => new Date().toISOString(),
            }),
          },
        ],
      },
    },

    fixingValidation: {
      entry: assign({ phase: "fixing-validation" as const }),
      invoke: {
        src: "fixValidation",
        input: ({ context }) => ({
          worktreePath: context.worktreePath,
          validationOutput: context.error ?? "",
        }),
        onDone: [
          {
            guard: "fixSucceeded",
            target: "committingFix",
          },
          {
            // Fix failed — go to failed with original error
            target: "failed",
            actions: assign({
              completedAt: () => new Date().toISOString(),
            }),
          },
        ],
        onError: {
          target: "failed",
          actions: assign({
            error: ({ event }) => extractErrorMessage(event.error),
            completedAt: () => new Date().toISOString(),
          }),
        },
      },
    },

    committingFix: {
      invoke: {
        src: "commitChanges",
        input: ({ context }) => ({
          worktreePath: context.worktreePath,
          message: "auto-fix: validation errors",
          skipHooks: true,
        }),
        onDone: "revalidating",
        onError: {
          target: "failed",
          actions: assign({
            error: ({ event }) => extractErrorMessage(event.error),
            completedAt: () => new Date().toISOString(),
          }),
        },
      },
    },

    revalidating: {
      entry: assign({ phase: "re-validating" as const }),
      invoke: {
        src: "runValidation",
        input: ({ context }) => ({
          projectPath: context.projectPath,
          worktreePath: context.worktreePath,
          sessionName: context.sessionName,
          branchName: context.branchName,
          timeoutMs: context.validationTimeoutMs,
        }),
        onDone: {
          target: "squashMerging",
          actions: assign({ error: null }),
        },
        onError: {
          target: "failed",
          actions: assign({
            error: ({ event }) => extractErrorMessage(event.error),
            completedAt: () => new Date().toISOString(),
          }),
        },
      },
    },

    squashMerging: {
      entry: assign({ phase: "squash-merging" as const }),
      invoke: {
        src: "squashMerge",
        input: ({ context }) => ({
          projectPath: context.projectPath,
          branchName: context.branchName,
          message: context.message,
          sessionName: context.sessionName,
        }),
        onDone: {
          target: "completed",
          actions: assign({
            mergeHash: ({ event }) => event.output.mergeHash,
            completedAt: () => new Date().toISOString(),
            phase: null,
          }),
        },
        onError: {
          target: "failed",
          actions: assign({
            error: ({ event }) => extractErrorMessage(event.error),
            completedAt: () => new Date().toISOString(),
            phase: null,
          }),
        },
      },
    },

    completed: {
      type: "final",
      entry: [assign({ finalStatus: "completed" as const }), "onTerminal"],
    },

    failed: {
      type: "final",
      entry: [assign({ finalStatus: "failed" as const }), "onTerminal"],
    },

    conflicts: {
      type: "final",
      entry: [
        assign({
          completedAt: () => new Date().toISOString(),
          phase: null,
          finalStatus: "conflicts" as const,
        }),
        "onTerminal",
      ],
    },
  },
  output: ({ context }) => ({
    status: context.finalStatus ?? ("completed" as const),
    mergeHash: context.mergeHash,
    commitHash: context.commitHash,
    error: context.error,
    conflictFiles: context.conflictFiles,
    conflictAnalysis: context.conflictAnalysis,
  }),
});
