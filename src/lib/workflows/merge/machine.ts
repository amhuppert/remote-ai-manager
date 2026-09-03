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
  AbortMergeCleanupInput,
  AbortMergeCleanupOutput,
  AbortStaleMergeInput,
  AbortStaleMergeOutput,
  ClassifyWorktreeInput,
  ClassifyWorktreeOutput,
  CommitResolutionInput,
  CommitResolutionOutput,
  GetCurrentBranchInput,
  GetCurrentBranchOutput,
  MergeMainInput,
  MergeMainOutput,
  ResolveConflictsInput,
  ResolveConflictsOutput,
  AnalyzeConflictsInput,
  AnalyzeConflictsOutput,
  PrepareActorInput,
  PrepareActorOutput,
  PublishActorInput,
  PublishActorOutput,
  DeliveryGateActorInput,
  DeliveryGateActorOutput,
  DiscardParkedRefInput,
  DiscardParkedRefOutput,
} from "./actors";
import {
  abortMergeCleanupActor,
  abortStaleMergeActor,
  classifyWorktreeActor,
  commitResolutionActor,
  getCurrentBranchActor,
  mergeMain,
  resolveConflictsActor,
  analyzeConflictsActor,
  prepareActor,
  publishActor,
  deliveryGateActor,
  discardParkedRefActor,
} from "./actors";
import type {
  CheckUncommittedInput,
  CheckUncommittedOutput,
  CommitChangesInput,
  CommitChangesOutput,
  RunValidationInput,
  RunValidationOutput,
  FixValidationInput,
  FixValidationOutput,
} from "../validation-fix/actors";
import {
  checkUncommitted,
  commitChangesActor,
  runValidation,
  fixValidation,
} from "../validation-fix/actors";
import { createValidationFixStates } from "../validation-fix/states";
import { errorAssign, OPERATOR_ABORT_ERROR } from "../utils";
import type { RunMergeValidationMode } from "../validation-fix/types";

const SCHEMA_VERSION = 1;

function requireRunValidationMode(
  context: MergeContext,
): RunMergeValidationMode {
  if (context.validationMode.mode === "run") return context.validationMode;
  throw new Error("Merge validation routing invoked a skipped validation run");
}

function formatDeliveryGateRefusal(
  output: Extract<DeliveryGateActorOutput, { status: "refused" }>,
): string {
  const criteria = output.unmet
    .map((criterion) =>
      criterion.reason
        ? `${criterion.criterionHandle}: ${criterion.reason}`
        : criterion.criterionHandle,
    )
    .join("; ");
  return `Delivery gate refused merge; unmet criteria: ${criteria}. ${output.instruction}`;
}

/**
 * Shared validate → fix → check → commit-fix → revalidate fragment.
 * Success routes to `preparing`; a validation-script timeout short-circuits
 * to `failed`; only merges that opted into the fix loop dispatch the fix agent.
 */
