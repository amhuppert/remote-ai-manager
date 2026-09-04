/**
 * Actor logic (fromPromise) for the Smart Merge workflow.
 *
 * Each actor wraps an existing function from the codebase and provides
 * typed input/output for the XState machine to invoke.
 */

import { fromPromise } from "xstate";
import type { ConflictEntry, ConflictDecisionInput } from "@/lib/jobs/schemas";
import type { AgentFailureClassification } from "@/lib/agent-backends/errors";
import { createLogger } from "@/lib/logging";
import {
  acquireProjectLockWithRetry,
  type AcquireProjectLockOptions,
} from "@/lib/shared/lock-retry";
import type {
  PrepareResult,
  PrepareSquashMergeInput,
  PublishPreparedMergeInput,
  PublishResult,
  TargetCheckoutState,
} from "@/lib/git/worktree";
import type { ConflictArtifacts } from "@/lib/git/conflict-markers";
import type {
  DeliveryGateEvaluateInput,
  DeliveryGateEvaluation,
  DeliveryGateEvaluator,
} from "./types";
import { resolveSessionConversationId } from "../validation-fix/actors";
import { getErrorMessage } from "@/lib/shared/errors";
import type { GraphWorkflowExecution } from "@/lib/workflow-graph/schemas";
import { evaluateGraphWorkflowSessionDelivery } from "@/lib/workflow-graph/lifecycle-classifier";

const logger = createLogger("smart-merge-actors");

// ============================================================
// Actor Input/Output Types
// ============================================================

export interface GetCurrentBranchInput {
  worktreePath: string;
}
export interface GetCurrentBranchOutput {
  branch: string | null;
}

export interface ClassifyWorktreeInput {
  worktreePath: string;
}

/**
 * What a merge-family machine finds when it takes hold of a worktree.
 *
 * The four readings differ in who owns the tree's current contents. `dirty` is
 * work the machine may commit for the caller; the other three are not — a
 * `mid-merge` tree belongs to whoever started that merge (an operator, or an
 * earlier machine run), and `poisoned` is the wreckage an index resync leaves
 * when it erases MERGE_HEAD but not the markers, which no policy may commit.
 */
export type WorktreeEntryState =
  | { kind: "clean" }
  | { kind: "dirty" }
  /** MERGE_HEAD is set; `unresolved` distinguishes a conflict still in the
   *  files from a finished resolution waiting to be committed. */
  | { kind: "mid-merge"; unresolved: boolean }
  /** No MERGE_HEAD, yet conflict artifacts remain in the tracked changes. */
  | { kind: "poisoned"; artifacts: ConflictArtifacts };

export type ClassifyWorktreeOutput = WorktreeEntryState;

export interface AbortStaleMergeInput {
  worktreePath: string;
}
export interface AbortStaleMergeOutput {
  /** False when nothing was there to abort (MERGE_HEAD already gone). */
  aborted: boolean;
}

export interface AbortMergeCleanupInput {
  worktreePath: string;
  /** Whether the run being stopped is the one that opened the merge the
   *  worktree may still hold (see `MergeContext.openedMerge`). */
  openedMerge: boolean;
}
export interface AbortMergeCleanupOutput {
  /** False when the stopped run had left no merge open. */
  abortedMerge: boolean;
  /** A merge the cleanup deliberately left in place: whoever takes the
   *  worktree next has to conclude it by hand. */
  preservedMerge: boolean;
}

export interface MergeMainInput {
  worktreePath: string;
  targetBranch: string;
}
export interface MergeMainOutput {
  status: "clean" | "conflicts";
  conflictFiles: string[];
}

export interface CommitResolutionInput {
  worktreePath: string;
  targetBranch: string;
  message: string;
}
export interface CommitResolutionOutput {
  hash: string;
  committedBy: "orchestrator" | "resolver";
}

