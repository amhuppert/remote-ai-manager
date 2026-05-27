/**
 * Smart Merge XState v5 Machine.
 *
 * Models the full merge pipeline with conflict resolution and validation:
 *
 *   routing → checkingUncommitted → committingUncommitted → mergingMain
 *                                                         ↓
 *                                         (clean) → validating → squashMerging → completed
 *                                         (conflicts + autoResolve) → resolvingConflicts → committingResolution → validating
 *                                         (conflicts + !autoResolve) → analyzingConflicts → conflicts (final)
 *
 *   routing → resolvingConflicts (for resolve-conflicts jobs)
 *
 *   validating → (fail + autoResolve) → fixingValidation → checkingFixChanges → committingFix → revalidating → squashMerging
 *                                                                             ↘ (no changes) → revalidating
 *                                                                          ↗ (retry if attempts remain)
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
  GetCurrentBranchInput,
  GetCurrentBranchOutput,
  MergeMainInput,
  MergeMainOutput,
  ResolveConflictsInput,
  ResolveConflictsOutput,
  AnalyzeConflictsInput,
  AnalyzeConflictsOutput,
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
  getCurrentBranchActor,
  mergeMain,
  resolveConflictsActor,
  analyzeConflictsActor,
  runValidation,
  fixValidation,
  squashMergeActor,
} from "./actors";
import {
  extractErrorMessage,
  errorAssign,
  createTerminalStates,
} from "../utils";

const SCHEMA_VERSION = 1;

/** Standard terminal states for the merge machine. */
const terminals = createTerminalStates(["completed", "failed"] as const);

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
    getCurrentBranch: getCurrentBranchActor as ReturnType<
      typeof fromPromise<GetCurrentBranchOutput, GetCurrentBranchInput>
    >,
    mergeMain: mergeMain as ReturnType<
      typeof fromPromise<MergeMainOutput, MergeMainInput>
    >,
    resolveConflicts: resolveConflictsActor as ReturnType<
      typeof fromPromise<ResolveConflictsOutput, ResolveConflictsInput>
    >,
    analyzeConflicts: analyzeConflictsActor as ReturnType<
      typeof fromPromise<AnalyzeConflictsOutput, AnalyzeConflictsInput>
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
    branchMatchesExpected: ({ context, event }) => {
      const e = event as unknown as { output: GetCurrentBranchOutput };
      return e.output.branch === context.branchName;
    },
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
    analysisSucceeded: ({ event }) => {
      const e = event as unknown as { output: AnalyzeConflictsOutput };
      return e.output.status === "analyzed";
    },
    fixSucceeded: ({ event }) => {
      const e = event as unknown as { output: FixValidationOutput };
      return e.output.status === "fixed";
    },
    hasFixRetriesRemaining: ({ context }) =>
      context.fixAttempt < context.maxFixAttempts,
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
    fixAttempt: 0,
    maxFixAttempts: input.maxFixAttempts ?? 2,
    finalStatus: null,
    targetBranch: input.targetBranch ?? "main",
    targetWorktreePath: input.targetWorktreePath ?? null,
  }),
  initial: "verifyingBranch",
  states: {
    /**
     * Verify the feature worktree is still on the expected feature branch.
     * Prevents the entire pipeline from running on `main` (or any other
     * unintended branch) if something checked out a different ref in the
     * worktree between provisioning and merge.
     */
    verifyingBranch: {
      invoke: {
        src: "getCurrentBranch",
        input: ({ context }) => ({ worktreePath: context.worktreePath }),
        onDone: [
          { guard: "branchMatchesExpected", target: "routing" },
          {
            target: "failed",
            actions: assign({
              error: ({ context, event }) => {
                const actual = event.output.branch;
                const expected = context.branchName;
                if (actual === null) {
                  return `Feature worktree ${context.worktreePath} is in detached HEAD state; expected branch ${expected}`;
                }
                return `Feature worktree ${context.worktreePath} is on branch ${actual}; expected ${expected}`;
              },
              completedAt: () => new Date().toISOString(),
            }),
          },
        ],
        onError: {
          target: "failed",
          actions: errorAssign(),
        },
      },
    },

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
          actions: errorAssign(),
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
          actions: errorAssign(),
        },
      },
    },

    mergingMain: {
      entry: assign({ phase: "merging-main" as const }),
      invoke: {
        src: "mergeMain",
        input: ({ context }) => ({
          worktreePath: context.worktreePath,
          targetBranch: context.targetBranch,
        }),
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
          actions: errorAssign(),
        },
      },
    },

    conflictsDetected: {
      always: [
        { guard: "shouldAutoResolve", target: "resolvingConflicts" },
        { target: "analyzingConflicts" },
      ],
    },

    analyzingConflicts: {
      entry: assign({ phase: "analyzing-conflicts" as const }),
      invoke: {
        src: "analyzeConflicts",
        input: ({ context }) => ({
          worktreePath: context.worktreePath,
          projectPath: context.projectPath,
          sessionName: context.sessionName,
        }),
        onDone: [
          {
            guard: "analysisSucceeded",
            actions: assign({
              conflictAnalysis: ({ event }) => event.output.conflicts,
            }),
            target: "conflicts",
          },
          {
            // Analysis failed — go to conflicts without analysis
            target: "conflicts",
          },
        ],
        onError: {
          // Graceful degradation — go to conflicts without analysis
          target: "conflicts",
        },
      },
    },

    resolvingConflicts: {
      entry: assign({ phase: "resolving-conflicts" as const }),
      invoke: {
        src: "resolveConflicts",
        input: ({ context }) => ({
          worktreePath: context.worktreePath,
          projectPath: context.projectPath,
          sessionName: context.sessionName,
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
          actions: errorAssign(),
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
          actions: errorAssign(),
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
          targetBranch: context.targetBranch,
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
            actions: errorAssign(),
          },
        ],
      },
    },

    fixingValidation: {
      entry: [
        assign({ phase: "fixing-validation" as const }),
        assign({ fixAttempt: ({ context }) => context.fixAttempt + 1 }),
      ],
      invoke: {
        src: "fixValidation",
        input: ({ context }) => ({
          worktreePath: context.worktreePath,
          validationOutput: context.error ?? "",
          projectPath: context.projectPath,
          sessionName: context.sessionName,
          branchName: context.branchName,
          isRetry: context.fixAttempt > 1,
        }),
        onDone: [
          {
            guard: "fixSucceeded",
            target: "checkingFixChanges",
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
          actions: errorAssign(),
        },
      },
    },

    /**
     * Check whether the fix agent actually made changes before committing.
     * If it didn't (e.g. it couldn't fix test failures), skip straight to
     * revalidating so the machine can decide whether to retry or fail based
     * on actual validation results, not a spurious commit error.
     */
    checkingFixChanges: {
      invoke: {
        src: "checkUncommitted",
        input: ({ context }) => ({ worktreePath: context.worktreePath }),
        onDone: [
          {
            guard: "hasUncommittedChanges",
            target: "committingFix",
          },
          { target: "revalidating" },
        ],
        onError: {
          // Best-effort: if we can't check, try to commit anyway
          target: "committingFix",
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
          actions: errorAssign(),
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
          targetBranch: context.targetBranch,
          timeoutMs: context.validationTimeoutMs,
        }),
        onDone: {
          target: "squashMerging",
          actions: assign({ error: null }),
        },
        onError: [
          {
            // Retry: go back to fixingValidation with new error output
            guard: "hasFixRetriesRemaining",
            actions: assign({
              error: ({ event }) => extractErrorMessage(event.error),
            }),
            target: "fixingValidation",
          },
          {
            // No retries remaining — fail
            target: "failed",
            actions: errorAssign(),
          },
        ],
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
          targetBranch: context.targetBranch,
          targetWorktreePath: context.targetWorktreePath,
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
          actions: [errorAssign(), assign({ phase: null })],
        },
      },
    },

    // Standard terminal states (completed, failed)
    ...terminals,

    // Custom terminal state: conflicts has extra entry actions
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
