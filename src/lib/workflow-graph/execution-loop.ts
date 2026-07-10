import { randomUUID } from "node:crypto";
import path from "node:path";
import { getErrorMessage } from "@/lib/shared/errors";
import { getConfiguredQueryConcurrency as defaultGetMaxConcurrentQueries } from "@/lib/shared/query-semaphore";
import { captureTraceContext, createLogger, runAsTrace } from "@/lib/logging";
import { getExecutionLogger } from "@/lib/workflow-graph/execution-logger";
import { AgentTurnFailedError, toHaltReason, type DirtyPath } from "./errors";
import {
  runCircuitBreakerGate as defaultRunCircuitBreakerGate,
  type CircuitBreakerGateResult,
  type RunCircuitBreakerGateInput,
} from "@/lib/workflows/primitives/circuit-breaker-gate";
import {
  acquireConversationLock as defaultAcquireConversationLock,
  isConversationBusy as defaultIsConversationBusy,
} from "@/lib/prompt/single-flight";
import {
  createApprovalGateService,
  type ApprovalGateService,
} from "@/lib/workflow-graph/approval-gate";
import {
  createUserInputGateService,
  type ConsumeAnswersResult,
  type ResumeUserInputContext,
  type UserInputGateService,
} from "@/lib/workflow-graph/user-input-gate";
import { sendConversationEvent } from "@/lib/workflows/conversation/manager";
import { createGraphWorkflowExecutionEventPublisher } from "@/lib/workflow-graph/execution-events";
import type {
  ExecutionTargetResolver,
  ExecutionTarget,
} from "@/lib/workflow-graph/execution-target-resolver";
import type { ParallelWorktrees } from "@/lib/workflow-graph/parallel-worktrees";
import type { PerSessionMergeMutex } from "@/lib/workflow-graph/per-session-merge-mutex";
import type { SessionGitLock } from "@/lib/workflow-graph/session-git-lock";
import type { GraphMergeRunner } from "@/lib/workflow-graph/graph-merge-runner";
import type { SoloContextCommitter } from "@/lib/workflow-graph/solo-context-committer";
import {
  applyLaneCommitSnapshot,
  type LaneCommitter,
} from "@/lib/workflow-graph/lane-committer";
import type { JoinRunner } from "@/lib/workflow-graph/join-runner";
import { classifyContextSchedulability } from "@/lib/workflow-graph/lane-readiness";
import { getEligibleContextIds } from "@/lib/workflow-graph/validation";
import {
  SESSION_LANE_ID,
  appendPendingJoin,
  findActiveJoin,
  materializeSessionLane,
  planContextJoin,
  planFinalPublishJoin,
} from "@/lib/workflow-graph/lane-join";
import type { SessionState } from "@/lib/sessions/schemas";
import type {
  GraphWorkflowApprovalDecision,
  GraphWorkflowExecution,
  GraphWorkflowHaltReason,
  GraphWorkflowStatus,
} from "@/lib/workflows/schemas";
import { DEFAULT_CONSECUTIVE_FAILURE_THRESHOLD } from "./constants";
import {
  StaleLoopFenceError,
  matchesLoopFence,
  runWithLoopFence,
  type GraphWorkflowLoopFence,
} from "./loop-fence";
import {
  hasPartialIterationProgress,
  IterationFailureWithProgressError,
} from "./iteration-failure-with-progress";
import type { GraphWorkflowIterationResult } from "./iteration-orchestrator";
import type { MutateActiveResult } from "./execution-repository";
import type {
  GraphWorkflowLifecycleSnapshot,
  RecordPendingHaltReasonResult,
  ScheduleEligibleContextsResult,
} from "./workflow-manager";

export interface GraphWorkflowExecutionLoopInput {
  projectPath: string;
  projectName: string;
  sessionName: string;
  execution: GraphWorkflowExecution;
  /**
   * Opt-in flag for session-lane participation (accepted design decision 10).
   * Defaults to `false` — every parallel chain runs on its own worktree lane
   * and is converged onto the session branch only at final publish. Callers
   * that have validated dirty-worktree/concurrent-job preconditions can pass
   * `true` to allow solo contexts to execute directly in the session worktree.
   */
  sessionLaneEnabled?: boolean;
}

export interface GraphWorkflowExecutionLoopWorkflowManager {
  scheduleEligibleContexts(input: {
    projectPath: string;
    sessionName: string;
    sessionLaneEnabled?: boolean;
    capacityRemaining?: number;
  }): Promise<ScheduleEligibleContextsResult>;
  send(
    projectPath: string,
    sessionName: string,
    event: { type: "complete" },
  ): Promise<GraphWorkflowExecution>;
  recordPendingHaltReason(input: {
    projectPath: string;
    sessionName: string;
    reason: GraphWorkflowHaltReason;
    applyAdditionalMutation?(execution: GraphWorkflowExecution): void;
  }): Promise<RecordPendingHaltReasonResult>;
  drainAndHalt(input: {
    projectPath: string;
    sessionName: string;
  }): Promise<GraphWorkflowExecution>;
  mutateActive(
    projectPath: string,
    sessionName: string,
    fn: (
      execution: GraphWorkflowExecution,
    ) =>
      | MutateActiveResult
      | GraphWorkflowExecution
      | Promise<MutateActiveResult | GraphWorkflowExecution>,
  ): Promise<GraphWorkflowExecution>;
  getActive(
    projectPath: string,
    sessionName: string,
  ): Promise<GraphWorkflowExecution | null>;
  recoverRetryableIterationError?(
    projectPath: string,
    sessionName: string,
    input: { contextId: string; errorMessage: string },
  ): Promise<GraphWorkflowExecution>;
}

interface GraphWorkflowExecutionLoopIterationOrchestrator {
  runIteration(input: {
    projectPath: string;
    projectName: string;
    sessionName: string;
    contextId: string;
    executionTarget?: ExecutionTarget;
    resumeUserInput?: ResumeUserInputContext;
  }): Promise<GraphWorkflowIterationResult>;
}

export interface GraphWorkflowExecutionLoopDeps {
  workflowManager: GraphWorkflowExecutionLoopWorkflowManager;
  iterationOrchestrator: GraphWorkflowExecutionLoopIterationOrchestrator;
  parallelWorktrees: ParallelWorktrees;
  mergeMutex: PerSessionMergeMutex;
  sessionGitLock: SessionGitLock;
  mergeRunner: GraphMergeRunner;
  soloContextCommitter: SoloContextCommitter;
  laneCommitter: LaneCommitter;
  joinRunner: JoinRunner;
  executionTargetResolver: ExecutionTargetResolver;
  getSession(
    projectPath: string,
    sessionName: string,
  ): Promise<SessionState | null>;
  /**
   * Optional override for the shared circuit-breaker gate primitive. The loop
   * routes the per-context "consecutive failures hit threshold" decision
   * through `runCircuitBreakerGate` so the halt vocabulary stays unified with
   * the iteration-orchestrator's gate-based circuit breaker.
   */
  runCircuitBreakerGate?: (
    input: RunCircuitBreakerGateInput,
  ) => CircuitBreakerGateResult;
  /**
   * Resolve the current SDK query-concurrency limit. The loop bounds each
   * parallel scheduling pass to `limit - inFlight.size` so a single execution
   * never schedules more concurrent contexts than the global query semaphore
   * can admit (which would otherwise leave the surplus queued until they hit
   * the semaphore's acquisition timeout). Defaults to the semaphore's
   * configured limit.
   */
  getMaxConcurrentQueries?: () => Promise<number>;
  createJobId?: () => string;
  /**
   * Read tracked dirty paths from the session worktree. Used by the pre-batch
   * preflight to halt before scheduling worktree-isolation contexts whose
   * fan-in merge would inevitably fail. Default returns [] (clean), keeping
   * existing tests unchanged.
   */
  getSessionWorktreeDirtyPaths?: (input: {
    sessionWorktreePath: string;
  }) => Promise<DirtyPath[]>;
  waitForCollaborationProgress?: (input: {
    projectPath: string;
    sessionName: string;
    executionId: string;
  }) => Promise<void>;
  /**
   * Poll interval for the approval-gate wait, mirroring the collaboration
   * wait. The loop refreshes execution state after each call until a
   * recorded decision is observed or the execution leaves the running
   * state. Default waits ~1s. Also paces the busy-conversation probe while
   * decision application waits for the conversation lock to free.
   */
  waitForApprovalProgress?(input: {
    projectPath: string;
    sessionName: string;
    executionId: string;
    contextId: string;
  }): Promise<void>;
  /**
   * Approval-gate service whose draft-level apply methods run inside the
   * loop's decision-application mutation. Defaults to a service backed by
   * the workflow manager's mutateActive.
   */
  approvalGateService?: ApprovalGateService;
  /**
   * Poll interval for the user-input-gate wait, mirroring the approval gate's
   * cadence. The loop refreshes execution state after each call until answers
   * are recorded on the parked record, the record is withdrawn, or the
   * execution leaves the running state. Defaults to the same ~1s wait as the
   * approval gate so a parked question polls at the identical rhythm.
   */
  waitForUserInputProgress?(input: {
    projectPath: string;
    sessionName: string;
    executionId: string;
    contextId: string;
  }): Promise<void>;
  /**
   * User-input-gate service. The loop consumes recorded answers on resume and
   * withdraws all parked questions on abort through it. Defaults to a service
   * backed by the workflow manager's mutateActive/getActive, the event
   * publisher, and the conversation-machine dispatch.
   */
  userInputGateService?: UserInputGateService;
  /**
   * Publisher for the approval-resolved history/SSE event emitted after a
   * decision is applied.
   */
  eventPublisher?: ReturnType<
    typeof createGraphWorkflowExecutionEventPublisher
  >;
  /**
   * Conversation single-flight lock probes for the decision-application
   * quiescence rule: the loop probes `isConversationBusy` on the wait
   * interval and acquires once free, holding the lock across the approved
   * merge or rejected remediation seeding. Default to the shared
   * single-flight lock manager.
   */
  isConversationBusy?(
    projectPath: string,
    sessionName: string,
    conversationId: string,
  ): boolean;
  acquireConversationLock?(
    projectPath: string,
    sessionName: string,
    conversationId: string,
  ): () => void;
}