export interface ResolveConflictsInput {
  worktreePath: string;
  projectPath: string;
  sessionName: string;
  /** Explicit conversation for the resolver turn (graph joins pass the source
   *  lane's implementer conversation). Falls back to the session's
   *  most-recently-active conversation when omitted. */
  conversationId?: string;
  /** Files the merge reported as conflicted; the resolver verifies these are
   *  marker-free after the agent claims resolution. */
  conflictFiles?: string[];
  decisions?: ConflictDecisionInput[];
  resolutionContext?: string;
  targetBranch?: string;
  /** Bound on the resolver turn; omitted takes the resolver's own default. */
  resolutionTimeoutMs?: number;
}
/**
 * Mirrors the resolver's three-way outcome (`sessions/conflict-resolution`):
 * a content-level `unresolved` verdict and an `infrastructure` failure route
 * to different terminals, so the actor boundary must keep them apart — and
 * carry the message/classification the machine's halt reason is built from.
 */
export type ResolveConflictsOutput =
  | { status: "resolved"; conflicts: ConflictEntry[] }
  | {
      status: "unresolved";
      error: string;
      partialConflicts?: ConflictEntry[];
    }
  | { status: "infrastructure"; failure: AgentFailureClassification };

export interface AnalyzeConflictsInput {
  worktreePath: string;
  projectPath: string;
  sessionName: string;
  /** See {@link ResolveConflictsInput.conversationId}. */
  conversationId?: string;
  resolutionContext?: string;
  targetBranch?: string;
  /** See {@link ResolveConflictsInput.resolutionTimeoutMs}. */
  resolutionTimeoutMs?: number;
}
export type AnalyzeConflictsOutput =
  | { status: "analyzed"; conflicts: ConflictEntry[] }
  | { status: "infrastructure"; failure: AgentFailureClassification };

export interface PrepareActorInput {
  projectPath: string;
  worktreePath: string;
  branchName: string;
  targetBranch: string;
  message: string;
  jobId: string;
  /** Override the auto-detected prepare path (sourced from per-repo config). */
  forcePath?: "plumbing" | "fallback";
}

export type PrepareActorOutput =
  | {
      status: "prepared";
      preparedSha: string;
      expectedTargetSha: string;
      parkedRef: string;
    }
  /** The target already contains the branch: nothing was parked to publish. */
  | {
      status: "up-to-date";
      expectedTargetSha: string;
    }
  | {
      status: "conflicts";
      expectedTargetSha: string;
      conflictFiles: string[];
    };

export interface PublishActorInput {
  projectPath: string;
  sessionName: string;
  targetBranch: string;
  preparedSha: string;
  expectedTargetSha: string;
  parkedRef: string;
  /** When true, the actor finalises the session (state, dev-servers, child retargeting) on success. */
  finalizeSession: boolean;
  /**
   * Publish a merge that has nothing to land: the target already contains the
   * branch. The ref moves and the parked commit do not exist, so everything
   * that touches them is skipped — but the session still finishes, which is
   * why this runs through the publish step at all rather than short-circuiting
   * to a terminal. Absent means an ordinary publish.
   */
  upToDate?: boolean;
}

export type PublishActorOutput =
  | {
      status: "completed";
      mergeHash: string;
      refreshWarning?: string;
    }
  /** The merge was a no-op: the session was finalized, no commit was published. */
  | { status: "up-to-date" }
  | {
      status: "ready-to-land";
      parkedRef: string;
      preparedSha: string;
      targetWorktreePath: string;
    }
  | {
      status: "cas-lost";
      actualTargetSha: string;
    }
  | {
      status: "failed";
      error: string;
    };

export type DeliveryGateActorInput = Omit<
  DeliveryGateEvaluateInput,
  "workflowExecutionId"
> & {
  workflowExecutionId?: string;
};

export type DeliveryGateActorOutput = DeliveryGateEvaluation;

// ============================================================
// Actor Definitions
// ============================================================