const validationFixStates = createValidationFixStates<MergeContext>({
  validateInput: (context) => {
    const validationMode = requireRunValidationMode(context);
    return {
      source: validationMode.source,
      selection: validationMode.selection,
      projectPath: context.projectPath,
      worktreePath: context.worktreePath,
      sessionName: context.sessionName,
      branchName: context.branchName,
      targetBranch: context.targetBranch,
      ...(context.conversationId !== null
        ? { conversationId: context.conversationId }
        : {}),
      ...(context.validationWorkflow !== null
        ? { workflow: context.validationWorkflow }
        : {}),
      timeoutMs: context.validationTimeoutMs,
    };
  },
  onValidated: {
    target: "preparing",
    actions: [
      assign({
        candidateValidation: ({ event }) => event.output ?? null,
      }),
    ],
  },
  onTimeout: { target: "failed" },
  shouldAttemptFix: (context) => context.autoFixValidation,
});

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
    classifyWorktree: classifyWorktreeActor as ReturnType<
      typeof fromPromise<ClassifyWorktreeOutput, ClassifyWorktreeInput>
    >,
    abortStaleMerge: abortStaleMergeActor as ReturnType<
      typeof fromPromise<AbortStaleMergeOutput, AbortStaleMergeInput>
    >,
    abortMergeCleanup: abortMergeCleanupActor as ReturnType<
      typeof fromPromise<AbortMergeCleanupOutput, AbortMergeCleanupInput>
    >,
    checkUncommitted: checkUncommitted as ReturnType<
      typeof fromPromise<CheckUncommittedOutput, CheckUncommittedInput>
    >,
    commitChanges: commitChangesActor as ReturnType<
      typeof fromPromise<CommitChangesOutput, CommitChangesInput>
    >,
    commitResolution: commitResolutionActor as ReturnType<
      typeof fromPromise<CommitResolutionOutput, CommitResolutionInput>
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
    deliveryGate: deliveryGateActor as ReturnType<
      typeof fromPromise<DeliveryGateActorOutput, DeliveryGateActorInput>
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
    shouldRunValidation: ({ context }) => context.validationMode.mode === "run",
    branchMatchesExpected: ({ context, event }) => {
      const e = event as unknown as { output: GetCurrentBranchOutput };
      return e.output.branch === context.branchName;
    },
    hasUncommittedChanges: ({ event }) => {
      const e = event as unknown as { output: CheckUncommittedOutput };
      return e.output.hasChanges;
    },
    worktreeIsClean: ({ event }) => {
      const e = event as unknown as { output: ClassifyWorktreeOutput };
      return e.output.kind === "clean";
    },
    worktreeIsDirty: ({ event }) => {
      const e = event as unknown as { output: ClassifyWorktreeOutput };
      return e.output.kind === "dirty";
    },
    staleMergeMayBeAborted: ({ context, event }) => {
      const e = event as unknown as { output: ClassifyWorktreeOutput };
      return (
        e.output.kind === "mid-merge" &&
        e.output.unresolved &&
        context.staleMergePolicy === "abort"
      );
    },
    worktreeIsMidMerge: ({ event }) => {
      const e = event as unknown as { output: ClassifyWorktreeOutput };
      return e.output.kind === "mid-merge";
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
    resolutionFailedOnInfrastructure: ({ event }) => {
      const e = event as unknown as { output: ResolveConflictsOutput };
      return e.output.status === "infrastructure";
    },
    analysisSucceeded: ({ event }) => {
      const e = event as unknown as { output: AnalyzeConflictsOutput };
      return e.output.status === "analyzed";
    },
    prepareProducedConflicts: ({ event }) => {
      const e = event as unknown as { output: PrepareActorOutput };
      return e.output.status === "conflicts";
    },
    prepareFoundNothingToMerge: ({ event }) => {
      const e = event as unknown as { output: PrepareActorOutput };
      return e.output.status === "up-to-date";
    },
    publishCompleted: ({ event }) => {
      const e = event as unknown as { output: PublishActorOutput };
      return e.output.status === "completed";
    },
    publishWasNoOp: ({ event }) => {
      const e = event as unknown as { output: PublishActorOutput };
      return e.output.status === "up-to-date";
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
    deliveryGatePassed: ({ event }) => {
      const e = event as unknown as { output: DeliveryGateActorOutput };
      return e.output.status === "pass";
    },
    casRetriesRemaining: ({ context }) =>
      context.entryMode === "merge" &&
      context.casAttempt < context.maxCasAttempts,
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
    conversationId: input.conversationId ?? null,
    agentTurnDispatch: input.agentTurnDispatch ?? null,
    autoResolve: input.autoResolve,
    autoFixValidation: input.autoFixValidation ?? input.autoResolve,
    squashMerge: true,
    staleMergePolicy: input.staleMergePolicy ?? "refuse",
    conflictFiles: input.conflictFiles ?? [],
    openedMerge: false,
    conflictAnalysis: null,
    decisions: input.decisions ?? null,
    resolutionContext: input.resolutionContext ?? null,
    phase: null,
    error: null,
    mergeHash: null,
    commitHash: null,
    validationTimeoutMs: input.validationTimeoutMs ?? 300_000,
    resolutionTimeoutMs: input.resolutionTimeoutMs ?? null,
    validationMode: input.validationMode,
    fixAttempt: 0,
    maxFixAttempts: input.maxFixAttempts ?? 2,
    finalStatus: null,
    targetBranch: input.targetBranch ?? "main",
    entryMode: input.entryMode ?? "merge",
    preparedSha: input.preparedSha ?? null,
    expectedTargetSha: input.expectedTargetSha ?? null,
    parkedRef: input.parkedRef ?? null,
    refreshWarning: null,
    upToDate: false,
    abortRequested: false,
    casAttempt: 1,
    maxCasAttempts: input.maxCasAttempts ?? 3,
    finalizeSessionOnPublish: input.finalizeSessionOnPublish ?? true,
    executionId: input.executionId ?? null,
    validationWorkflow: input.validationWorkflow ?? null,
    candidateValidation: input.candidateValidation ?? null,
    haltReason: null,
    resolutionFailure: null,
  }),
  initial: "entryRouting",
  // An operator can stop the run from any phase; every in-flight actor is
  // stopped by the state exit, which is what cancels the agent turns that
  // receive the invoke's AbortSignal.
  on: { ABORT: ".aborting" },
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
        { target: "classifyingWorktree" },
      ],
    },

    /**
     * Decide what the worktree holds before anything stages or commits it.
     * Only `clean` and `dirty` are the machine's to act on; the merge-bearing
     * readings belong to whoever started that merge, and the policy decides
     * whether this run may discard one it recognizes as its own machinery's.
     */
    classifyingWorktree: {
      entry: assign({ phase: "committing-uncommitted" as const }),
      invoke: {
        src: "classifyWorktree",
        input: ({ context }) => ({ worktreePath: context.worktreePath }),
        onDone: [
          { guard: "worktreeIsClean", target: "mergingMain" },
          { guard: "worktreeIsDirty", target: "committingUncommitted" },
          { guard: "staleMergeMayBeAborted", target: "abortingStaleMerge" },
          {
            guard: "worktreeIsMidMerge",
            target: "failed",
            actions: assign({
              error: ({ context, event }) =>
                event.output.kind === "mid-merge" && event.output.unresolved
                  ? `Worktree ${context.worktreePath} is mid-merge from an earlier conflicted merge. Resolve the conflicts and commit, resume the conflict flow, or abort the merge (git merge --abort), then retry.`
                  : `Worktree ${context.worktreePath} holds a merge whose conflicts are resolved but not committed. Commit your resolution, then retry or resume.`,
              completedAt: () => new Date().toISOString(),
            }),
          },
          {
            target: "failed",
            actions: assign({
              error: ({ context, event }) => {
                if (event.output.kind !== "poisoned") {
                  return `Worktree ${context.worktreePath} could not be classified before merging`;
                }
                const files = [
                  ...new Set([
                    ...event.output.artifacts.unmergedFiles,
                    ...event.output.artifacts.markerFiles,
                  ]),
                ];
                return `Worktree ${context.worktreePath} carries conflict artifacts with no merge in progress — ${files.length} file(s): ${files.join(", ")}. Restore or resolve them by hand; nothing may commit this state.`;
              },
              completedAt: () => new Date().toISOString(),
            }),
          },
        ],
        onError: { target: "failed", actions: errorAssign() },
      },
    },

    /**
     * The classified-unresolved merge is discarded so the run starts from the
     * branch tip. The tree can still hold ordinary uncommitted work the abort
     * did not touch, so the pre-existing uncommitted check runs next.
     */
    abortingStaleMerge: {
      invoke: {
        src: "abortStaleMerge",
        input: ({ context }) => ({ worktreePath: context.worktreePath }),
        onDone: "checkingUncommitted",
        onError: { target: "failed", actions: errorAssign() },
      },
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
      // Recorded on entry, not on the conflicted outcome: a stop that lands
      // while the merge command itself is running leaves the same MERGE_HEAD,
      // and this run still owns it.
      entry: assign({
        phase: "merging-main" as const,
        openedMerge: true,
      }),
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
          { target: "validationRouting" },
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
          conversationId: context.conversationId ?? undefined,
          agentTurnDispatch: context.agentTurnDispatch ?? undefined,
          resolutionContext: context.resolutionContext ?? undefined,
          targetBranch: context.targetBranch,
          resolutionTimeoutMs: context.resolutionTimeoutMs ?? undefined,
        }),
        onDone: [
          {
            guard: "analysisSucceeded",
            actions: assign({
              conflictAnalysis: ({ event }) =>
                event.output.status === "analyzed"
                  ? event.output.conflicts
                  : null,
            }),
            target: "conflicts",
          },
          {
            // The conflict itself is real and still awaits a human, so this
            // stays a `conflicts` halt — but an empty analysis must say why it
            // is empty rather than read as "nothing to describe".
            target: "conflicts",
            actions: assign({
              resolutionFailure: ({ event }) =>
                event.output.status === "infrastructure"
                  ? event.output.failure
                  : null,
              error: ({ event }) =>
                event.output.status === "infrastructure"
                  ? `Conflict analysis could not run (${event.output.failure.kind}): ${event.output.failure.message}`
                  : null,
            }),
          },
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
          conversationId: context.conversationId ?? undefined,
          agentTurnDispatch: context.agentTurnDispatch ?? undefined,
          conflictFiles: context.conflictFiles,
          decisions: context.decisions ?? undefined,
          resolutionContext: context.resolutionContext ?? undefined,
          targetBranch: context.targetBranch,
          resolutionTimeoutMs: context.resolutionTimeoutMs ?? undefined,
        }),
        onDone: [
          {
            guard: "resolutionSucceeded",
            actions: assign({
              conflictAnalysis: ({ event }) =>
                event.output.status === "resolved"
                  ? event.output.conflicts
                  : null,
            }),
            target: "committingResolution",
          },
          {
            // The resolver never reached the conflict, so the run failed on
            // infrastructure: naming these files as the blocker (a `conflicts`
            // halt) would blame content nothing examined, and would spend the
            // conflict-retry budget on a backend that is still down.
            guard: "resolutionFailedOnInfrastructure",
            target: "failed",
            actions: assign({
              resolutionFailure: ({ event }) =>
                event.output.status === "infrastructure"
                  ? event.output.failure
                  : null,
              haltReason: ({ context, event }) =>
                event.output.status === "infrastructure"
                  ? {
                      type: "resolution_infrastructure" as const,
                      failure: event.output.failure,
                      conflictFiles: context.conflictFiles,
                    }
                  : null,
              error: ({ event }) =>
                event.output.status === "infrastructure"
                  ? `Conflict resolution could not run (${event.output.failure.kind}): ${event.output.failure.message}`
                  : "Conflict resolution could not run",
              completedAt: () => new Date().toISOString(),
            }),
          },
          {
            actions: assign({
              conflictAnalysis: ({ event }) =>
                event.output.status === "unresolved"
                  ? (event.output.partialConflicts ?? null)
                  : null,
              error: ({ event }) =>
                event.output.status === "unresolved"
                  ? event.output.error
                  : null,
            }),
            target: "conflicts",
          },
        ],
        onError: { target: "failed", actions: errorAssign() },
      },
    },

    // Concludes the merge the resolver staged. The target branch travels with
    // the request because a resolver that committed the merge itself leaves
    // nothing to commit, and only the target identifies that finished merge
    // as the one this run wanted rather than a failure.
    committingResolution: {
      invoke: {
        src: "commitResolution",
        input: ({ context }) => ({
          worktreePath: context.worktreePath,
          targetBranch: context.targetBranch,
          message: "resolve merge conflicts",
        }),
        onDone: "validationRouting",
        onError: { target: "failed", actions: errorAssign() },
      },
    },

    validationRouting: {
      always: [
        { guard: "shouldRunValidation", target: "validating" },
        { target: "preparing" },
      ],
    },

    // Shared validate → fix → check → commit-fix → revalidate fragment
    ...validationFixStates,

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
            // Nothing to land, but the merge still has to be delivered: the
            // gate evaluates the target tip as the candidate (a workflow-linked
            // no-op owes the same proof) and the publish step finishes the
            // session without moving a ref.
            guard: "prepareFoundNothingToMerge",
            target: "publishing",
            actions: assign({
              upToDate: true,
              preparedSha: ({ event }) => {
                const out = event.output;
                return out.status === "up-to-date"
                  ? out.expectedTargetSha
                  : null;
              },
              expectedTargetSha: ({ event }) => {
                const out = event.output;
                return out.status === "up-to-date"
                  ? out.expectedTargetSha
                  : null;
              },
              parkedRef: null,
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
        src: "deliveryGate",
        input: ({ context }) => ({
          workflowExecutionId: context.executionId ?? undefined,
          preparedSha: context.preparedSha ?? "",
          expectedTargetSha: context.expectedTargetSha ?? "",
          projectPath: context.projectPath,
          ...(context.candidateValidation && {
            candidateValidation: context.candidateValidation,
          }),
        }),
        onDone: [
          {
            guard: "deliveryGatePassed",
            target: "publishingCandidate",
          },
          {
            target: "deliveryGateFailed",
            actions: assign({
              error: ({ event }) => {
                const output = event.output;
                if (output.status !== "refused") {
                  return "Delivery gate refused merge";
                }
                // Waiting on a human approval is not an unmet-criteria
                // failure: say what the run waits on, not a pseudo-criterion.
                return output.refusalCode === "approval_required"
                  ? `Delivery gate is waiting on human delivery approval. ${output.instruction}`
                  : formatDeliveryGateRefusal(output);
              },
              haltReason: ({ event }) => {
                const output = event.output;
                if (output.status !== "refused") return null;
                return {
                  type: "delivery_gate_failed" as const,
                  unmet: output.unmet,
                  instruction: output.instruction,
                  ...(output.refusalCode !== undefined
                    ? { refusalCode: output.refusalCode }
                    : {}),
                  ...(output.spec !== undefined ? { spec: output.spec } : {}),
                };
              },
              completedAt: () => new Date().toISOString(),
            }),
          },
        ],
        onError: { target: "failed", actions: errorAssign() },
      },
    },

    publishingCandidate: {
      // The one phase an operator cannot stop: the publish actor's CAS update,
      // parked-ref delete, and session finalization are already in flight and
      // cannot be recalled, so abandoning the run here would report a failure
      // for a merge that landed. The overriding transition keeps the root ABORT
      // from reaching this state, but records it: if the publish comes back
      // having lost CAS, the run is recallable again and honors the stop
      // instead of re-preparing.
      on: { ABORT: { actions: assign({ abortRequested: true }) } },
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
          upToDate: context.upToDate,
        }),
        onDone: [
          {
            guard: "publishWasNoOp",
            target: "completed",
          },
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
            // Nothing landed, and the operator's stop is still outstanding:
            // this is the first moment it can be honored.
            guard: ({ context, event }) => {
              const e = event as unknown as { output: PublishActorOutput };
              return e.output.status === "cas-lost" && context.abortRequested;
            },
            target: "aborting",
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

    /**
     * Where an operator's stop lands. The cleanup is best-effort and its
     * outcome does not change the verdict: the run ends as the operator's
     * failure either way, and a cleanup error would otherwise replace the
     * reason they can act on with one they cannot.
     */
    aborting: {
      invoke: {
        src: "abortMergeCleanup",
        input: ({ context }) => ({
          worktreePath: context.worktreePath,
          openedMerge: context.openedMerge,
        }),
        onDone: {
          target: "failed",
          actions: assign({
            error: ({ event }) =>
              event.output.preservedMerge
                ? `${OPERATOR_ABORT_ERROR}. The worktree still holds an in-progress merge that was not this run's to discard — commit it or abort it (git merge --abort) before merging again.`
                : OPERATOR_ABORT_ERROR,
          }),
        },
        onError: {
          target: "failed",
          actions: assign({ error: OPERATOR_ABORT_ERROR }),
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

    deliveryGateFailed: {
      type: "final",
      entry: assign({
        finalStatus: "failed" as const,
        phase: null,
        completedAt: () => new Date().toISOString(),
      }),
    },

    conflicts: {
      type: "final",
      entry: assign({
        finalStatus: "conflicts" as const,
        phase: null,
        completedAt: () => new Date().toISOString(),
      }),
    },

    readyToLand: {
      type: "final",
      entry: assign({
        finalStatus: "ready-to-land" as const,
        phase: "awaiting-land" as const,
        completedAt: () => new Date().toISOString(),
      }),
    },

    discarded: {
      type: "final",
      entry: assign({
        finalStatus: "discarded" as const,
        phase: null,
        completedAt: () => new Date().toISOString(),
      }),
    },
  },
  output: ({ context }) => ({
    status: context.finalStatus ?? ("completed" as const),
    mergeHash: context.mergeHash,
    upToDate: context.upToDate,
    commitHash: context.commitHash,
    error: context.error,
    conflictFiles: context.conflictFiles,
    conflictAnalysis: context.conflictAnalysis,
    preparedSha: context.preparedSha,
    expectedTargetSha: context.expectedTargetSha,
    parkedRef: context.parkedRef,
    refreshWarning: context.refreshWarning,
    candidateValidation: context.candidateValidation,
    haltReason: context.haltReason,
    phase: context.phase,
  }),
});