// -- Active loop registry -----------------------------------------------------

// Keyed by session, valued by the OWNING loop instance's token. Two loop
// instances can briefly overlap on one session (a stale generation still
// draining while its successor registers); the newest registrant owns the
// entry, and an exiting loop only deletes it if it still owns it — otherwise
// a stale loop's exit would make the session look loop-free while the live
// loop is still running.
const activeLoops = new Map<string, string>();

function loopKey(projectPath: string, sessionName: string): string {
  return `${projectPath}::${sessionName}`;
}

/** Check if an execution loop is currently running for the given session. */
export function isExecutionLoopActive(
  projectPath: string,
  sessionName: string,
): boolean {
  return activeLoops.has(loopKey(projectPath, sessionName));
}

/** Reset the active loop registry (for testing only). */
export function _resetActiveLoopsForTesting(): void {
  activeLoops.clear();
}

// -- Helpers ------------------------------------------------------------------

function isRetryableIterationError(error: unknown): boolean {
  return /stream closed|querysession (died|is dead|ended before)|processtransport is not ready for writing/i.test(
    getErrorMessage(error),
  );
}

/**
 * An implementer turn that failed because its prompt was aborted. The
 * orchestrator wraps a mid-iteration failure in
 * IterationFailureWithProgressError when earlier turns completed, so unwrap
 * before inspecting the cause.
 */
function isAbortCausedTurnFailure(error: unknown): boolean {
  const unwrapped =
    error instanceof IterationFailureWithProgressError
      ? error.originalError
      : error;
  return (
    unwrapped instanceof AgentTurnFailedError && unwrapped.cause === "abort"
  );
}

function hasPendingCollaborations(execution: GraphWorkflowExecution): boolean {
  return Object.keys(execution.pendingCollaborations ?? {}).length > 0;
}

function hasAwaitingApprovalContexts(
  execution: GraphWorkflowExecution,
): boolean {
  return Object.values(execution.contextStates).some(
    (contextState) => contextState.status === "awaiting_approval",
  );
}

function hasAwaitingUserInputContexts(
  execution: GraphWorkflowExecution,
): boolean {
  return Object.values(execution.contextStates).some(
    (contextState) => contextState.status === "awaiting_user_input",
  );
}

async function defaultWaitForCollaborationProgress(_input: {
  projectPath: string;
  sessionName: string;
  executionId: string;
}): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 1000));
}

async function defaultWaitForApprovalProgress(_input: {
  projectPath: string;
  sessionName: string;
  executionId: string;
  contextId: string;
}): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 1000));
}

async function defaultWaitForUserInputProgress(_input: {
  projectPath: string;
  sessionName: string;
  executionId: string;
  contextId: string;
}): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 1000));
}

/**
 * Mirrors the lifecycle snapshot the iteration orchestrator's finalization
 * mutations maintain. Decision application rebuilds it the same way the
 * gate-off completion path would have; there is never a live iteration at
 * application time.
 */
function buildMachineSnapshot(
  execution: GraphWorkflowExecution,
): GraphWorkflowLifecycleSnapshot {
  return {
    schemaVersion: 1,
    lifecycleStatus: execution.status,
    activeContextId: execution.activeContextIds[0] ?? null,
    recoveryMode: "none",
    hasLiveIteration: false,
  };
}

/**
 * Outcome of the approval-gate wait: the operator's recorded decision was
 * observed (the decision-application path consumes it), a halt is pending and
 * the wait exited so the drain can settle (the parked record, including any
 * recorded decision, persists and the gate re-engages on resume), or the
 * execution left the running state and the wait exited without resolving —
 * the pending record, including any recorded decision, persists untouched.
 */
type ApprovalWaitOutcome =
  | { kind: "decision"; decision: GraphWorkflowApprovalDecision }
  | { kind: "halt_pending" }
  | {
      kind: "execution_exited";
      status: Exclude<GraphWorkflowStatus, "running">;
    };

/**
 * Outcome of the user-input-gate wait: answers were recorded on the parked
 * record (the resume path consumes them), the record was withdrawn out from
 * under the wait (abort raced — the context is no longer parked), a halt is
 * pending and the wait exited so the drain can settle (the record persists
 * and the gate re-engages on resume), or the execution left the running
 * state and the wait exited without resolving (the record persists for
 * resume on re-entry).
 */
type UserInputWaitOutcome =
  | { kind: "answers" }
  | { kind: "withdrawn" }
  | { kind: "halt_pending" }
  | {
      kind: "execution_exited";
      status: Exclude<GraphWorkflowStatus, "running">;
    };

/**
 * Outcome of the conversation-lock deferral: either the lock was acquired,
 * or the execution left the running state while deferring and the runner
 * exits without applying — the pending record, including the recorded
 * decision, persists for application on the first wait refresh after resume.
 */
type ConversationLockOutcome =
  | { kind: "acquired"; release(): void }
  | {
      kind: "execution_exited";
      status: Exclude<GraphWorkflowStatus, "running">;
    };

/**
 * Outcome of the decision-application mutation: applied, or the execution
 * was observed outside the running state inside the mutation (a pause, halt,
 * or abort raced the application) and the execution was left untouched.
 */
type ApprovalApplicationOutcome =
  | { applied: true }
  | {
      applied: false;
      status: Exclude<GraphWorkflowStatus, "running">;
    };

// -- Execution loop -----------------------------------------------------------

const logger = createLogger("graph-workflow-execution-loop");