export function createDeliveryGateActor(evaluator: DeliveryGateEvaluator) {
  return fromPromise<DeliveryGateActorOutput, DeliveryGateActorInput>(
    async ({ input }) => {
      if (!input.workflowExecutionId) {
        logger.debug("delivery_gate.skipped", {
          preparedSha: input.preparedSha,
          projectPath: input.projectPath,
        });
        return { status: "pass", satisfied: [], deferred: [] };
      }

      logger.info("delivery_gate.evaluate_started", {
        workflowExecutionId: input.workflowExecutionId,
        preparedSha: input.preparedSha,
        expectedTargetSha: input.expectedTargetSha,
        projectPath: input.projectPath,
      });
      const result = await evaluator.evaluate({
        workflowExecutionId: input.workflowExecutionId,
        preparedSha: input.preparedSha,
        expectedTargetSha: input.expectedTargetSha,
        projectPath: input.projectPath,
        ...(input.candidateValidation && {
          candidateValidation: input.candidateValidation,
        }),
      });

      if (result.status === "refused") {
        logger.warn("delivery_gate.refused", {
          workflowExecutionId: input.workflowExecutionId,
          preparedSha: input.preparedSha,
          unmetCount: result.unmet.length,
        });
        return result;
      }

      logger.info("delivery_gate.passed", {
        workflowExecutionId: input.workflowExecutionId,
        preparedSha: input.preparedSha,
        satisfiedCount: result.satisfied.length,
        deferredCount: result.deferred.length,
      });
      return result;
    },
  );
}

export const deliveryGateActor = createDeliveryGateActor({
  async evaluate() {
    throw new Error(
      "Delivery gate evaluator is required for a linked workflow execution",
    );
  },
});

/** Read the worktree's currently checked-out branch (null = detached HEAD). */
export const getCurrentBranchActor = fromPromise<
  GetCurrentBranchOutput,
  GetCurrentBranchInput
>(async ({ input }) => {
  const { getCurrentBranch } = await import("@/lib/git/commits");
  const branch = await getCurrentBranch(input.worktreePath);
  return { branch };
});

/**
 * Decide what the worktree holds before any machine state acts on it. The
 * readings are ordered by authority: an unconcluded merge answers for the whole
 * tree whatever else is dirty, and conflict artifacts outrank ordinary changes
 * because a "dirty" verdict is the one that authorizes a commit.
 */
export async function classifyWorktreeEntry(
  worktreePath: string,
): Promise<WorktreeEntryState> {
  const { inspectInProgressMerge, scanConflictArtifacts } =
    await import("@/lib/git/conflict-markers");
  const { hasUncommittedChanges } = await import("@/lib/git/commits");

  const inProgress = await inspectInProgressMerge(worktreePath);
  if (inProgress.kind !== "none") {
    return { kind: "mid-merge", unresolved: inProgress.kind === "unresolved" };
  }

  const artifacts = await scanConflictArtifacts(worktreePath);
  if (artifacts.unmergedFiles.length > 0 || artifacts.markerFiles.length > 0) {
    return { kind: "poisoned", artifacts };
  }

  return (await hasUncommittedChanges(worktreePath))
    ? { kind: "dirty" }
    : { kind: "clean" };
}

/** Classify the worktree a merge-family machine is about to operate on. */
export const classifyWorktreeActor = fromPromise<
  ClassifyWorktreeOutput,
  ClassifyWorktreeInput
>(async ({ input }) => {
  const state = await classifyWorktreeEntry(input.worktreePath);
  if (state.kind === "mid-merge" || state.kind === "poisoned") {
    logger.warn("merge.worktree_entry_unsafe", {
      worktreePath: input.worktreePath,
      kind: state.kind,
      ...(state.kind === "mid-merge"
        ? { unresolved: state.unresolved }
        : {
            unmergedFiles: state.artifacts.unmergedFiles.length,
            markerFiles: state.artifacts.markerFiles.length,
          }),
    });
  }
  return state;
});

/**
 * Discard an unresolved merge the machinery itself left behind, so the run can
 * start from the branch tip. Only ever reached for a tree classified
 * `mid-merge` with `unresolved: true` — a resolved-but-uncommitted merge is
 * somebody's finished work and is refused rather than aborted.
 */
export const abortStaleMergeActor = fromPromise<
  AbortStaleMergeOutput,
  AbortStaleMergeInput
>(async ({ input }) => {
  const { abortInProgressMerge } = await import("@/lib/git/worktree");
  return { aborted: await abortInProgressMerge(input.worktreePath) };
});

/**
 * Leave the worktree without a half-finished merge when an operator stops the
 * run — but only the merge that run itself opened, and only while it is still
 * unresolved. A merge this run inherited (a `resolve-conflicts` re-entry
 * resumes one an earlier run left behind) and a merge whose conflicts are
 * already resolved are both somebody's unfinished work, and stopping the agent
 * that was writing into them is not consent to discard them.
 *
 * Best-effort by construction: the operator asked for the job to stop, so a
 * failing cleanup must not keep the machine alive.
 */
