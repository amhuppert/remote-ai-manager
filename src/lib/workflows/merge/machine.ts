/**
 * Smart Merge XState v5 Machine.
 *
 * Models the full merge pipeline with conflict resolution, validation, and
 * a prepare/publish split for the final squash:
 *
 *   entryRouting → merge → verifyingBranch → routing → ...
 *                                                   ↓
 *                                       validating → preparing → publishing → completed
 *                                                                            → readyToLand (final)
 *                                                                            → preparing (CAS retry, bounded)
 *                                                                            → failed   (CAS exhausted or land-mode CAS loss)
 *
 *   entryRouting → land    → publishing (no prepare, uses parked commit)
 *   entryRouting → discard → discarding → discarded (final)
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
  PrepareActorInput,
  PrepareActorOutput,
  PublishActorInput,
  PublishActorOutput,
  DiscardParkedRefInput,
  DiscardParkedRefOutput,
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
  prepareActor,
  publishActor,
  discardParkedRefActor,
} from "./actors";
import {
  extractErrorMessage,
  errorAssign,
  isTimeoutError,
  timeoutHaltMessage,
} from "../utils";

const SCHEMA_VERSION = 1;

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
    prepare: prepareActor as ReturnType<
      typeof fromPromise<PrepareActorOutput, PrepareActorInput>
    >,
    publish: publishActor as ReturnType<
      typeof fromPromise<PublishActorOutput, PublishActorInput>
    >,
    discardParkedRef: discardParkedRefActor as ReturnType<
      typeof fromPromise<DiscardParkedRefOutput, DiscardParkedRefInput>
    >,
  },
  guards: {
    isMergeEntry: ({ context }) => context.entryMode === "merge",
    isLandEntry: ({ context }) => context.entryMode === "land",
    isDiscardEntry: ({ context }) => context.entryMode === "discard",
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
    validationTimedOut: ({ event }) => {
      const e = event as unknown as { error?: unknown };
      return isTimeoutError(e.error);
    },
    prepareProducedConflicts: ({ event }) => {
      const e = event as unknown as { output: PrepareActorOutput };
      return e.output.status === "conflicts";
    },
    publishCompleted: ({ event }) => {
      const e = event as unknown as { output: PublishActorOutput };
      return e.output.status === "completed";
    },
    publishReadyToLand: ({ event }) => {
      const e = event as unknown as { output: PublishActorOutput };
      return e.output.status === "ready-to-land";
    },
    publishCasLost: ({ event }) => {
      const e = event as unknown as { output: PublishActorOutput };
      return e.output.status === "cas-lost";
    },
    publishFailed: ({ event }) => {
      const e = event as unknown as { output: PublishActorOutput };
      return e.output.status === "failed";
    },
    casRetriesRemaining: ({ context }) =>
      context.entryMode === "merge" &&
      context.casAttempt < context.maxCasAttempts,
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
    resolutionContext: input.resolutionContext ?? null,
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
    entryMode: input.entryMode ?? "merge",
    preparedSha: input.preparedSha ?? null,
    expectedTargetSha: input.expectedTargetSha ?? null,
    parkedRef: input.parkedRef ?? null,
    refreshWarning: null,
    casAttempt: 1,
    maxCasAttempts: input.maxCasAttempts ?? 3,
    finalizeSessionOnPublish: input.finalizeSessionOnPublish ?? true,
  }),
  initial: "entryRouting",
  states: {
    /**
     * Transient initial state that routes to the right pipeline based on
     * `entryMode`. Merge enters the full pipeline; Land jumps straight to
     * publishing on an already-parked commit; Discard deletes the parked
     * ref without ever touching the target branch.
     */
    entryRouting: {
      always: [
        { guard: "isLandEntry", target: "publishing" },
        { guard: "isDiscardEntry", target: "discarding" },
        { target: "verifyingBranch" },
      ],
    },

    /**
     * Verify the feature worktree is still on the expected feature branch.
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
          { target: "mergingMain" },
        ],
        onError: { target: "failed", actions: errorAssign() },
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
        onError: { target: "failed", actions: errorAssign() },
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
          { target: "validating" },
        ],
        onError: { target: "failed", actions: errorAssign() },
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
          resolutionContext: context.resolutionContext ?? undefined,
          targetBranch: context.targetBranch,
        }),
        onDone: [
          {
            guard: "analysisSucceeded",
            actions: assign({
              conflictAnalysis: ({ event }) => event.output.conflicts,
            }),
            target: "conflicts",
          },
          { target: "conflicts" },
        ],
        onError: { target: "conflicts" },
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
          resolutionContext: context.resolutionContext ?? undefined,
          targetBranch: context.targetBranch,
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
            actions: assign({
              conflictAnalysis: ({ event }) =>
                event.output.partialConflicts ?? null,
            }),
            target: "conflicts",
          },
        ],
        onError: { target: "failed", actions: errorAssign() },
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
        onError: { target: "failed", actions: errorAssign() },
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
        onDone: "preparing",
        onError: [
          {
            guard: "validationTimedOut",
            target: "failed",
            actions: assign({
              error: ({ event }) => timeoutHaltMessage(event.error),
              completedAt: () => new Date().toISOString(),
            }),
          },
          {
            guard: "shouldAutoResolve",
            actions: assign({
              error: ({ event }) => extractErrorMessage(event.error),
            }),
            target: "fixingValidation",
          },
          { target: "failed", actions: errorAssign() },
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
          { guard: "fixSucceeded", target: "checkingFixChanges" },
          {
            target: "failed",
            actions: assign({
              completedAt: () => new Date().toISOString(),
            }),
          },
        ],
        onError: { target: "failed", actions: errorAssign() },
      },
    },

    checkingFixChanges: {
      invoke: {
        src: "checkUncommitted",
        input: ({ context }) => ({ worktreePath: context.worktreePath }),
        onDone: [
          { guard: "hasUncommittedChanges", target: "committingFix" },
          { target: "revalidating" },
        ],
        onError: { target: "committingFix" },
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
        onError: { target: "failed", actions: errorAssign() },
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
          target: "preparing",
          actions: assign({ error: null }),
        },
        onError: [
          {
            guard: "validationTimedOut",
            target: "failed",
            actions: assign({
              error: ({ event }) => timeoutHaltMessage(event.error),
              completedAt: () => new Date().toISOString(),
            }),
          },
          {
            guard: "hasFixRetriesRemaining",
            actions: assign({
              error: ({ event }) => extractErrorMessage(event.error),
            }),
            target: "fixingValidation",
          },
          { target: "failed", actions: errorAssign() },
        ],
      },
    },

    preparing: {
      entry: assign({ phase: "preparing" as const }),
      invoke: {
        src: "prepare",
        input: ({ context }) => ({
          projectPath: context.projectPath,
          worktreePath: context.worktreePath,
          branchName: context.branchName,
          targetBranch: context.targetBranch,
          message: context.message,
          jobId: context.jobId,
        }),
        onDone: [
          {
            guard: "prepareProducedConflicts",
            target: "failed",
            actions: assign({
              conflictFiles: ({ event }) => {
                const out = event.output;
                return out.status === "conflicts" ? out.conflictFiles : [];
              },
              error: ({ event }) => {
                const out = event.output;
                if (out.status !== "conflicts") return "prepare conflicts";
                return `Prepare produced conflicts in ${out.conflictFiles.length} file(s): ${out.conflictFiles.join(", ")}`;
              },
              completedAt: () => new Date().toISOString(),
            }),
          },
          {
            target: "publishing",
            actions: assign({
              preparedSha: ({ event }) => {
                const out = event.output;
                return out.status === "prepared" ? out.preparedSha : null;
              },
              expectedTargetSha: ({ event }) => {
                const out = event.output;
                return out.status === "prepared" ? out.expectedTargetSha : null;
              },
              parkedRef: ({ event }) => {
                const out = event.output;
                return out.status === "prepared" ? out.parkedRef : null;
              },
            }),
          },
        ],
        onError: { target: "failed", actions: errorAssign() },
      },
    },

    publishing: {
      entry: assign({ phase: "publishing" as const }),
      invoke: {
        src: "publish",
        input: ({ context }) => ({
          projectPath: context.projectPath,
          sessionName: context.sessionName,
          targetBranch: context.targetBranch,
          preparedSha: context.preparedSha ?? "",
          expectedTargetSha: context.expectedTargetSha ?? "",
          parkedRef: context.parkedRef ?? "",
          finalizeSession: context.finalizeSessionOnPublish,
        }),
        onDone: [
          {
            guard: "publishCompleted",
            target: "completed",
            actions: assign({
              mergeHash: ({ event }) => {
                const out = event.output;
                return out.status === "completed" ? out.mergeHash : null;
              },
              refreshWarning: ({ event }) => {
                const out = event.output;
                return out.status === "completed"
                  ? (out.refreshWarning ?? null)
                  : null;
              },
            }),
          },
          {
            guard: "publishReadyToLand",
            target: "readyToLand",
          },
          {
            // CAS lost + retries remaining + merge mode → re-prepare
            guard: ({ context, event }) => {
              const e = event as unknown as { output: PublishActorOutput };
              if (e.output.status !== "cas-lost") return false;
              return (
                context.entryMode === "merge" &&
                context.casAttempt < context.maxCasAttempts
              );
            },
            target: "preparing",
            actions: assign({
              casAttempt: ({ context }) => context.casAttempt + 1,
              preparedSha: null,
              expectedTargetSha: null,
              parkedRef: null,
            }),
          },
          {
            // CAS lost in land mode → fail with a land-specific message
            guard: ({ context, event }) => {
              const e = event as unknown as { output: PublishActorOutput };
              return (
                e.output.status === "cas-lost" && context.entryMode === "land"
              );
            },
            target: "failed",
            actions: assign({
              error:
                "Target branch advanced since prepare; re-run merge to refresh the prepared commit.",
              completedAt: () => new Date().toISOString(),
            }),
          },
          {
            // CAS lost + retries exhausted in merge mode → fail
            guard: "publishCasLost",
            target: "failed",
            actions: assign({
              error: ({ context }) =>
                `CAS contention exhausted on target branch ${context.targetBranch}`,
              completedAt: () => new Date().toISOString(),
            }),
          },
          {
            // publish actor returned failed
            guard: "publishFailed",
            target: "failed",
            actions: assign({
              error: ({ event }) => {
                const out = event.output;
                return out.status === "failed" ? out.error : "publish failed";
              },
              completedAt: () => new Date().toISOString(),
            }),
          },
        ],
        onError: {
          target: "failed",
          actions: [errorAssign(), assign({ phase: null })],
        },
      },
    },

    discarding: {
      invoke: {
        src: "discardParkedRef",
        input: ({ context }) => ({
          projectPath: context.projectPath,
          parkedRef: context.parkedRef ?? "",
          preparedSha: context.preparedSha ?? "",
        }),
        onDone: "discarded",
        onError: { target: "failed", actions: errorAssign() },
      },
    },

    // ============================================================
    // Terminal states
    // ============================================================
    // Phase-clearing rule: clear `phase` on completed/failed/conflicts/discarded;
    // retain `awaiting-land` on readyToLand.

    completed: {
      type: "final",
      entry: [
        assign({
          finalStatus: "completed" as const,
          phase: null,
          completedAt: () => new Date().toISOString(),
        }),
        "onTerminal",
      ],
    },

    failed: {
      type: "final",
      entry: [
        assign({
          finalStatus: "failed" as const,
          phase: null,
          completedAt: () => new Date().toISOString(),
        }),
        "onTerminal",
      ],
    },

    conflicts: {
      type: "final",
      entry: [
        assign({
          finalStatus: "conflicts" as const,
          phase: null,
          completedAt: () => new Date().toISOString(),
        }),
        "onTerminal",
      ],
    },

    readyToLand: {
      type: "final",
      entry: [
        assign({
          finalStatus: "ready-to-land" as const,
          phase: "awaiting-land" as const,
          completedAt: () => new Date().toISOString(),
        }),
        "onTerminal",
      ],
    },

    discarded: {
      type: "final",
      entry: [
        assign({
          finalStatus: "discarded" as const,
          phase: null,
          completedAt: () => new Date().toISOString(),
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
    preparedSha: context.preparedSha,
    expectedTargetSha: context.expectedTargetSha,
    parkedRef: context.parkedRef,
    refreshWarning: context.refreshWarning,
    phase: context.phase,
  }),
});