export function createGraphWorkflowExecutionLoop(
  deps: GraphWorkflowExecutionLoopDeps,
) {
  const runCircuitBreakerGate =
    deps.runCircuitBreakerGate ?? defaultRunCircuitBreakerGate;
  const getMaxConcurrentQueries =
    deps.getMaxConcurrentQueries ?? defaultGetMaxConcurrentQueries;
  const createJobId = deps.createJobId ?? (() => randomUUID());
  const approvalGateService =
    deps.approvalGateService ??
    createApprovalGateService({
      mutateActive: (projectPath, sessionName, fn) =>
        deps.workflowManager.mutateActive(projectPath, sessionName, fn),
      now: () => new Date().toISOString(),
    });
  const eventPublisher =
    deps.eventPublisher ?? createGraphWorkflowExecutionEventPublisher();
  const userInputGateService =
    deps.userInputGateService ??
    createUserInputGateService({
      getActive: (projectPath, sessionName) =>
        deps.workflowManager.getActive(projectPath, sessionName),
      mutateActive: (projectPath, sessionName, fn) =>
        deps.workflowManager.mutateActive(projectPath, sessionName, fn),
      publishUserInputPending: eventPublisher.publishUserInputPending,
      publishUserInputResolved: eventPublisher.publishUserInputResolved,
      sendConversationEvent,
      now: () => new Date().toISOString(),
    });
  const isConversationBusy =
    deps.isConversationBusy ?? defaultIsConversationBusy;
  const acquireConversationLock =
    deps.acquireConversationLock ?? defaultAcquireConversationLock;

  function run(
    input: GraphWorkflowExecutionLoopInput,
  ): Promise<GraphWorkflowExecution> {
    // Pin this loop instance to the generation it was started for. The fence
    // rides AsyncLocalStorage into everything the loop awaits — iterations,
    // validators, committers, and every repository mutation — so a stale
    // instance is rejected at the write path even while blocked in an await
    // it entered before being superseded.
    const fence: GraphWorkflowLoopFence = {
      projectPath: input.projectPath,
      sessionName: input.sessionName,
      executionId: input.execution.id,
      loopEpoch: input.execution.loopEpoch,
    };
    return runAsTrace(
      `workflow:${input.execution.id}`,
      () => runWithLoopFence(fence, () => runImpl(input, fence)),
      captureTraceContext(),
    );
  }

  async function runImpl(
    input: GraphWorkflowExecutionLoopInput,
    fence: GraphWorkflowLoopFence,
  ): Promise<GraphWorkflowExecution> {
    const key = loopKey(input.projectPath, input.sessionName);
    const loopInstanceToken = randomUUID();
    activeLoops.set(key, loopInstanceToken);
    let execution = input.execution;
    const retryableRecoveryAttempts = new Map<string, number>();
    // Answers consumed on the awaiting-user-input resume path, keyed by context.
    // Stashed before `continue` re-schedules the context, then drained into the
    // next `runIteration` call so the resumed turn pins the asking conversation
    // and embeds the answers block. Deleted on drain — one resume.
    const pendingResumeUserInput = new Map<string, ConsumeAnswersResult>();
    const inFlight = new Map<string, Promise<void>>();
    const maxConcurrency = await getMaxConcurrentQueries();
    const execLogger = getExecutionLogger(execution.id);

    execLogger?.lifecycle("loop.started", {
      executionId: execution.id,
      activeContextIds: execution.activeContextIds,
    });
    logger.info("graph-workflow.loop.started", {
      executionId: execution.id,
    });

    async function recordHalt(reason: GraphWorkflowHaltReason): Promise<void> {
      const result = await deps.workflowManager.recordPendingHaltReason({
        projectPath: input.projectPath,
        sessionName: input.sessionName,
        reason,
      });
      execution = result.execution;
    }

    /**
     * Adopt an execution snapshot only if it still belongs to this loop's
     * generation. `getActive` is keyed by session, not execution, so after an
     * abort/replace or a halt/resume the session's active state belongs to a
     * successor generation — adopting it would turn this loop into a second,
     * unaccounted driver of state it does not own (the incident-622782a0
     * zombie). Staleness throws; the loop's error handling exits silently.
     */
    function adoptExecution(next: GraphWorkflowExecution | null): void {
      if (next === null || !matchesLoopFence(fence, next)) {
        throw new StaleLoopFenceError(fence, next);
      }
      execution = next;
    }

    /** Refresh from the session's active execution, fence-checked. */
    async function refreshExecution(): Promise<void> {
      adoptExecution(
        await deps.workflowManager.getActive(
          input.projectPath,
          input.sessionName,
        ),
      );
    }

    async function waitForPendingCollaborationProgress(): Promise<void> {
      const pendingWorkflowIds = Object.values(
        execution.pendingCollaborations ?? {},
      ).map((pending) => pending.workflowId);
      execLogger?.lifecycle("collaboration.waiting", {
        pendingWorkflowIds,
      });
      logger.info("graph-workflow.collaboration.waiting", {
        executionId: execution.id,
        pendingWorkflowIds,
      });

      await (
        deps.waitForCollaborationProgress ?? defaultWaitForCollaborationProgress
      )({
        projectPath: input.projectPath,
        sessionName: input.sessionName,
        executionId: execution.id,
      });

      await refreshExecution();
    }

    /**
     * Parks the context runner while its approval gate is pending. Polls via
     * the injected wait and refreshes execution state until the operator's
     * decision is recorded, a halt is recorded (drain window — the wait exits
     * so the in-flight runner settles and the drain-then-halt path can
     * complete; a decision recorded meanwhile is not applied until after
     * resume), or the execution leaves the running state (pause/halt/abort),
     * in which case the wait exits without resolving and the pending record —
     * including any decision recorded meanwhile — persists for resume.
     */
    async function waitForApprovalResolution(
      contextId: string,
    ): Promise<ApprovalWaitOutcome> {
      execLogger?.iteration(contextId, "gate.waiting", {
        conversationId:
          execution.contextStates[contextId]?.pendingApproval?.conversationId ??
          null,
      });
      logger.info("graph-workflow.gate.waiting", {
        executionId: execution.id,
        contextId,
      });

      // eslint-disable-next-line no-constant-condition
      while (true) {
        const status = execution.status;
        if (status !== "running") {
          execLogger?.iteration(contextId, "gate.wait_exit", {
            cause: status,
          });
          logger.info("graph-workflow.gate.wait_exit", {
            executionId: execution.id,
            contextId,
            cause: status,
          });
          return { kind: "execution_exited", status };
        }

        if (execution.pendingHaltReason !== null) {
          execLogger?.iteration(contextId, "gate.wait_exit", {
            cause: "halt_pending",
            haltReasonType: execution.pendingHaltReason.type,
          });
          logger.info("graph-workflow.gate.wait_exit", {
            executionId: execution.id,
            contextId,
            cause: "halt_pending",
            haltReasonType: execution.pendingHaltReason.type,
          });
          return { kind: "halt_pending" };
        }

        const decision =
          execution.contextStates[contextId]?.pendingApproval?.decision ?? null;
        if (decision !== null) {
          execLogger?.iteration(contextId, "gate.wait_exit", {
            cause: "decision_observed",
            decisionType: decision.type,
          });
          logger.info("graph-workflow.gate.wait_exit", {
            executionId: execution.id,
            contextId,
            cause: "decision_observed",
            decisionType: decision.type,
          });
          return { kind: "decision", decision };
        }

        await (deps.waitForApprovalProgress ?? defaultWaitForApprovalProgress)({
          projectPath: input.projectPath,
          sessionName: input.sessionName,
          executionId: execution.id,
          contextId,
        });

        await refreshExecution();
      }
    }

    /**
     * Parks the context runner while its user-input gate is pending. Mirrors
     * `waitForApprovalResolution`: polls via the injected wait and refreshes
     * execution state until answers are recorded on the parked record (resume),
     * the record disappears (withdrawn — abort raced), a halt is recorded
     * (drain window — the wait exits so the drain-then-halt path can complete;
     * answers recorded meanwhile are consumed after resume), or the execution
     * leaves the running state (the record persists for resume on re-entry).
     * The answers-present check at the top short-circuits, so a context
     * re-entered with answers already recorded (recorded while paused) applies
     * immediately without a wait poll (Req 7.3).
     */
    async function waitForUserInputResolution(
      contextId: string,
    ): Promise<UserInputWaitOutcome> {
      execLogger?.iteration(contextId, "user_input.waiting", {
        conversationId:
          execution.contextStates[contextId]?.pendingUserInput
            ?.conversationId ?? null,
      });
      logger.info("graph-workflow.user_input.waiting", {
        executionId: execution.id,
        contextId,
      });

      // eslint-disable-next-line no-constant-condition
      while (true) {
        const status = execution.status;
        if (status !== "running") {
          execLogger?.iteration(contextId, "user_input.wait_exit", {
            cause: status,
          });
          logger.info("graph-workflow.user_input.wait_exit", {
            executionId: execution.id,
            contextId,
            cause: status,
          });
          return { kind: "execution_exited", status };
        }

        if (execution.pendingHaltReason !== null) {
          execLogger?.iteration(contextId, "user_input.wait_exit", {
            cause: "halt_pending",
            haltReasonType: execution.pendingHaltReason.type,
          });
          logger.info("graph-workflow.user_input.wait_exit", {
            executionId: execution.id,
            contextId,
            cause: "halt_pending",
            haltReasonType: execution.pendingHaltReason.type,
          });
          return { kind: "halt_pending" };
        }

        const pending = execution.contextStates[contextId]?.pendingUserInput;
        if (!pending) {
          // The record is gone while the execution is still running: it was
          // withdrawn (abort cleanup raced this wait). The context is no
          // longer parked — return per abort semantics.
          execLogger?.iteration(contextId, "user_input.wait_exit", {
            cause: "withdrawn",
          });
          logger.info("graph-workflow.user_input.wait_exit", {
            executionId: execution.id,
            contextId,
            cause: "withdrawn",
          });
          return { kind: "withdrawn" };
        }

        if (pending.answers !== null) {
          execLogger?.iteration(contextId, "user_input.wait_exit", {
            cause: "answers_observed",
            questionBatchId: pending.questionBatchId,
          });
          logger.info("graph-workflow.user_input.wait_exit", {
            executionId: execution.id,
            contextId,
            cause: "answers_observed",
            questionBatchId: pending.questionBatchId,
          });
          return { kind: "answers" };
        }

        await (
          deps.waitForUserInputProgress ?? defaultWaitForUserInputProgress
        )({
          projectPath: input.projectPath,
          sessionName: input.sessionName,
          executionId: execution.id,
          contextId,
        });

        await refreshExecution();
      }
    }

    /**
     * Poll-acquires the conversation's single-flight lock for decision
     * application: probes on the wait interval while a chat turn is in
     * flight and acquires once free, so application (and the approved
     * path's merge) runs against a quiescent worktree. Each probe refreshes
     * execution state; when the execution leaves the running state during
     * the deferral, the runner exits without applying.
     */
    async function acquireConversationLockWhenFree(
      contextId: string,
      conversationId: string,
    ): Promise<ConversationLockOutcome> {
      let deferralLogged = false;
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const status = execution.status;
        if (status !== "running") {
          execLogger?.iteration(contextId, "gate.application_exit", {
            cause: status,
            phase: "lock_wait",
          });
          logger.info("graph-workflow.gate.application_exit", {
            executionId: execution.id,
            contextId,
            cause: status,
            phase: "lock_wait",
          });
          return { kind: "execution_exited", status };
        }

        if (
          !isConversationBusy(
            input.projectPath,
            input.sessionName,
            conversationId,
          )
        ) {
          return {
            kind: "acquired",
            release: acquireConversationLock(
              input.projectPath,
              input.sessionName,
              conversationId,
            ),
          };
        }

        if (!deferralLogged) {
          deferralLogged = true;
          execLogger?.iteration(contextId, "gate.application_deferred", {
            conversationId,
          });
          logger.info("graph-workflow.gate.application_deferred", {
            executionId: execution.id,
            contextId,
            conversationId,
          });
        }
        await (deps.waitForApprovalProgress ?? defaultWaitForApprovalProgress)({
          projectPath: input.projectPath,
          sessionName: input.sessionName,
          executionId: execution.id,
          contextId,
        });
        await refreshExecution();
      }
    }

    /**
     * Applies the operator's recorded decision in one mutation. Approved
     * clears the record and completes the context exactly as the gate-off
     * finalization would have (task counts and activeContextIds were already
     * settled when the context parked); rejected clears the record, appends
     * the remediation task, and returns the context to running. The running
     * guard runs inside the mutation so a pause, halt, or abort racing the
     * application atomically wins: the execution is left untouched and the
     * recorded decision persists for application after resume.
     */
    async function applyApprovalDecision(
      contextId: string,
      decision: GraphWorkflowApprovalDecision,
    ): Promise<ApprovalApplicationOutcome> {
      let exitedStatus: Exclude<GraphWorkflowStatus, "running"> | null = null;
      execution = await deps.workflowManager.mutateActive(
        input.projectPath,
        input.sessionName,
        (e) => {
          if (e.status !== "running") {
            exitedStatus = e.status;
            return e;
          }
          const next = structuredClone(e);
          if (decision.type === "approved") {
            approvalGateService.applyApprovedDecision(next, contextId);
            const cs = next.contextStates[contextId];
            if (cs) {
              cs.status = "completed";
            }
          } else {
            approvalGateService.applyRejectedDecision(next, contextId);
          }
          next.machineSnapshot = buildMachineSnapshot(next);
          return next;
        },
      );
      if (exitedStatus !== null) {
        execLogger?.iteration(contextId, "gate.application_exit", {
          cause: exitedStatus,
          phase: "apply",
        });
        logger.info("graph-workflow.gate.application_exit", {
          executionId: execution.id,
          contextId,
          cause: exitedStatus,
          phase: "apply",
        });
        return { applied: false, status: exitedStatus };
      }
      return { applied: true };
    }

    /**
     * Persists the approval-resolved history entry alongside the publisher's
     * SSE broadcast, after the decision-application mutation has committed.
     */
    async function publishApprovalResolvedEvent(
      contextId: string,
      conversationId: string,
      decision: GraphWorkflowApprovalDecision,
    ): Promise<void> {
      execution = await deps.workflowManager.mutateActive(
        input.projectPath,
        input.sessionName,
        (latest) => ({
          execution: latest,
          events: eventPublisher.publishApprovalResolved({
            projectPath: input.projectPath,
            sessionName: input.sessionName,
            execution: latest,
            contextId,
            conversationId,
            decision: decision.type,
            message: decision.type === "rejected" ? decision.message : null,
            decidedAt: decision.decidedAt,
          }),
        }),
      );
    }

    async function readSessionWorktreeDirtyPaths(
      sessionWorktreePath: string,
    ): Promise<DirtyPath[]> {
      if (!deps.getSessionWorktreeDirtyPaths) return [];
      try {
        return await deps.getSessionWorktreeDirtyPaths({ sessionWorktreePath });
      } catch (err) {
        logger.warn("graph-workflow.preflight.dirty_read_failed", {
          executionId: execution.id,
          sessionWorktreePath,
          error: getErrorMessage(err),
        });
        return [];
      }
    }

    async function preflightSessionWorktreeForNextBatch(): Promise<boolean> {
      const session = await deps.getSession(
        input.projectPath,
        input.sessionName,
      );
      if (!session) return false;

      const needsWorktreeBatch =
        execution.workingDefinition.executionContexts.some((ctx) => {
          const state = execution.contextStates[ctx.id];
          if (!state) return false;
          if (state.status !== "pending" && state.status !== "ready")
            return false;
          return state.isolation === "worktree";
        });
      if (!needsWorktreeBatch) return false;

      const dirty = await readSessionWorktreeDirtyPaths(session.worktreePath);
      const trackedDirty = dirty.filter((p) => p.tracked);
      if (trackedDirty.length === 0) return false;

      const firstEligibleContextId =
        execution.workingDefinition.executionContexts.find((ctx) => {
          const state = execution.contextStates[ctx.id];
          if (!state) return false;
          if (state.status !== "pending" && state.status !== "ready")
            return false;
          return state.isolation === "worktree";
        })?.id ?? "";

      const haltReason: GraphWorkflowHaltReason = {
        type: "merge_precondition_failed",
        contextId: firstEligibleContextId,
        targetBranch: session.branchName,
        dirtyPaths: trackedDirty.slice(0, 5),
        totalDirtyCount: trackedDirty.length,
        message: `Target branch '${session.branchName}' has ${trackedDirty.length} uncommitted change(s)`,
      };

      execLogger?.lifecycle("preflight.session_branch_dirty", {
        targetBranch: session.branchName,
        dirtyCount: trackedDirty.length,
        dirtyPaths: trackedDirty.slice(0, 5),
      });
      logger.info("graph-workflow.preflight.session_branch_dirty", {
        executionId: execution.id,
        targetBranch: session.branchName,
        dirtyCount: trackedDirty.length,
      });
      await recordHalt(haltReason);
      return true;
    }

    async function processPendingMergeRetry(): Promise<void> {
      while (execution.pendingMergeRetry.length > 0) {
        const contextId = execution.pendingMergeRetry[0];
        if (!contextId) break;
        const state = execution.contextStates[contextId];
        if (
          !state ||
          state.worktreePath === null ||
          state.branchName === null
        ) {
          await deps.workflowManager.mutateActive(
            input.projectPath,
            input.sessionName,
            (e) => {
              const next = structuredClone(e);
              next.pendingMergeRetry = next.pendingMergeRetry.filter(
                (id) => id !== contextId,
              );
              return next;
            },
          );
          await refreshExecution();
          continue;
        }
        execLogger?.lifecycle("merge.retry_attempted", { contextId });
        logger.info("graph-workflow.merge.retry_attempted", {
          executionId: execution.id,
          contextId,
        });
        await runFanInMerge(contextId, state.worktreePath, state.branchName);

        await refreshExecution();

        const refreshedState = execution.contextStates[contextId];
        if (refreshedState?.mergeStatus === "merged-success") {
          await deps.workflowManager.mutateActive(
            input.projectPath,
            input.sessionName,
            (e) => {
              const next = structuredClone(e);
              next.pendingMergeRetry = next.pendingMergeRetry.filter(
                (id) => id !== contextId,
              );
              return next;
            },
          );
          await refreshExecution();
          continue;
        }
        // Merge failed again — halt path is already recorded by runFanInMerge.
        return;
      }
    }

    async function runFanInMerge(
      contextId: string,
      featureWorktreePath: string,
      featureBranchName: string,
    ): Promise<void> {
      execLogger?.iteration(contextId, "merge.queued", {
        branchName: featureBranchName,
        worktreePath: featureWorktreePath,
      });
      logger.info("graph-workflow.merge.queued", {
        executionId: execution.id,
        contextId,
        branchName: featureBranchName,
      });

      await deps.mergeMutex.withMergeMutex(
        {
          projectPath: input.projectPath,
          sessionName: input.sessionName,
        },
        async () => {
          await deps.workflowManager.mutateActive(
            input.projectPath,
            input.sessionName,
            (e) => {
              const next = structuredClone(e);
              const cs = next.contextStates[contextId];
              if (cs) {
                cs.mergeStatus = "in-progress";
              }
              return next;
            },
          );

          execLogger?.iteration(contextId, "merge.started", {
            branchName: featureBranchName,
          });
          logger.info("graph-workflow.merge.started", {
            executionId: execution.id,
            contextId,
            branchName: featureBranchName,
          });

          const session = await deps.getSession(
            input.projectPath,
            input.sessionName,
          );
          if (!session) {
            const reason: GraphWorkflowHaltReason = {
              type: "merge_failure",
              contextId,
              message: `Session "${input.sessionName}" not found during fan-in merge`,
              conflictFiles: [],
            };
            const haltResult =
              await deps.workflowManager.recordPendingHaltReason({
                projectPath: input.projectPath,
                sessionName: input.sessionName,
                reason,
                applyAdditionalMutation: (next) => {
                  const cs = next.contextStates[contextId];
                  if (cs) {
                    cs.mergeStatus = "merged-failed";
                    cs.lastMergeError = reason.message;
                  }
                },
              });
            execution = haltResult.execution;
            logger.error("graph-workflow.merge.failed", {
              executionId: execution.id,
              contextId,
              reason: reason.message,
            });
            return;
          }

          let mergeStatus:
            | "completed"
            | "failed"
            | "conflicts"
            | "ready-to-land"
            | "discarded";
          let mergeError: string | null = null;
          let mergeConflictFiles: string[] = [];
          try {
            const output = await deps.sessionGitLock.withSessionGitLock(
              {
                projectPath: input.projectPath,
                sessionName: input.sessionName,
              },
              async () =>
                deps.mergeRunner.run({
                  jobId: createJobId(),
                  projectPath: input.projectPath,
                  projectName: input.projectName,
                  sessionName: input.sessionName,
                  contextId,
                  branchName: featureBranchName,
                  featureWorktreePath,
                  targetBranch: session.branchName,
                  targetWorktreePath: session.worktreePath,
                  message: `Graph workflow context ${contextId}`,
                }),
            );
            mergeStatus = output.status;
            mergeError = output.error;
            mergeConflictFiles = output.conflictFiles;
          } catch (error) {
            mergeStatus = "failed";
            mergeError = getErrorMessage(error);
            mergeConflictFiles = [];
          }

          if (mergeStatus === "completed") {
            await deps.workflowManager.mutateActive(
              input.projectPath,
              input.sessionName,
              (e) => {
                const next = structuredClone(e);
                const cs = next.contextStates[contextId];
                if (cs) {
                  cs.mergeStatus = "merged-success";
                  cs.lastMergeError = null;
                }
                return next;
              },
            );

            execLogger?.iteration(contextId, "merge.completed", {
              branchName: featureBranchName,
            });
            logger.info("graph-workflow.merge.completed", {
              executionId: execution.id,
              contextId,
              branchName: featureBranchName,
            });

            const dispose = await deps.parallelWorktrees.dispose({
              projectPath: input.projectPath,
              worktreePath: featureWorktreePath,
              branchName: featureBranchName,
            });
            await deps.workflowManager.mutateActive(
              input.projectPath,
              input.sessionName,
              (e) => {
                const next = structuredClone(e);
                const cs = next.contextStates[contextId];
                if (cs) {
                  cs.cleanupStatus =
                    dispose.status === "removed" ? "removed" : "failed";
                }
                return next;
              },
            );
            execLogger?.lifecycle("parallel.cleanup_attempted", {
              contextId,
              status: dispose.status,
              reason: dispose.status === "failed" ? dispose.reason : undefined,
            });
            return;
          }

          const finalMergeStatus =
            mergeStatus === "conflicts" ? "conflicts" : "merged-failed";
          const haltReason: GraphWorkflowHaltReason = {
            type: "merge_failure",
            contextId,
            message: mergeError ?? "Fan-in merge failed",
            conflictFiles: mergeConflictFiles,
          };
          const haltResult = await deps.workflowManager.recordPendingHaltReason(
            {
              projectPath: input.projectPath,
              sessionName: input.sessionName,
              reason: haltReason,
              applyAdditionalMutation: (next) => {
                const cs = next.contextStates[contextId];
                if (cs) {
                  cs.mergeStatus = finalMergeStatus;
                  cs.lastMergeError = mergeError;
                }
              },
            },
          );
          execution = haltResult.execution;
          logger.error("graph-workflow.merge.failed", {
            executionId: execution.id,
            contextId,
            mergeStatus: finalMergeStatus,
            error: mergeError,
            conflictFiles: mergeConflictFiles.length,
          });
        },
      );
    }

    async function runContextTask(contextId: string): Promise<void> {
      execLogger?.lifecycle("parallel.context_started", {
        contextId,
      });

      let isolation: "session" | "worktree" = "session";
      let featureWorktreePath: string | null = null;
      let featureBranchName: string | null = null;
      let featureLaneId: string | null = null;

      async function runCommitPhase(): Promise<void> {
        if (
          isolation === "worktree" &&
          featureWorktreePath !== null &&
          featureBranchName !== null
        ) {
          if (featureLaneId !== null) {
            await runLaneCommit(
              contextId,
              featureLaneId,
              featureWorktreePath,
              featureBranchName,
            );
          } else {
            await runFanInMerge(
              contextId,
              featureWorktreePath,
              featureBranchName,
            );
          }
        } else if (isolation === "session") {
          await runSoloCommit(contextId);
        }
      }

      try {
        // Inner per-context iteration loop
        // eslint-disable-next-line no-constant-condition
        while (true) {
          const session = await deps.getSession(
            input.projectPath,
            input.sessionName,
          );
          if (!session) {
            await recordHalt({
              type: "recovery_error",
              message: `Session "${input.sessionName}" not found during iteration`,
            });
            return;
          }

          const target = deps.executionTargetResolver.resolve({
            execution,
            contextId,
            session,
          });
          isolation = target.isolation;
          featureLaneId = target.laneId;
          if (target.isolation === "worktree") {
            featureWorktreePath = target.worktreePath;
            featureBranchName = target.branchName;
          }

          // A context parked at the approval gate — whether it parked during
          // this loop or was restored from a persisted execution on resume —
          // enters the gate wait directly; no iteration is seeded. An
          // observed decision is applied under the conversation lock:
          // approved completes the context and runs the commit phase inside
          // the held lock window; rejected seeds the remediation task and
          // re-enters the iteration loop.
          if (
            execution.contextStates[contextId]?.status === "awaiting_approval"
          ) {
            const outcome = await waitForApprovalResolution(contextId);
            if (
              outcome.kind === "execution_exited" ||
              outcome.kind === "halt_pending"
            ) {
              return;
            }

            const conversationId =
              execution.contextStates[contextId]?.pendingApproval
                ?.conversationId;
            if (conversationId === undefined) {
              throw new Error(
                `Context "${contextId}" observed an approval decision without a pending record`,
              );
            }

            const lockOutcome = await acquireConversationLockWhenFree(
              contextId,
              conversationId,
            );
            if (lockOutcome.kind === "execution_exited") {
              return;
            }
            try {
              const application = await applyApprovalDecision(
                contextId,
                outcome.decision,
              );
              if (!application.applied) {
                return;
              }
              await publishApprovalResolvedEvent(
                contextId,
                conversationId,
                outcome.decision,
              );
              if (outcome.decision.type === "approved") {
                await runCommitPhase();
                return;
              }
            } finally {
              lockOutcome.release();
            }
            // Rejected — the next iteration seeds the remediation task and
            // increments the iteration count; validators re-run on the next
            // completion before the gate can trigger again.
            continue;
          }

          // A context parked awaiting user input — whether it parked during
          // this loop or was restored from a persisted execution on resume —
          // enters the user-input wait directly; no iteration is seeded. When
          // answers land, `consumeAnswers` clears the record and flips the
          // status back to `running`, and the next iteration runs as an
          // ordinary seeded turn (the answer-block prompt + conversation pin
          // that deliver the answers into that turn are owned by later tasks).
          if (
            execution.contextStates[contextId]?.status === "awaiting_user_input"
          ) {
            const outcome = await waitForUserInputResolution(contextId);
            if (
              outcome.kind === "execution_exited" ||
              outcome.kind === "halt_pending"
            ) {
              // Pause/halt/abort or a pending halt raced the wait: the record
              // persists for resume on re-entry (or was withdrawn by the
              // abort path).
              return;
            }
            if (outcome.kind === "withdrawn") {
              // The parked question was withdrawn (abort cleanup): the context
              // is no longer parked and this runner has no work to resume.
              return;
            }
            // Answers observed — consume them (clears the record + flips to
            // running) and re-iterate. `consumeAnswers` returning null would
            // mean the record vanished between the wait and this mutation
            // (withdrawn) — treat it as a withdrawal and exit.
            const consumed = await userInputGateService.consumeAnswers({
              projectPath: input.projectPath,
              sessionName: input.sessionName,
              contextId,
            });
            await refreshExecution();
            if (consumed === null) {
              return;
            }
            // Carry the answers across the `continue` so the next iteration for
            // this context delivers them (pin + answer block) into the resumed
            // turn.
            pendingResumeUserInput.set(contextId, consumed);
            execLogger?.iteration(contextId, "user_input.resumed", {
              conversationId: consumed.conversationId,
              questionBatchId: consumed.questionBatchId,
              lane: consumed.lane,
            });
            logger.info("graph-workflow.user_input.resumed", {
              executionId: execution.id,
              contextId,
              lane: consumed.lane,
            });
            continue;
          }

          const resumeUserInput = pendingResumeUserInput.get(contextId);
          pendingResumeUserInput.delete(contextId);

          let iterationResult: GraphWorkflowIterationResult;
          try {
            iterationResult = await deps.iterationOrchestrator.runIteration({
              projectPath: input.projectPath,
              projectName: input.projectName,
              sessionName: input.sessionName,
              contextId,
              executionTarget: target,
              resumeUserInput,
            });
            retryableRecoveryAttempts.delete(contextId);
          } catch (error) {
            if (error instanceof StaleLoopFenceError) {
              // This loop generation was superseded mid-iteration (execution
              // aborted/replaced or resumed under a new epoch). Recording a
              // halt here would land on the successor generation's state —
              // propagate instead so the loop exits silently.
              throw error;
            }
            if (isAbortCausedTurnFailure(error)) {
              // An aborted turn is usually the effect of a lifecycle
              // transition (pause/halt/abort actively cancel in-flight
              // turns), not an agent failure. The fence cannot reject the
              // settling write — same id and epoch — so check the persisted
              // status: if the execution has left `running`, the transition
              // owns the outcome and recording agent_turn_failed here would
              // poison the suspended state (and drain-halt the next resume).
              await refreshExecution();
              if (execution.status !== "running") {
                execLogger?.iteration(
                  contextId,
                  "loop.turn_aborted_by_transition",
                  { executionStatus: execution.status },
                );
                logger.info("graph-workflow.loop.turn_aborted_by_transition", {
                  executionId: execution.id,
                  contextId,
                  executionStatus: execution.status,
                });
                return;
              }
            }
            if (hasPartialIterationProgress(error)) {
              retryableRecoveryAttempts.delete(contextId);
            }
            const recoveryAttempts =
              retryableRecoveryAttempts.get(contextId) ?? 0;
            const recoverRetryableIterationError =
              deps.workflowManager.recoverRetryableIterationError;
            const canRecover =
              isRetryableIterationError(error) &&
              recoveryAttempts < 1 &&
              recoverRetryableIterationError;

            if (!canRecover) {
              await recordHalt(
                toHaltReason(error, { contextId, cause: "sdk_error" }),
              );
              return;
            }

            const errorMessage = getErrorMessage(error);
            retryableRecoveryAttempts.set(contextId, recoveryAttempts + 1);
            execLogger?.decision("iteration.retryable_error_detected", {
              contextId,
              error: errorMessage,
              recoveryAttempt: recoveryAttempts + 1,
              maxRecoveryAttempts: 1,
            });
            logger.warn("graph-workflow.loop.retryable_iteration_error", {
              executionId: execution.id,
              contextId,
              error: errorMessage,
              recoveryAttempt: recoveryAttempts + 1,
            });
            execution = await recoverRetryableIterationError(
              input.projectPath,
              input.sessionName,
              { contextId, errorMessage },
            );
            continue;
          }

          adoptExecution(iterationResult.execution);

          const pendingCollaboration =
            execution.pendingCollaborations?.[contextId];
          if (pendingCollaboration) {
            execLogger?.iteration(contextId, "loop.collaboration_pending", {
              workflowId: pendingCollaboration.workflowId,
            });
            logger.info("graph-workflow.parallel.collaboration_pending", {
              executionId: execution.id,
              contextId,
              workflowId: pendingCollaboration.workflowId,
            });
            return;
          }

          if (execution.status !== "running") {
            // Orchestrator-driven halt (e.g., signalHalt). Stop iterating;
            // the outer loop's drain-then-halt path takes over.
            return;
          }

          if (
            execution.pendingHaltReason !== null &&
            iterationResult.shouldContinueInContext
          ) {
            // A halt was recorded (by this or a sibling context) but the
            // execution is still in the drain-then-halt window: pendingHaltReason
            // is set while status stays "running" and this context's status is
            // not yet "halted". Stop seeding another iteration so the in-flight
            // task settles and the outer loop applies the halt. Without this, a
            // context with remaining tasks spins a full agent turn per iteration
            // until maxIterations. A context that just COMPLETED its tasks
            // (shouldContinueInContext === false) is not stopped here — it falls
            // through to commit/merge so the drain still lands successful
            // siblings before halting.
            execLogger?.iteration(contextId, "loop.pending_halt_detected", {
              haltReasonType: execution.pendingHaltReason.type,
            });
            logger.info("graph-workflow.parallel.pending_halt_detected", {
              executionId: execution.id,
              contextId,
              haltReasonType: execution.pendingHaltReason.type,
            });
            return;
          }

          const contextState = execution.contextStates[contextId];
          const contextDef = execution.workingDefinition.executionContexts.find(
            (c) => c.id === contextId,
          );

          if (contextState?.status === "halted") {
            execLogger?.iteration(contextId, "loop.context_halted", {
              pendingHaltReason: execution.pendingHaltReason,
            });
            logger.info("graph-workflow.parallel.context_halted", {
              executionId: execution.id,
              contextId,
              haltReasonType: execution.pendingHaltReason?.type ?? null,
            });
            return;
          }

          if (contextState && contextDef) {
            const threshold =
              contextDef.circuitBreaker.consecutiveFailureThreshold ??
              DEFAULT_CONSECUTIVE_FAILURE_THRESHOLD;
            const gateResult = runCircuitBreakerGate({
              failureCount: contextState.consecutiveFailureCount,
              threshold,
            });
            if (gateResult.status === "fail") {
              execLogger?.decision("circuit_breaker.tripped", {
                contextId,
                consecutiveFailureCount: contextState.consecutiveFailureCount,
                threshold,
              });
              await recordHalt({
                type: "circuit_breaker",
                contextId,
                condition: "retry_exhaustion",
                failureCount: contextState.consecutiveFailureCount,
                summary: null,
              });
              return;
            }
          }

          if (
            contextState &&
            contextDef &&
            contextState.iterationCount >=
              contextDef.iterationPolicy.maxIterations
          ) {
            execLogger?.decision("max_iterations.reached", {
              contextId,
              iterationCount: contextState.iterationCount,
              maxIterations: contextDef.iterationPolicy.maxIterations,
            });
            await recordHalt({
              type: "max_iterations",
              contextId,
              iterationCount: contextState.iterationCount,
            });
            return;
          }

          if (iterationResult.shouldContinueInContext) {
            execLogger?.iteration(contextId, "loop.continue_in_context", {
              conversationId: iterationResult.conversationId,
            });
            continue;
          }

          // An awaiting-approval context exits the iteration exactly like a
          // completed one (no extra iteration is seeded), but loops back to
          // park in the gate wait at the top of the loop instead of
          // proceeding to the commit/merge phase.
          if (contextState?.status === "awaiting_approval") {
            continue;
          }

          // A context that parked awaiting user input during this iteration
          // (the orchestrator's post-turn park check) loops back to the top so
          // the user-input wait engages, mirroring the approval gate. No
          // iteration is consumed and no commit/merge runs while parked.
          if (contextState?.status === "awaiting_user_input") {
            continue;
          }

          // Context completed all of its tasks — break out for fan-in merge.
          break;
        }
      } finally {
        execLogger?.lifecycle("parallel.context_finished", {
          contextId,
          isolation,
        });
      }

      await runCommitPhase();
    }

    async function runLaneCommit(
      contextId: string,
      laneId: string,
      laneWorktreePath: string,
      laneBranchName: string,
    ): Promise<void> {
      await deps.mergeMutex.withMergeMutex(
        {
          projectPath: input.projectPath,
          sessionName: input.sessionName,
        },
        async () => {
          execLogger?.iteration(contextId, "lane_commit.started", {
            laneId,
            laneWorktreePath,
            laneBranchName,
          });
          logger.info("graph-workflow.lane_commit.started", {
            executionId: execution.id,
            contextId,
            laneId,
            laneBranchName,
          });

          const result = await deps.sessionGitLock.withSessionGitLock(
            {
              projectPath: input.projectPath,
              sessionName: input.sessionName,
            },
            async () =>
              deps.laneCommitter.commit({
                projectPath: input.projectPath,
                sessionName: input.sessionName,
                contextId,
                laneId,
                laneWorktreePath,
              }),
          );

          if (result.status === "failed") {
            const reason: GraphWorkflowHaltReason = {
              type: "merge_failure",
              contextId,
              message: result.errorMessage,
              conflictFiles: [],
            };
            const haltResult =
              await deps.workflowManager.recordPendingHaltReason({
                projectPath: input.projectPath,
                sessionName: input.sessionName,
                reason,
                applyAdditionalMutation: (next) => {
                  const cs = next.contextStates[contextId];
                  if (cs) {
                    cs.mergeStatus = "merged-failed";
                    cs.lastMergeError = result.errorMessage;
                  }
                },
              });
            execution = haltResult.execution;
            logger.error("graph-workflow.lane_commit.failed", {
              executionId: execution.id,
              contextId,
              laneId,
              error: result.errorMessage,
            });
            return;
          }

          if (result.status === "committed") {
            const snapshot = result.snapshot;
            await deps.workflowManager.mutateActive(
              input.projectPath,
              input.sessionName,
              (e) =>
                applyLaneCommitSnapshot(
                  {
                    ...e,
                    contextStates: {
                      ...e.contextStates,
                      ...(e.contextStates[contextId]
                        ? {
                            [contextId]: {
                              ...e.contextStates[contextId]!,
                              mergeStatus: "merged-success",
                              lastMergeError: null,
                            },
                          }
                        : {}),
                    },
                  },
                  laneId,
                  snapshot,
                ),
            );
            execLogger?.iteration(contextId, "lane_commit.completed", {
              laneId,
              sha: snapshot.sha,
              committedAt: snapshot.committedAt,
            });
            logger.info("graph-workflow.lane_commit.completed", {
              executionId: execution.id,
              contextId,
              laneId,
              sha: snapshot.sha,
            });
            return;
          }

          // status === "skipped" — no uncommitted changes on the lane. Still
          // mark the context as available in the lane so downstream contexts
          // (and any future join) see the work as ready, but do not append a
          // snapshot since no commit was made.
          await deps.workflowManager.mutateActive(
            input.projectPath,
            input.sessionName,
            (e) => {
              const next = structuredClone(e);
              const lane = next.executionLanes[laneId];
              if (lane && !lane.includedContextIds.includes(contextId)) {
                lane.includedContextIds = [
                  ...lane.includedContextIds,
                  contextId,
                ];
              }
              const cs = next.contextStates[contextId];
              if (cs) {
                cs.mergeStatus = "merged-success";
              }
              return next;
            },
          );
          execLogger?.iteration(contextId, "lane_commit.skipped", {
            laneId,
            laneWorktreePath,
          });
          logger.info("graph-workflow.lane_commit.skipped", {
            executionId: execution.id,
            contextId,
            laneId,
          });
        },
      );
    }

    async function runSoloCommit(contextId: string): Promise<void> {
      await deps.mergeMutex.withMergeMutex(
        {
          projectPath: input.projectPath,
          sessionName: input.sessionName,
        },
        async () => {
          const session = await deps.getSession(
            input.projectPath,
            input.sessionName,
          );
          if (!session) {
            const reason: GraphWorkflowHaltReason = {
              type: "merge_failure",
              contextId,
              message: `Session "${input.sessionName}" not found during solo-context commit`,
              conflictFiles: [],
            };
            const haltResult =
              await deps.workflowManager.recordPendingHaltReason({
                projectPath: input.projectPath,
                sessionName: input.sessionName,
                reason,
              });
            execution = haltResult.execution;
            logger.error("graph-workflow.solo_commit.session_missing", {
              executionId: execution.id,
              contextId,
            });
            return;
          }

          const result = await deps.sessionGitLock.withSessionGitLock(
            {
              projectPath: input.projectPath,
              sessionName: input.sessionName,
            },
            async () =>
              deps.soloContextCommitter.commit({
                projectPath: input.projectPath,
                sessionName: input.sessionName,
                contextId,
                sessionWorktreePath: session.worktreePath,
              }),
          );

          if (result.status === "failed") {
            const reason: GraphWorkflowHaltReason = {
              type: "merge_failure",
              contextId,
              message: result.errorMessage,
              conflictFiles: [],
            };
            const haltResult =
              await deps.workflowManager.recordPendingHaltReason({
                projectPath: input.projectPath,
                sessionName: input.sessionName,
                reason,
              });
            execution = haltResult.execution;
            logger.error("graph-workflow.solo_commit.failed", {
              executionId: execution.id,
              contextId,
              error: result.errorMessage,
            });
            return;
          }

          execLogger?.iteration(contextId, "solo_commit.completed", {
            status: result.status,
          });
          logger.info("graph-workflow.solo_commit.recorded", {
            executionId: execution.id,
            contextId,
            status: result.status,
          });

          await deps.workflowManager.mutateActive(
            input.projectPath,
            input.sessionName,
            (e) => {
              const cs = e.contextStates[contextId];
              if (!cs || cs.laneId === null) return e;
              const lane = e.executionLanes[cs.laneId];
              if (!lane || lane.kind !== "session") return e;
              if (lane.includedContextIds.includes(contextId)) return e;
              const next = structuredClone(e);
              const nextLane = next.executionLanes[cs.laneId];
              if (nextLane) {
                nextLane.includedContextIds = [
                  ...nextLane.includedContextIds,
                  contextId,
                ];
              }
              return next;
            },
          );
        },
      );
    }

    async function runEligibleJoinIfAny(): Promise<"ran" | "halted" | "none"> {
      const session = await deps.getSession(
        input.projectPath,
        input.sessionName,
      );
      if (!session) {
        await recordHalt({
          type: "recovery_error",
          message: `Session "${input.sessionName}" not found during join orchestration`,
        });
        return "halted";
      }

      execution = await deps.workflowManager.mutateActive(
        input.projectPath,
        input.sessionName,
        (e) =>
          materializeSessionLane(e, {
            sessionLaneId: SESSION_LANE_ID,
            branchName: session.branchName,
            worktreePath: session.worktreePath,
            now: () => new Date().toISOString(),
          }),
      );

      let active = findActiveJoin(execution);
      if (!active) {
        const eligibleIds = getEligibleContextIds(
          execution.workingDefinition,
          execution,
        );
        let planned = null as ReturnType<typeof planContextJoin> | null;
        let plannedFor: "context" | "final_publish" | null = null;
        for (const contextId of eligibleIds) {
          const classification = classifyContextSchedulability({
            contextId,
            definition: execution.workingDefinition,
            execution,
          });
          if (classification.kind !== "wait-for-join") continue;
          planned = planContextJoin({
            contextId,
            execution,
            now: () => new Date().toISOString(),
            generateJoinId: () => createJobId(),
          });
          if (planned) {
            plannedFor = "context";
            break;
          }
        }

        if (!planned) {
          planned = planFinalPublishJoin({
            execution,
            sessionLaneId: SESSION_LANE_ID,
            now: () => new Date().toISOString(),
            generateJoinId: () => createJobId(),
          });
          if (planned) plannedFor = "final_publish";
        }

        if (!planned) return "none";

        const toPersist = planned;
        execution = await deps.workflowManager.mutateActive(
          input.projectPath,
          input.sessionName,
          (e) => appendPendingJoin(e, toPersist),
        );
        active = toPersist;
        execLogger?.lifecycle("join.planned", {
          joinId: planned.joinId,
          kind: planned.kind,
          contextId: planned.contextId,
          sourceLaneIds: planned.sourceLaneIds,
          targetLaneId: planned.targetLaneId,
        });
        logger.info("graph-workflow.join.planned", {
          executionId: execution.id,
          joinId: planned.joinId,
          kind: planned.kind,
          plannedFor,
          sourceLaneIds: planned.sourceLaneIds,
          targetLaneId: planned.targetLaneId,
        });
      }

      const join = active;
      execLogger?.lifecycle("join.started", {
        joinId: join.joinId,
        kind: join.kind,
        sourceLaneIds: join.sourceLaneIds,
        targetLaneId: join.targetLaneId,
      });
      logger.info("graph-workflow.join.started", {
        executionId: execution.id,
        joinId: join.joinId,
        kind: join.kind,
      });

      const result = await deps.joinRunner.run({
        projectPath: input.projectPath,
        projectName: input.projectName,
        sessionName: input.sessionName,
        joinId: join.joinId,
        mutateActive: (mutator) =>
          deps.workflowManager.mutateActive(
            input.projectPath,
            input.sessionName,
            mutator,
          ),
      });

      await refreshExecution();

      if (result.status === "succeeded") {
        execLogger?.lifecycle("join.completed", {
          joinId: join.joinId,
          kind: join.kind,
        });
        return "ran";
      }

      const haltResult = await deps.workflowManager.recordPendingHaltReason({
        projectPath: input.projectPath,
        sessionName: input.sessionName,
        reason: {
          type: "join_failure",
          joinId: join.joinId,
          joinKind: join.kind,
          contextId: join.contextId,
          sourceLaneIds: join.sourceLaneIds,
          targetLaneId: join.targetLaneId,
          message: result.message,
          conflictFiles: result.conflictFiles,
        },
      });
      execution = haltResult.execution;
      execLogger?.lifecycle("join.failed", {
        joinId: join.joinId,
        kind: join.kind,
        failedSourceLaneId: result.failedSourceLaneId,
        conflictFiles: result.conflictFiles,
      });
      logger.error("graph-workflow.join.failed", {
        executionId: execution.id,
        joinId: join.joinId,
        kind: join.kind,
        message: result.message,
        conflictFiles: result.conflictFiles.length,
      });
      return "halted";
    }

    // A merged lane's content lives on the session branch, so its worktree and
    // branch are disposable once the execution completes. Contexts that never
    // merged (halted/aborted executions) keep their lanes intact for forensics
    // until session delete. Failures are logged and never fail the completion.
    async function cleanupMergedLanes(): Promise<void> {
      const laneIds = new Set<string>();
      for (const cs of Object.values(execution.contextStates)) {
        if (cs.mergeStatus !== "merged-success") continue;
        if (cs.isolation !== "worktree") continue;
        if (cs.laneId !== null) {
          laneIds.add(cs.laneId);
        } else if (cs.cleanupStatus !== "removed") {
          // Legacy per-context worktree whose merge-time dispose did not land.
          laneIds.add(cs.contextId);
        }
      }
      if (laneIds.size === 0) return;

      const session = await deps.getSession(
        input.projectPath,
        input.sessionName,
      );
      if (!session) {
        logger.warn("graph-workflow.lane_cleanup.session_missing", {
          executionId: execution.id,
          laneIds: [...laneIds],
        });
        return;
      }
      const sessionDir = path.basename(session.worktreePath);

      for (const laneId of laneIds) {
        try {
          const result = await deps.parallelWorktrees.cleanupLane({
            projectPath: input.projectPath,
            sessionName: input.sessionName,
            sessionDir,
            contextId: laneId,
          });
          execLogger?.lifecycle("lane.cleanup_attempted", {
            laneId,
            status: result.status,
            reason: result.status === "failed" ? result.reason : undefined,
          });
        } catch (error) {
          logger.warn("graph-workflow.lane_cleanup.failed", {
            executionId: execution.id,
            laneId,
            error: getErrorMessage(error),
          });
        }
      }
    }

    try {
      // Outer scheduling loop: schedule currently-eligible work, wait for the
      // next in-flight context or merge event to settle, refresh execution
      // state, and reschedule. Downstream contexts can become eligible the
      // moment an upstream context lands without waiting for the full wave to
      // drain.
      // eslint-disable-next-line no-constant-condition
      while (true) {
        if (execution.status !== "running") {
          if (inFlight.size > 0) {
            await Promise.race(inFlight.values());
            continue;
          }
          // Abort semantics: a parked question must not dangle as answerable
          // after the execution is aborted (Req 7.4). Withdraw every parked
          // record — clearing it, dispatching CLEAR_PENDING_QUESTION per
          // parked conversation, and publishing resolved(withdrawn). Pause and
          // halt intentionally preserve the record so the wait re-engages on
          // resume; only an abort withdraws. The withdraw is idempotent, so a
          // record already cleared by the answer flow is a safe no-op.
          //
          // NOTE (task 4.3 boundary): the true abort transition is owned by
          // workflow-manager.ts send({ type: "abort" }) (its
          // abortRunningTaskConversations seam, ~L773), which is out of this
          // task's boundary. This loop reacts to the aborted status rather than
          // owning the transition, so withdrawAll runs here at the loop's
          // in-scope abort-handling point. If a future change needs the
          // withdraw to happen atomically with the abort mutation, it belongs
          // beside abortRunningTaskConversations in the manager.
          if (
            execution.status === "aborted" &&
            hasAwaitingUserInputContexts(execution)
          ) {
            await userInputGateService.withdrawAll({
              projectPath: input.projectPath,
              sessionName: input.sessionName,
              executionId: execution.id,
            });
            // Tolerant refresh: an abort may archive the execution (getActive
            // returns null or a successor). This loop is about to break and
            // return its own aborted snapshot, so staleness is not an error
            // here — only a same-generation refresh is worth adopting.
            const refreshed = await deps.workflowManager.getActive(
              input.projectPath,
              input.sessionName,
            );
            if (refreshed !== null && matchesLoopFence(fence, refreshed)) {
              execution = refreshed;
            }
          }
          break;
        }

        if (execution.pendingHaltReason !== null) {
          if (inFlight.size > 0) {
            await Promise.race(inFlight.values());
            continue;
          }
          execution = await deps.workflowManager.drainAndHalt({
            projectPath: input.projectPath,
            sessionName: input.sessionName,
          });
          break;
        }

        if (execution.pendingMergeRetry.length > 0 && inFlight.size === 0) {
          await processPendingMergeRetry();
          if (execution.pendingHaltReason !== null) {
            execution = await deps.workflowManager.drainAndHalt({
              projectPath: input.projectPath,
              sessionName: input.sessionName,
            });
            break;
          }
          continue;
        }

        if (inFlight.size === 0) {
          const halted = await preflightSessionWorktreeForNextBatch();
          if (halted) {
            execution = await deps.workflowManager.drainAndHalt({
              projectPath: input.projectPath,
              sessionName: input.sessionName,
            });
            break;
          }
        }

        // Bound the parallel batch to the SDK query-concurrency limit minus
        // what is already running. The loop reschedules every iteration as
        // in-flight contexts settle, so this caps each execution to a sliding
        // window of `maxConcurrency` concurrent contexts and the surplus never
        // queues on the global semaphore until it times out.
        const capacityRemaining = Math.max(0, maxConcurrency - inFlight.size);
        execLogger?.lifecycle("loop.schedule_capacity", {
          maxConcurrency,
          inFlight: inFlight.size,
          capacityRemaining,
        });
        const scheduleResult =
          await deps.workflowManager.scheduleEligibleContexts({
            projectPath: input.projectPath,
            sessionName: input.sessionName,
            sessionLaneEnabled: input.sessionLaneEnabled,
            capacityRemaining,
          });
        adoptExecution(scheduleResult.execution);

        // The scheduler only seeds pending/ready contexts, so a context
        // restored as awaiting_approval (a park persisted across a pause,
        // halt, or restart) gets its runner here and re-enters the gate
        // wait directly. A context that parked under this loop is skipped:
        // its runner is still in flight, holding the wait.
        for (const contextState of Object.values(execution.contextStates)) {
          if (contextState.status !== "awaiting_approval") continue;
          const contextId = contextState.contextId;
          if (inFlight.has(contextId)) continue;
          execLogger?.iteration(contextId, "gate.reentered", {
            conversationId:
              contextState.pendingApproval?.conversationId ?? null,
          });
          logger.info("graph-workflow.gate.reentered", {
            executionId: execution.id,
            contextId,
          });
          const task = runContextTask(contextId).finally(() => {
            inFlight.delete(contextId);
          });
          inFlight.set(contextId, task);
        }

        // The same re-entry for user-input parks: a context restored as
        // awaiting_user_input (park persisted across pause/halt/restart) gets
        // its runner here and re-enters the user-input wait directly. If
        // answers were recorded while suspended, the wait's answers-present
        // check short-circuits and the context resumes immediately without
        // re-waiting (Req 7.3). A context parked under this loop is skipped:
        // its runner is still in flight, holding the wait.
        for (const contextState of Object.values(execution.contextStates)) {
          if (contextState.status !== "awaiting_user_input") continue;
          const contextId = contextState.contextId;
          if (inFlight.has(contextId)) continue;
          execLogger?.iteration(contextId, "user_input.reentered", {
            conversationId:
              contextState.pendingUserInput?.conversationId ?? null,
          });
          logger.info("graph-workflow.user_input.reentered", {
            executionId: execution.id,
            contextId,
          });
          const task = runContextTask(contextId).finally(() => {
            inFlight.delete(contextId);
          });
          inFlight.set(contextId, task);
        }

        if (scheduleResult.scheduled.kind === "none") {
          if (inFlight.size > 0) {
            await Promise.race(inFlight.values());
            continue;
          }
          if (execution.pendingHaltReason !== null) {
            execution = await deps.workflowManager.drainAndHalt({
              projectPath: input.projectPath,
              sessionName: input.sessionName,
            });
            break;
          }
          if (hasPendingCollaborations(execution)) {
            await waitForPendingCollaborationProgress();
            continue;
          }
          // A parked context is incomplete (requirement 2.5): the execution
          // must neither run the final publish join nor complete while a
          // gate is unresolved. The re-entry pass above keeps a runner in
          // flight for every parked context, so this guard backstops the
          // completion determination.
          if (hasAwaitingApprovalContexts(execution)) {
            continue;
          }
          // The same completion guard for user-input parks (Req 3.5): the
          // execution must never complete while a context awaits user input.
          // The re-entry pass above keeps a runner in flight for every parked
          // context, so this backstops the completion determination.
          if (hasAwaitingUserInputContexts(execution)) {
            continue;
          }
          const joinOutcome = await runEligibleJoinIfAny();
          if (joinOutcome === "halted") {
            execution = await deps.workflowManager.drainAndHalt({
              projectPath: input.projectPath,
              sessionName: input.sessionName,
            });
            break;
          }
          if (joinOutcome === "ran") {
            continue;
          }
          // Completion invariant: the loop only reaches this point when nothing
          // is schedulable and no join remains, which it treats as "all work
          // done". That inference is only safe if no context still has
          // uncompleted tasks. A context stranded with unfinished tasks (e.g. a
          // forked lane reset to `ready` that the scheduler can no longer place,
          // or a downstream that was never started) would otherwise be silently
          // dropped. Refuse to complete and halt for human intervention instead
          // — a graph workflow must never report `completed` while uncompleted
          // tasks remain. The predicate is task-based, not status-based: a
          // context whose tasks are all done but whose status has not yet been
          // flipped to `completed` (e.g. parked awaiting collaboration delivery)
          // is legitimately finished and must not block completion.
          const incompleteContexts = Object.values(
            execution.contextStates,
          ).filter(
            (contextState) =>
              contextState.completedTaskCount < contextState.totalTaskCount,
          );
          if (incompleteContexts.length > 0) {
            const incompleteContextIds = incompleteContexts.map(
              (contextState) => contextState.contextId,
            );
            const summary = incompleteContexts
              .map(
                (contextState) =>
                  `${contextState.contextId} (${contextState.completedTaskCount}/${contextState.totalTaskCount} tasks, ${contextState.status})`,
              )
              .join(", ");
            logger.error("graph-workflow.loop.completion_blocked_incomplete", {
              executionId: execution.id,
              incompleteContextIds,
            });
            execLogger?.lifecycle("loop.completion_blocked_incomplete", {
              incompleteContextIds,
            });
            await recordHalt({
              type: "recovery_error",
              message: `Refusing to complete: ${incompleteContexts.length} execution context(s) still have uncompleted tasks (${summary}). The scheduler found no eligible work and no remaining join, which would otherwise drop the unfinished work — halting instead. This indicates a scheduling defect.`,
            });
            execution = await deps.workflowManager.drainAndHalt({
              projectPath: input.projectPath,
              sessionName: input.sessionName,
            });
            break;
          }
          execution = await deps.workflowManager.send(
            input.projectPath,
            input.sessionName,
            { type: "complete" },
          );
          await cleanupMergedLanes();
          break;
        }

        const scheduledContextIds =
          scheduleResult.scheduled.kind === "solo"
            ? [scheduleResult.scheduled.contextId]
            : scheduleResult.scheduled.contextIds;

        for (const contextId of scheduledContextIds) {
          if (inFlight.has(contextId)) continue;
          const task = runContextTask(contextId).finally(() => {
            inFlight.delete(contextId);
          });
          inFlight.set(contextId, task);
        }

        // Wait for the next in-flight context or merge event to settle, then
        // refresh and reschedule. Newly eligible downstream contexts are
        // picked up immediately instead of being held behind the slowest peer
        // in the current wave.
        if (inFlight.size > 0) {
          await Promise.race(inFlight.values());
        }

        await refreshExecution();
      }

      return execution;
    } catch (error) {
      if (error instanceof StaleLoopFenceError) {
        // This loop instance was superseded: its execution was aborted and
        // replaced, or halted and resumed under a new loop generation. Exit
        // WITHOUT recording a halt or draining — recordPendingHaltReason and
        // drainAndHalt are session-keyed and would mutate the successor
        // generation's state (the incident-622782a0 failure mode). In-flight
        // context tasks are fenced themselves; absorb their eventual
        // settlement so a late rejection is not unhandled, but do not block
        // the exit on work that may run for minutes.
        execLogger?.lifecycle("loop.fenced_out", {
          fencedExecutionId: error.fence.executionId,
          fencedLoopEpoch: error.fence.loopEpoch,
          activeExecutionId: error.actualExecutionId,
          activeLoopEpoch: error.actualLoopEpoch,
          inFlightContextIds: [...inFlight.keys()],
        });
        logger.info("graph-workflow.loop.fenced_out", {
          executionId: fence.executionId,
          loopEpoch: fence.loopEpoch,
          activeExecutionId: error.actualExecutionId,
          activeLoopEpoch: error.actualLoopEpoch,
          inFlightContextIds: [...inFlight.keys()],
        });
        void Promise.allSettled(inFlight.values());
        return execution;
      }
      execLogger?.lifecycle("loop.recovery_error", {
        error: getErrorMessage(error),
      });
      logger.error("graph-workflow.loop.recovery_error", {
        executionId: execution.id,
        error: getErrorMessage(error),
      });
      let recorded: RecordPendingHaltReasonResult | null = null;
      try {
        recorded = await deps.workflowManager.recordPendingHaltReason({
          projectPath: input.projectPath,
          sessionName: input.sessionName,
          reason: {
            type: "recovery_error",
            message: getErrorMessage(error),
          },
        });
      } catch (recordErr) {
        logger.error("graph-workflow.loop.record_halt_failed", {
          executionId: execution.id,
          error: getErrorMessage(recordErr),
        });
      }
      await Promise.allSettled(inFlight.values());
      if (recorded !== null && recorded.execution.status !== "running") {
        // A lifecycle transition parked the execution while the loop was
        // failing (the record above was refused). The transition owns the
        // terminal state — draining would flip it to halted and overwrite
        // the operator's decision.
        logger.info("graph-workflow.loop.recovery_skipped_non_running", {
          executionId: recorded.execution.id,
          executionStatus: recorded.execution.status,
          error: getErrorMessage(error),
        });
        return recorded.execution;
      }
      const haltedExecution = await deps.workflowManager.drainAndHalt({
        projectPath: input.projectPath,
        sessionName: input.sessionName,
      });
      return haltedExecution;
    } finally {
      if (activeLoops.get(key) === loopInstanceToken) {
        activeLoops.delete(key);
      }
    }
  }

  return { run };
}