export const abortMergeCleanupActor = fromPromise<
  AbortMergeCleanupOutput,
  AbortMergeCleanupInput
>(async ({ input }) => {
  const { inspectInProgressMerge } = await import("@/lib/git/conflict-markers");
  const { abortInProgressMerge } = await import("@/lib/git/worktree");
  try {
    const merge = await inspectInProgressMerge(input.worktreePath);
    if (merge.kind === "none") {
      return { abortedMerge: false, preservedMerge: false };
    }
    if (!input.openedMerge || merge.kind === "resolved") {
      logger.info("merge.abort_cleanup_preserved", {
        worktreePath: input.worktreePath,
        openedMerge: input.openedMerge,
        mergeState: merge.kind,
      });
      return { abortedMerge: false, preservedMerge: true };
    }
    const abortedMerge = await abortInProgressMerge(input.worktreePath);
    return { abortedMerge, preservedMerge: false };
  } catch (err) {
    // The tree's state is now unknown, so the run reports no cleanup rather
    // than a preservation it cannot vouch for.
    logger.warn("merge.abort_cleanup_failed", {
      worktreePath: input.worktreePath,
      error: getErrorMessage(err),
    });
    return { abortedMerge: false, preservedMerge: false };
  }
});

/** Merge target branch into the feature branch. */
export const mergeMain = fromPromise<MergeMainOutput, MergeMainInput>(
  async ({ input }) => {
    const { mergeTargetIntoFeature } = await import("@/lib/git/worktree");
    const result = await mergeTargetIntoFeature(
      input.worktreePath,
      input.targetBranch,
    );
    return {
      status: result.status,
      conflictFiles: result.status === "conflicts" ? result.conflictFiles : [],
    };
  },
);

/**
 * Commit the resolver's staged resolution, or accept the merge commit a
 * resolver wrote itself (`git/commits.ts` explains the shape it recognizes).
 * Like `commitChangesActor`, a commit git has begun cannot be recalled, so the
 * abort is honored only before staging starts.
 */
export const commitResolutionActor = fromPromise<
  CommitResolutionOutput,
  CommitResolutionInput
>(async ({ input, signal }) => {
  const { commitMergeResolution } = await import("@/lib/git/commits");
  if (signal.aborted) {
    throw new Error(
      `Commit in ${input.worktreePath} was stopped before it started`,
    );
  }
  return commitMergeResolution(
    input.worktreePath,
    input.targetBranch,
    input.message,
    { skipHooks: true },
  );
});

/** Resolve merge conflicts via the conversation actor. */
export const resolveConflictsActor = fromPromise<
  ResolveConflictsOutput,
  ResolveConflictsInput
>(async ({ input, signal }) => {
  const { resolveConflicts } =
    await import("@/lib/sessions/conflict-resolution");
  const conversationId =
    input.conversationId ??
    (await resolveSessionConversationId(input.projectPath, input.sessionName));
  // Returned as-is: the resolver's outcome IS the actor's contract, so a
  // future variant there is a compile error here rather than a lost branch.
  return resolveConflicts({
    worktreePath: input.worktreePath,
    projectPath: input.projectPath,
    sessionName: input.sessionName,
    conversationId,
    conflictFiles: input.conflictFiles,
    decisions: input.decisions,
    resolutionContext: input.resolutionContext,
    targetBranch: input.targetBranch,
    resolutionTimeoutMs: input.resolutionTimeoutMs,
    // Stopping this state must stop the agent turn it started; without the
    // signal the LLM keeps writing into a worktree the machine has left.
    signal,
  });
});

/** Analyze merge conflicts without resolving them. */
export const analyzeConflictsActor = fromPromise<
  AnalyzeConflictsOutput,
  AnalyzeConflictsInput
>(async ({ input, signal }) => {
  const { analyzeConflicts } =
    await import("@/lib/sessions/conflict-resolution");
  const conversationId =
    input.conversationId ??
    (await resolveSessionConversationId(input.projectPath, input.sessionName));
  return analyzeConflicts({
    worktreePath: input.worktreePath,
    projectPath: input.projectPath,
    sessionName: input.sessionName,
    conversationId,
    resolutionContext: input.resolutionContext,
    targetBranch: input.targetBranch,
    resolutionTimeoutMs: input.resolutionTimeoutMs,
    signal,
  });
});

// ============================================================
// prepareActor / publishActor — split squash-merge pipeline
// ============================================================

export interface PrepareActorDeps {
  prepareSquashMerge(input: PrepareSquashMergeInput): Promise<PrepareResult>;
  revParse(cwd: string, ref: string): Promise<string>;
}

/** Pure inner runner — call directly in tests and from the actor factory. */
export async function runPrepare(
  deps: PrepareActorDeps,
  input: PrepareActorInput,
): Promise<PrepareActorOutput> {
  const expectedTargetSha = (
    await deps.revParse(input.projectPath, `refs/heads/${input.targetBranch}`)
  ).trim();
  const featureSha = (await deps.revParse(input.worktreePath, "HEAD")).trim();

  const result = await deps.prepareSquashMerge({
    projectPath: input.projectPath,
    featureBranch: input.branchName,
    featureSha,
    targetBranch: input.targetBranch,
    targetSha: expectedTargetSha,
    message: input.message,
    jobId: input.jobId,
    forcePath: input.forcePath,
  });

  if (result.kind === "prepared") {
    return {
      status: "prepared",
      preparedSha: result.preparedSha,
      expectedTargetSha: result.expectedTargetSha,
      parkedRef: result.parkedRef,
    };
  }

  if (result.kind === "up-to-date") {
    return {
      status: "up-to-date",
      expectedTargetSha: result.expectedTargetSha,
    };
  }

  return {
    status: "conflicts",
    expectedTargetSha: result.expectedTargetSha,
    conflictFiles: result.conflictFiles,
  };
}

export function createPrepareActor(deps: PrepareActorDeps) {
  return fromPromise<PrepareActorOutput, PrepareActorInput>(async ({ input }) =>
    runPrepare(deps, input),
  );
}

export interface PublishActorDeps {
  discoverTargetCheckout(
    projectPath: string,
    targetBranch: string,
  ): Promise<TargetCheckoutState>;
  publishPreparedMerge(
    input: PublishPreparedMergeInput,
  ): Promise<PublishResult>;
  acquireProjectLock: AcquireProjectLockOptions["acquireProjectLock"];
  runSessionLifecycleOperation<T>(
    projectPath: string,
    sessionName: string,
    operation: () => Promise<T>,
  ): Promise<T>;
  setSessionFinished(projectPath: string, sessionName: string): Promise<void>;
  /**
   * The delivery gate reads tenure, not status, so this must surface the halt
   * reason and abandonment too: a status alone cannot tell a resumable halt
   * (still holding the lease) from a non-resumable or abandoned one (which
   * holds nothing and must not block the merge). `definitionApproval` rides
   * along so the refusal can name the canonical remedy for the blocker's own
   * state.
   */
  getActiveGraphWorkflowExecution(
    projectPath: string,
    sessionName: string,
  ): Promise<Pick<
    GraphWorkflowExecution,
    "id" | "status" | "haltReason" | "abandonment" | "definitionApproval"
  > | null>;
  reconcileTicketSessionLifecycle(input: {
    projectPath: string;
    sessionName: string;
    endReason: "finished";
  }): Promise<void>;
  /**
   * Session completion's memory step (memory spec R10): state notes archive
   * and durable session notes become promotion candidates. It runs after the
   * finished row is written, because candidacy is derived from that row.
   */
  finalizeSessionMemory(input: {
    projectPath: string;
    sessionName: string;
  }): Promise<void>;
  retargetOrphanedChildren(
    projectPath: string,
    sessionName: string,
  ): Promise<void>;
  stopAllForSession(args: {
    projectPath: string;
    sessionName: string;
  }): Promise<void>;
  maxLockWaitMs?: number;
  retryMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

async function finalizeSessionSideEffects(
  deps: PublishActorDeps,
  projectPath: string,
  sessionName: string,
): Promise<void> {
  try {
    await deps.stopAllForSession({ projectPath, sessionName });
  } catch (err) {
    logger.warn("publishActor.stop_dev_servers_failed", {
      projectPath,
      sessionName,
      err: getErrorMessage(err),
    });
  }

  await deps.runSessionLifecycleOperation(
    projectPath,
    sessionName,
    async () => {
      await deps.setSessionFinished(projectPath, sessionName);
      try {
        await deps.reconcileTicketSessionLifecycle({
          projectPath,
          sessionName,
          endReason: "finished",
        });
      } catch (err) {
        logger.warn("publishActor.ticket_lifecycle_reconcile_failed", {
          projectPath,
          sessionName,
          err: err instanceof Error ? err.message : String(err),
        });
      }
      try {
        await deps.finalizeSessionMemory({ projectPath, sessionName });
      } catch (err) {
        // Never fails the merge: the memory step is bookkeeping, and the work
        // is recoverable. `finishSession` reconciles every over incarnation of
        // the project, so the next completion here archives what this one lost.
        logger.warn("publishActor.session_memory_finalize_failed", {
          projectPath,
          sessionName,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    },
  );
  await deps.retargetOrphanedChildren(projectPath, sessionName);
}

export async function runPublish(
  deps: PublishActorDeps,
  input: PublishActorInput,
): Promise<PublishActorOutput> {
  // A no-op merge never writes to the target, so the checkout's state cannot
  // decide anything: there is nothing to reset into it and nothing to park.
  if (input.upToDate !== true) {
    const discovery = await deps.discoverTargetCheckout(
      input.projectPath,
      input.targetBranch,
    );

    if (discovery.kind === "dirty") {
      return {
        status: "ready-to-land",
        parkedRef: input.parkedRef,
        preparedSha: input.preparedSha,
        targetWorktreePath: discovery.worktreePath,
      };
    }
  }

  const release = await acquireProjectLockWithRetry({
    acquireProjectLock: deps.acquireProjectLock,
    projectPath: input.projectPath,
    maxWaitMs: deps.maxLockWaitMs,
    retryMs: deps.retryMs,
    sleep: deps.sleep,
    callerLabel: "publish",
  });

  try {
    if (input.finalizeSession) {
      const deliveryDecision = evaluateGraphWorkflowSessionDelivery(
        await deps.getActiveGraphWorkflowExecution(
          input.projectPath,
          input.sessionName,
        ),
      );
      if (!deliveryDecision.allowed) {
        logger.warn("publishActor.active_graph_workflow_refused", {
          projectPath: input.projectPath,
          sessionName: input.sessionName,
          executionId: deliveryDecision.executionId,
          workflowStatus: deliveryDecision.status,
          remedy: deliveryDecision.remedy,
        });
        return { status: "failed", error: deliveryDecision.message };
      }
    }

    if (input.upToDate === true) {
      if (input.finalizeSession) {
        await finalizeSessionSideEffects(
          deps,
          input.projectPath,
          input.sessionName,
        );
      }
      logger.info("publishActor.up_to_date", {
        projectPath: input.projectPath,
        sessionName: input.sessionName,
        targetBranch: input.targetBranch,
        finalizeSession: input.finalizeSession,
      });
      return { status: "up-to-date" };
    }

    // The pre-lock reading only decided whether to queue for the lock. A
    // publish resets the target checkout, so the reading that authorizes it
    // has to be taken here, inside the window nothing else can write in.
    const lockedDiscovery = await deps.discoverTargetCheckout(
      input.projectPath,
      input.targetBranch,
    );

    if (lockedDiscovery.kind === "dirty") {
      return {
        status: "ready-to-land",
        parkedRef: input.parkedRef,
        preparedSha: input.preparedSha,
        targetWorktreePath: lockedDiscovery.worktreePath,
      };
    }

    const result = await deps.publishPreparedMerge({
      projectPath: input.projectPath,
      targetBranch: input.targetBranch,
      preparedSha: input.preparedSha,
      expectedTargetSha: input.expectedTargetSha,
      parkedRef: input.parkedRef,
      cleanTargetWorktreePath:
        lockedDiscovery.kind === "clean" ? lockedDiscovery.worktreePath : null,
    });

    if (result.kind === "cas-lost") {
      return {
        status: "cas-lost",
        actualTargetSha: result.actualTargetSha,
      };
    }

    if (result.kind === "publish-failed") {
      return { status: "failed", error: result.error };
    }

    if (input.finalizeSession) {
      await finalizeSessionSideEffects(
        deps,
        input.projectPath,
        input.sessionName,
      );
    }

    return result.refreshWarning === undefined
      ? { status: "completed", mergeHash: result.mergeHash }
      : {
          status: "completed",
          mergeHash: result.mergeHash,
          refreshWarning: result.refreshWarning,
        };
  } finally {
    release();
  }
}

export function createPublishActor(deps: PublishActorDeps) {
  return fromPromise<PublishActorOutput, PublishActorInput>(async ({ input }) =>
    runPublish(deps, input),
  );
}

// ============================================================
// discardParkedRefActor — used by the discard entry path
// ============================================================

export interface DiscardParkedRefInput {
  projectPath: string;
  parkedRef: string;
  preparedSha: string;
}
export type DiscardParkedRefOutput = void;

export interface DiscardParkedRefDeps {
  deleteParkedRef(
    projectPath: string,
    parkedRef: string,
    preparedSha: string,
  ): Promise<void>;
}

export async function runDiscardParkedRef(
  deps: DiscardParkedRefDeps,
  input: DiscardParkedRefInput,
): Promise<DiscardParkedRefOutput> {
  await deps.deleteParkedRef(
    input.projectPath,
    input.parkedRef,
    input.preparedSha,
  );
}

export function createDiscardParkedRefActor(deps: DiscardParkedRefDeps) {
  return fromPromise<DiscardParkedRefOutput, DiscardParkedRefInput>(
    async ({ input }) => runDiscardParkedRef(deps, input),
  );
}

export const discardParkedRefActor = fromPromise<
  DiscardParkedRefOutput,
  DiscardParkedRefInput
>(async ({ input }) => {
  const { defaultGitClient } = await import("@/lib/git/client");
  return runDiscardParkedRef(
    {
      async deleteParkedRef(projectPath, parkedRef, preparedSha) {
        await defaultGitClient.git(
          ["update-ref", "-d", parkedRef, preparedSha],
          projectPath,
        );
      },
    },
    input,
  );
});

/** Default singleton wired to real implementations via lazy dynamic imports. */
export const prepareActor = fromPromise<PrepareActorOutput, PrepareActorInput>(
  async ({ input }) => {
    const { prepareSquashMerge } = await import("@/lib/git/worktree");
    const { defaultGitClient } = await import("@/lib/git/client");
    const { readRepoConfig } = await import("@/lib/projects/repo-config");

    let forcePath = input.forcePath;
    if (!forcePath) {
      try {
        const repoConfig = await readRepoConfig(input.projectPath);
        forcePath = repoConfig?.preMergePreparePath;
      } catch {
        // Best-effort: fall through to git --version auto-detect
      }
    }

    return runPrepare(
      {
        prepareSquashMerge,
        async revParse(cwd, ref) {
          const { stdout } = await defaultGitClient.git(
            ["rev-parse", ref],
            cwd,
          );
          return stdout;
        },
      },
      { ...input, forcePath },
    );
  },
);

export const publishActor = fromPromise<PublishActorOutput, PublishActorInput>(
  async ({ input }) => {
    const { discoverTargetCheckout, publishPreparedMerge } =
      await import("@/lib/git/worktree");
    const { acquireProjectLock } = await import("@/lib/prompt/single-flight");
    const { getSessionLifecycleGate } =
      await import("@/lib/sessions/lifecycle-gate");
    const { getActiveGraphWorkflowExecution, setSessionFinished } =
      await import("@/lib/state-store");
    const { stopAllForSession } = await import("@/lib/dev-server/registry");
    const { retargetOrphanedChildren } = await import("@/lib/sessions/service");
    const { reconcileTicketSessionLifecycle } =
      await import("@/lib/tickets/lifecycle");
    const { finalizeSessionMemory } = await import("@/lib/memory/session-end");

    return runPublish(
      {
        discoverTargetCheckout,
        publishPreparedMerge,
        acquireProjectLock,
        runSessionLifecycleOperation: (projectPath, sessionName, operation) =>
          getSessionLifecycleGate().runExclusive(
            projectPath,
            sessionName,
            operation,
          ),
        setSessionFinished,
        getActiveGraphWorkflowExecution,
        reconcileTicketSessionLifecycle,
        finalizeSessionMemory,
        retargetOrphanedChildren,
        stopAllForSession,
      },
      input,
    );
  },
);
