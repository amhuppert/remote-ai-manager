import { captureContextReviewOrigin } from "./review-origin";
import type { ContextLanding } from "./context-landing";
import { type ContextLandingInput } from "./context-landing";
import type { GraphWorkflowExecutionRepository } from "./execution-repository";
import type { ContextScheduler } from "./context-scheduler";
import { unchanged, eventsOnly } from "@/lib/workflow-graph/execution-mutation";
import { mutationValue } from "@/lib/workflow-graph/execution-mutation";

import { changed } from "@/lib/workflow-graph/execution-mutation";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { getErrorMessage } from "@/lib/shared/errors";

import { captureTraceContext, createLogger, runAsTrace } from "@/lib/logging";
import { getExecutionLogger } from "@/lib/workflow-graph/execution-logger";
import { AgentTurnFailedError, toHaltReason, type DirtyPath } from "./errors";
import { contextOwesOutput } from "./context-outputs";
import {
  runCircuitBreakerGate as defaultRunCircuitBreakerGate,
  type CircuitBreakerGateResult,
  type RunCircuitBreakerGateInput,
} from "@/lib/workflows/primitives/circuit-breaker-gate";

import {
  type ApprovalGateService,
  type AppliedApprovalDecision,
} from "@/lib/workflow-graph/approval-gate";
import {
  type ConsumeAnswersResult,
  type ResumeUserInputContext,
  type UserInputGateService,
} from "@/lib/workflow-graph/user-input-gate";
import {
  answeredPendingUserInputs,
  pendingUserInputEntries,
  unansweredPendingUserInputs,
} from "@/lib/workflow-graph/pending-user-input";

import { createGraphWorkflowExecutionEventPublisher } from "@/lib/workflow-graph/execution-events";
import type {
  ExecutionTargetResolver,
  ExecutionTarget,
} from "@/lib/workflow-graph/execution-target-resolver";
import type { ParallelWorktrees } from "@/lib/workflow-graph/parallel-worktrees";

import { getGlobalSingleton } from "@/lib/shared/global-singleton";
import { type SessionGitLock } from "@/lib/shared/lock-retry";
import { sleep } from "@/lib/shared/sleep";

import { type LaneCommitter } from "@/lib/workflow-graph/lane-committer";

import {
  classifyContextSchedulability,
  landGatedPublishSettlement,
} from "@/lib/workflow-graph/lane-readiness";
import {
  collectLandingCommitRepairs,
  collectLandingProbeTargets,
  settleRoutes,
  type LandingBranchEvidence,
  type RouteSettlementOutcome,
} from "@/lib/workflow-graph/route-runtime";

import { type LandingEvidenceProber } from "@/lib/workflow-graph/landing-evidence";
import {
  finalizeLoopPassMaterialization,
  prepareLoopPassMaterialization,
  settleLoops,
  type LoopMaterializationRequest,
  type LoopSettlementOutcome,
} from "@/lib/workflow-graph/loop-settlement";

import type { LiveEditDeps } from "@/lib/workflow-graph/runtime-edits";
import { type GraphExecutionContract } from "@/lib/workflow-graph/execution-contract-port";
import { getEligibleContextIds } from "@/lib/workflow-graph/lane-readiness";
import { SESSION_LANE_ID } from "@/lib/workflow-graph/lane-identity";
import {
  appendPendingJoin,
  findActiveJoin,
  findBusyJoinSourceLaneIds,
  findContextsWithUnfinishedTasks,
  materializeSessionLane,
  planContextJoin,
  planFinalPublishJoin,
  unpublishedContributions,
} from "@/lib/workflow-graph/lane-join";
import {
  describeValidationCertificationDebt,
  findValidationCertificationDebt,
} from "@/lib/workflow-graph/validation-certification";
import {
  applyJoinProgress,
  buildLifecycleSnapshot,
  transitionContextStatus,
} from "@/lib/workflow-graph/context-transitions";
import type { SessionState } from "@/lib/sessions/schemas";
import type {
  GraphWorkflowApprovalDecision,
  GraphWorkflowExecution,
  GraphWorkflowExecutionContextState,
  GraphWorkflowExecutionJoinState,
  GraphWorkflowHaltReason,
} from "@/lib/workflow-graph/schemas";
import type { GraphWorkflowStatus } from "@/lib/workflow-graph/definition-schemas";
import { DEFAULT_CONSECUTIVE_FAILURE_THRESHOLD } from "./constants";

import {
  StaleLoopFenceError,
  isOwnRetiredGeneration,
  matchesLoopFence,
  runWithLoopFence,
  type GraphWorkflowLoopFence,
} from "./loop-fence";
import {
  hasPartialIterationProgress,
  IterationFailureWithProgressError,
} from "./iteration-failure-with-progress";
import type { GraphWorkflowIterationResult } from "@/lib/workflow-graph/context-outcome";

import type { RecordPendingHaltReasonResult } from "./workflow-manager";
import type { ScheduleEligibleContextsResult } from "@/lib/workflow-graph/context-scheduler";

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
    resumeUserInputs?: readonly ResumeUserInputContext[];
    signal: AbortSignal;
  }): Promise<GraphWorkflowIterationResult>;
}

export interface GraphWorkflowExecutionLoopDeps {
  executionRepository: Pick<
    GraphWorkflowExecutionRepository,
    "getActive" | "mutateActive"
  >;
  contextScheduler: ContextScheduler;
  workflowManager: GraphWorkflowExecutionLoopWorkflowManager;
  iterationOrchestrator: GraphWorkflowExecutionLoopIterationOrchestrator;
  parallelWorktrees: ParallelWorktrees;
  sessionGitLock: SessionGitLock;
  laneCommitter: LaneCommitter;
  executionTargetResolver: ExecutionTargetResolver;
  /**
   * Reads landing evidence back off the branch for the commit modes (decision
   * D8). The scheduler probes before each settlement pass so a commit-mode
   * intent whose settlement did not survive a crash is repaired from replayable
   * facts rather than from lifecycle bookkeeping.
   */
  landingEvidenceProber: LandingEvidenceProber;
  /**
   * Repairs a lane worktree's shared index before a full-access member's first
   * turn, so an agent's own `git commit -a` cannot publish the deletion of a
   * path an enveloped sibling landed (R7.2).
   */
  resyncSharedIndex(worktreePath: string): Promise<void>;
  /**
   * Builds the live-edit core's deps for loop unrolling (D4 R9). Unrolling
   * rides `applyLiveExecutionEdits` through the staging seam, and that core is
   * sync, so its config-derived deps are resolved once per materialization
   * outside the write queue. Production supplies the live-edit builder so an
   * unrolled pass is seeded exactly as a live-added one.
   */
  buildLiveEditDeps(projectPath: string): Promise<LiveEditDeps>;
  executionContract: GraphExecutionContract;
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
   * parallel scheduling pass to the permits not held or reserved by this
   * execution. Parked approval and user-input pollers remain in the lifecycle
   * set but release their query permit until they can resume. Defaults to the
   * semaphore's configured limit.
   */
  getMaxConcurrentQueries: () => Promise<number>;
  createJobId?: () => string;
  /**
   * Read tracked dirty paths from the session worktree. Used by the pre-batch
   * preflight to halt before scheduling worktree-isolation contexts whose
   * session publication would fail. Inspection errors halt before admission.
   */
  getSessionWorktreeDirtyPaths(input: {
    sessionWorktreePath: string;
  }): Promise<DirtyPath[]>;
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
   * loop's decision-application mutation.
   */
  approvalGateService: ApprovalGateService;
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
   * withdraws all parked questions on abort through it.
   */
  userInputGateService: UserInputGateService;
  /**
   * Publisher for the approval-resolved history/SSE event emitted after a
   * decision is applied.
   */
  eventPublisher: ReturnType<typeof createGraphWorkflowExecutionEventPublisher>;
  /**
   * Conversation single-flight lock probes for the decision-application
   * quiescence rule: the loop probes `isConversationBusy` on the wait
   * interval and acquires once free, holding the lock across the approved
   * merge or rejected remediation seeding.
   */
  isConversationBusy(
    projectPath: string,
    sessionName: string,
    conversationId: string,
  ): boolean;
  acquireConversationLock(
    projectPath: string,
    sessionName: string,
    conversationId: string,
  ): () => void;
  contextLanding: ContextLanding;
}

type QueryCapacityLeaseState = "held" | "released" | "waiting";

interface QueryCapacityWaiter {
  contextId: string;
  resolve(acquired: boolean): void;
  signal: AbortSignal;
  abort(): void;
}

interface QueryCapacityProgressWait {
  promise: Promise<void>;
  cancel(): void;
}

interface QueryCapacityTransientLease {
  release(): void;
}

interface QueryCapacitySnapshot {
  generation: number;
  held: number;
  released: number;
  waiting: number;
  reserved: number;
  transient: number;
  available: number;
}

/**
 * Local admission ledger for one execution loop. `inFlight` continues to own
 * lifecycle and join safety; this ledger answers only whether a runner can
 * issue another SDK query. Scheduler reservations and gate resumptions share
 * one synchronous authority so they cannot both claim the last permit across
 * an awaited scheduling mutation.
 */
function createQueryCapacityCoordinator(limit: number) {
  const leases = new Map<string, QueryCapacityLeaseState>();
  const reacquireQueue: QueryCapacityWaiter[] = [];
  const progressWaiters = new Set<() => void>();
  let schedulerReservations = 0;
  let transientReservations = 0;
  let generation = 0;

  function count(state: QueryCapacityLeaseState): number {
    let total = 0;
    for (const current of leases.values()) {
      if (current === state) total++;
    }
    return total;
  }

  function available(): number {
    return Math.max(
      0,
      limit - count("held") - schedulerReservations - transientReservations,
    );
  }

  function signalProgress(): void {
    generation++;
    const waiters = [...progressWaiters];
    progressWaiters.clear();
    for (const resolve of waiters) resolve();
  }

  function removeReacquireWaiter(
    contextId: string,
  ): QueryCapacityWaiter | null {
    const index = reacquireQueue.findIndex(
      (waiter) => waiter.contextId === contextId,
    );
    if (index < 0) return null;
    return reacquireQueue.splice(index, 1)[0] ?? null;
  }

  function grantReacquireWaiters(): void {
    while (available() > 0 && reacquireQueue.length > 0) {
      const waiter = reacquireQueue.shift()!;
      if (waiter.signal.aborted) {
        leases.set(waiter.contextId, "released");
        waiter.resolve(false);
        continue;
      }
      waiter.signal.removeEventListener("abort", waiter.abort);
      leases.set(waiter.contextId, "held");
      waiter.resolve(true);
    }
  }

  function snapshot(): QueryCapacitySnapshot {
    return {
      generation,
      held: count("held"),
      released: count("released"),
      waiting: count("waiting"),
      reserved: schedulerReservations,
      transient: transientReservations,
      available: available(),
    };
  }

  function createProgressWait(
    observedGeneration: number,
  ): QueryCapacityProgressWait {
    if (generation !== observedGeneration) {
      return { promise: Promise.resolve(), cancel() {} };
    }
    let resolvePromise!: () => void;
    const promise = new Promise<void>((resolve) => {
      resolvePromise = resolve;
    });
    const resolve = () => {
      progressWaiters.delete(resolve);
      resolvePromise();
    };
    progressWaiters.add(resolve);
    if (generation !== observedGeneration) resolve();
    return {
      promise,
      cancel() {
        progressWaiters.delete(resolve);
      },
    };
  }

  return {
    snapshot,
    createProgressWait,

    tryAcquireTransient(): QueryCapacityTransientLease | null {
      // A gate resumption that was already queued owns FIFO priority over
      // orchestration work that has not started yet.
      grantReacquireWaiters();
      if (available() <= 0) return null;
      transientReservations++;
      let released = false;
      return {
        release() {
          if (released) return;
          released = true;
          transientReservations--;
          grantReacquireWaiters();
          signalProgress();
        },
      };
    },

    reserveForScheduler(): number {
      grantReacquireWaiters();
      const reserved = available();
      schedulerReservations += reserved;
      return reserved;
    },

    settleSchedulerReservation(
      reserved: number,
      scheduledContextIds: readonly string[],
    ): void {
      if (
        reserved > schedulerReservations ||
        scheduledContextIds.length > reserved
      ) {
        throw new Error(
          `Invalid query-capacity reservation settlement: reserved=${reserved}, outstanding=${schedulerReservations}, scheduled=${scheduledContextIds.length}`,
        );
      }
      for (const contextId of scheduledContextIds) {
        if (leases.has(contextId)) {
          throw new Error(
            `Context "${contextId}" already owns query-capacity state`,
          );
        }
      }
      schedulerReservations -= reserved;
      for (const contextId of scheduledContextIds) {
        leases.set(contextId, "held");
      }
      grantReacquireWaiters();
    },

    cancelSchedulerReservation(reserved: number): void {
      if (reserved > schedulerReservations) {
        throw new Error(
          `Invalid query-capacity reservation cancellation: reserved=${reserved}, outstanding=${schedulerReservations}`,
        );
      }
      schedulerReservations -= reserved;
      grantReacquireWaiters();
    },

    registerReleased(contextId: string): void {
      const current = leases.get(contextId);
      if (current === "released") return;
      if (current !== undefined) {
        throw new Error(
          `Context "${contextId}" cannot enter a parked query-capacity wait from ${current}`,
        );
      }
      leases.set(contextId, "released");
    },

    release(contextId: string): void {
      const current = leases.get(contextId);
      if (current === "released" || current === "waiting") return;
      if (current !== "held") {
        throw new Error(
          `Context "${contextId}" cannot release missing query capacity`,
        );
      }
      leases.set(contextId, "released");
      grantReacquireWaiters();
      signalProgress();
    },

    reacquire(contextId: string, signal: AbortSignal): Promise<boolean> {
      const current = leases.get(contextId);
      if (current === "held") return Promise.resolve(true);
      if (current !== "released") {
        throw new Error(
          `Context "${contextId}" cannot reacquire query capacity from ${current ?? "missing"}`,
        );
      }
      if (signal.aborted) return Promise.resolve(false);

      leases.set(contextId, "waiting");
      return new Promise<boolean>((resolve) => {
        const waiter: QueryCapacityWaiter = {
          contextId,
          resolve,
          signal,
          abort() {
            const removed = removeReacquireWaiter(contextId);
            if (removed === null) return;
            leases.set(contextId, "released");
            resolve(false);
          },
        };
        reacquireQueue.push(waiter);
        signal.addEventListener("abort", waiter.abort, { once: true });
        grantReacquireWaiters();
      });
    },

    finish(contextId: string): void {
      const previous = leases.get(contextId);
      const waiter = removeReacquireWaiter(contextId);
      if (waiter !== null) {
        waiter.signal.removeEventListener("abort", waiter.abort);
        waiter.resolve(false);
      }
      if (!leases.delete(contextId)) return;
      grantReacquireWaiters();
      if (previous === "held") signalProgress();
    },
  };
}

// -- Active loop registry -----------------------------------------------------

// Next.js evaluates route handlers in separate module graphs, so process-local
// ownership must live on globalThis for status reads to observe loops started
// by start/resume routes. Keyed by session, valued by the owning loop token.
// Two loop instances can briefly overlap; an exiting loop only deletes the
// entry when it still owns it so a stale generation cannot hide its successor.
const ACTIVE_LOOPS_KEY = "__cc_graph_workflow_active_loops" as const;

interface ActiveExecutionLoop {
  token: string;
  abortController: AbortController;
  fence: GraphWorkflowLoopFence;
  result: Promise<GraphWorkflowExecution>;
}

function getActiveLoops(): Map<string, ActiveExecutionLoop> {
  return getGlobalSingleton(
    ACTIVE_LOOPS_KEY,
    () => new Map<string, ActiveExecutionLoop>(),
  );
}

function loopKey(projectPath: string, sessionName: string): string {
  return `${projectPath}::${sessionName}`;
}

/** Check if an execution loop is currently running for the given session. */
export function isExecutionLoopActive(
  projectPath: string,
  sessionName: string,
): boolean {
  return getActiveLoops().has(loopKey(projectPath, sessionName));
}

export function abortExecutionLoop(
  projectPath: string,
  sessionName: string,
): boolean {
  const active = getActiveLoops().get(loopKey(projectPath, sessionName));
  if (!active) return false;
  active.abortController.abort();
  return true;
}

/** Reset the active loop registry (for testing only). */
export function _resetActiveLoopsForTesting(): void {
  getActiveLoops().clear();
}

// -- Helpers ------------------------------------------------------------------

function isRetryableIterationError(error: unknown): boolean {
  const unwrapped =
    error instanceof IterationFailureWithProgressError
      ? error.originalError
      : error;
  return (
    unwrapped instanceof AgentTurnFailedError &&
    unwrapped.failure?.kind === "session_died" &&
    unwrapped.failure.retryable
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

/**
 * An implementer turn torn down by the per-turn inactivity watchdog. Provably
 * dead air (not a validation or provider failure), so the loop grants one
 * automatic recovery: the context resets to ready with a rotation scheduled,
 * and the retry runs on a fresh conversation instead of the stalled thread.
 */
function isStallCausedTurnFailure(error: unknown): boolean {
  const unwrapped =
    error instanceof IterationFailureWithProgressError
      ? error.originalError
      : error;
  return (
    unwrapped instanceof AgentTurnFailedError && unwrapped.cause === "stall"
  );
}

/**
 * A turn the backend SDK itself terminated. Keyed on the cause because the
 * diagnostics carrying these failures are emitted by the SDK, not by this
 * repo, so their text changes without notice and no message pattern can be a
 * reliable net (execution 2560164c halted on
 * `[ede_diagnostic] result_type=user … stop_reason=tool_use`, a string that
 * exists nowhere here). A deterministic failure — auth, config — simply fails
 * its second strike and halts.
 */
function isSdkErrorCausedTurnFailure(error: unknown): boolean {
  const unwrapped =
    error instanceof IterationFailureWithProgressError
      ? error.originalError
      : error;
  return (
    unwrapped instanceof AgentTurnFailedError && unwrapped.cause === "sdk_error"
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

/**
 * Answers recorded for a validator lane that no turn has been handed yet.
 *
 * Only a validator lane counts. Its ask lives inside an open round it still owes
 * a verdict, and the turn that asked is over — nothing but a re-dispatch can
 * deliver the answer, so a context holding one is not finished however its
 * status reads. An implementer's fast answer lands on the conversation its own
 * iteration is still driving and keeps the pre-cohort fall-through (R5.4).
 */
function hasUndeliveredValidatorAnswer(
  contextState: GraphWorkflowExecutionContextState | undefined,
): boolean {
  if (contextState === undefined) return false;
  return answeredPendingUserInputs(contextState).some(
    (entry) => entry.lane === "context_validator",
  );
}

async function defaultWaitForCollaborationProgress(_input: {
  projectPath: string;
  sessionName: string;
  executionId: string;
}): Promise<void> {
  await sleep(1000);
}

async function defaultWaitForApprovalProgress(_input: {
  projectPath: string;
  sessionName: string;
  executionId: string;
  contextId: string;
}): Promise<void> {
  await sleep(1000);
}

async function defaultWaitForUserInputProgress(_input: {
  projectPath: string;
  sessionName: string;
  executionId: string;
  contextId: string;
}): Promise<void> {
  await sleep(1000);
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
  | {
      applied: true;
      /**
       * False when an approved decision could NOT complete the context because
       * it still owes its declared output — a live edit replaced the contract
       * under the park, taking the payload the approval was given for with it.
       * The context returns to `running` and the caller re-iterates instead of
       * committing.
       */
      completed: boolean;
    }
  | {
      applied: false;
      status: Exclude<GraphWorkflowStatus, "running">;
    };

// -- Execution loop -----------------------------------------------------------

const logger = createLogger("graph-workflow-execution-loop");

export function createGraphWorkflowExecutionLoop(
  deps: GraphWorkflowExecutionLoopDeps,
) {
  if (typeof deps.getSessionWorktreeDirtyPaths !== "function") {
    logger.error(
      "graph-workflow.configuration.missing_worktree_inspection",
      {},
    );
    throw new Error("Worktree inspection is required");
  }
  const runCircuitBreakerGate =
    deps.runCircuitBreakerGate ?? defaultRunCircuitBreakerGate;
  const getMaxConcurrentQueries = deps.getMaxConcurrentQueries;
  const createJobId = deps.createJobId ?? (() => randomUUID());
  const {
    landingEvidenceProber,
    contextLanding,
    resyncSharedIndex,
    buildLiveEditDeps,
    approvalGateService,
    eventPublisher,
    userInputGateService,
    isConversationBusy,
    acquireConversationLock,
  } = deps;
  const executionContract = deps.executionContract;

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
      () => runWithLoopFence(fence, () => admitLoop(input, fence)),
      captureTraceContext(),
    );
  }

  async function admitLoop(
    input: GraphWorkflowExecutionLoopInput,
    fence: GraphWorkflowLoopFence,
  ): Promise<GraphWorkflowExecution> {
    const current = await deps.executionRepository.getActive(
      input.projectPath,
      input.sessionName,
    );
    if (current === null || !matchesLoopFence(fence, current))
      throw new StaleLoopFenceError(fence, current);
    if (current.status !== "running") return current;
    const key = loopKey(input.projectPath, input.sessionName);
    const active = getActiveLoops().get(key);
    if (active && !active.abortController.signal.aborted) {
      if (
        active.fence.executionId === fence.executionId &&
        active.fence.loopEpoch === fence.loopEpoch
      ) {
        return active.result;
      }
      logger.info("graph-workflow.loop.claim_refused", {
        executionId: fence.executionId,
        loopEpoch: fence.loopEpoch,
        ownerExecutionId: active.fence.executionId,
        ownerLoopEpoch: active.fence.loopEpoch,
      });
      throw new StaleLoopFenceError(fence, {
        id: active.fence.executionId,
        loopEpoch: active.fence.loopEpoch,
      });
    }
    const loopInstanceToken = randomUUID();
    const loopAbortController = new AbortController();
    const result = Promise.resolve()
      .then(() =>
        runImpl(
          { ...input, execution: current },
          fence,
          loopInstanceToken,
          loopAbortController,
        ),
      )
      .finally(() => {
        if (getActiveLoops().get(key)?.token === loopInstanceToken)
          getActiveLoops().delete(key);
      });
    getActiveLoops().set(key, {
      token: loopInstanceToken,
      abortController: loopAbortController,
      fence,
      result,
    });
    return result;
  }

  async function runImpl(
    input: GraphWorkflowExecutionLoopInput,
    fence: GraphWorkflowLoopFence,
    loopInstanceToken: string,
    loopAbortController: AbortController,
  ): Promise<GraphWorkflowExecution> {
    const key = loopKey(input.projectPath, input.sessionName);
    let execution = input.execution;
    const retryableRecoveryAttempts = new Map<string, number>();
    // SDK-caused turn failures get their own strike count because the
    // post-implementer sites that raise them (advisory response, output
    // capture) run after a turn has already completed, so every strike carries
    // partial iteration progress. Sharing the transport counter — which
    // partial progress clears — would let each strike refund its own budget
    // and retry without bound, past both the max-iteration and circuit-breaker
    // guards. Only a successful iteration clears this one.
    const sdkErrorRecoveryAttempts = new Map<string, number>();
    // Answers consumed on the awaiting-user-input resume path, keyed by context.
    // Stashed before `continue` re-schedules the context, then drained into the
    // next `runIteration` call so each resumed lane pins its asking conversation
    // and embeds its own answers block. Deleted on drain — one resume.
    const pendingResumeUserInput = new Map<string, ConsumeAnswersResult[]>();
    const inFlight = new Map<string, Promise<void>>();
    const pendingContextTaskErrors: unknown[] = [];
    const deferredJoinBusySignatures = new Map<string, string>();
    let queryCapacity: ReturnType<typeof createQueryCapacityCoordinator>;
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
     * Settle every route the graph can currently decide (D4 R2/R3/R4).
     *
     * Runs BEFORE scheduling and before the joins, because everything after it
     * reads the results: a target the routing declined must be `skipped` before
     * the scheduler can consider it, before a join can plan over its lane, and
     * before the completion invariant counts its tasks. Reconciliation of
     * landing intents rides the same mutation, so a crash between a commit and
     * its intent settlement is repaired on the next tick as well as at resume.
     *
     * A routing halt applies nothing and stops the pass — routing on a graph the
     * engine cannot resolve is exactly the guess R2.4/R3.1 forbid.
     */
    async function settleRoutesForPass(): Promise<"settled" | "halted"> {
      const branchEvidence = await probeLandingEvidence();

      const { execution: next, settlement } = await deps.executionRepository
        .mutateActive(input.projectPath, input.sessionName, (current) => {
          const settlement: { value: RouteSettlementOutcome | null } = {
            value: null,
          };

          if (current.status !== "running") return unchanged({ settlement });
          if (current.pendingHaltReason !== null)
            return unchanged({ settlement });
          // `mutateActive` hands the reducer its own clone, so settling in
          // place here cannot reach the caller's snapshot.
          settlement.value = settleRoutes(current, {
            now: new Date().toISOString(),
            branchEvidence,
          });
          const outcome = settlement.value;
          if (
            outcome.skippedContextIds.length === 0 &&
            outcome.settledSourceContextIds.length === 0 &&
            outcome.reconciledContextIds.length === 0
          )
            return unchanged({ settlement });
          return changed(current, { settlement });
        })
        .then((mutation) => ({
          execution: mutation.execution,
          ...mutationValue(mutation),
        }));
      adoptExecution(next);

      const outcome = settlement.value;
      if (!outcome) return "settled";

      for (const contextId of outcome.skippedContextIds) {
        const edgeEvaluations =
          execution.contextStates[contextId]?.skipReason?.edgeEvaluations ?? [];
        logger.info("graph-workflow.route.context_skipped", {
          executionId: execution.id,
          contextId,
          edgeEvaluations,
        });
        execLogger?.lifecycle("route.context_skipped", {
          contextId,
          edgeEvaluations,
        });
      }
      for (const sourceContextId of outcome.settledSourceContextIds) {
        const record = execution.routeSettlements[sourceContextId];
        logger.info("graph-workflow.route.resolved", {
          executionId: execution.id,
          sourceContextId,
          effectiveSourceContextId: record?.effectiveSourceContextId ?? null,
          captureIteration: record?.captureIteration ?? null,
          edgeEvaluations: record?.edgeEvaluations ?? [],
          activatedEdgeIds: record?.activatedEdgeIds ?? [],
          inactiveEdgeIds: record?.inactiveEdgeIds ?? [],
          routeControlRevision: record?.routeControlRevision ?? 0,
        });
        execLogger?.lifecycle("route.resolved", {
          contextId: sourceContextId,
          effectiveSourceContextId: record?.effectiveSourceContextId ?? null,
          captureIteration: record?.captureIteration ?? null,
          routeControlRevision: record?.routeControlRevision ?? 0,
          edgeEvaluations: record?.edgeEvaluations ?? [],
          activatedEdgeIds: record?.activatedEdgeIds ?? [],
          inactiveEdgeIds: record?.inactiveEdgeIds ?? [],
        });
      }
      for (const contextId of outcome.reconciledContextIds) {
        execLogger?.lifecycle("landing.reconciled", {
          contextId,
          state:
            execution.contextStates[contextId]?.landingIntent?.state ?? null,
        });
      }

      if (!outcome.halt) return "settled";

      logger.error("graph-workflow.route.halted", {
        executionId: execution.id,
        haltType: outcome.halt.type,
        contextId: outcome.halt.contextId,
      });
      execLogger?.lifecycle("route.halted", {
        contextId: outcome.halt.contextId,
        haltType: outcome.halt.type,
      });
      await recordHalt(outcome.halt);
      return "halted";
    }

    /**
     * Commit the work of a context that finished but never reached its commit
     * phase (D4 R9.4, decision D8).
     *
     * Runs AFTER route settlement, so reconciliation has already landed every
     * intent whose commit DID happen — the branch carries that evidence and a
     * probe reads it back. What is left is the earlier crash window, where the
     * process died between the completion mutation and the commit: no trailer,
     * no lane bookkeeping, nothing for a probe to find. Only a landed intent
     * satisfies routing, so without this the dependents — and any loop settling
     * on that context — would block forever on a commit that will never come.
     *
     * Runs BEFORE loop settlement so the repaired landing settles in the same
     * pass, which is what "committed on resume before settlement" means.
     *
     * A context still in flight is skipped: its own commit phase is running,
     * and the window between its completion mutation and that commit is the
     * NORMAL state, not a crash.
     */
    async function repairUnlandedCommitsForPass(): Promise<
      "settled" | "changed" | "halted"
    > {
      let repaired = false;
      for (const repair of collectLandingCommitRepairs(execution)) {
        if (inFlight.has(repair.contextId)) continue;

        execLogger?.lifecycle("landing.commit_repaired", {
          contextId: repair.contextId,
          mode: repair.mode,
        });
        logger.info("graph-workflow.landing.commit_repair_attempted", {
          executionId: execution.id,
          contextId: repair.contextId,
          mode: repair.mode,
        });

        if (repair.mode === "lane_commit") {
          adoptExecution(
            (
              await contextLanding.land({
                ...input,
                executionId: execution.id,
                contextId: repair.contextId,
                preTurnHeadSha: repair.baselineSha,
                target: {
                  isolation: "worktree",
                  laneId: repair.laneId,
                  worktreePath: repair.worktreePath,
                  branchName: repair.branchName,
                },
              })
            ).execution,
          );
        } else {
          adoptExecution(
            (
              await contextLanding.land({
                ...input,
                executionId: execution.id,
                contextId: repair.contextId,
                preTurnHeadSha: repair.baselineSha,
                target: { isolation: "session" },
              })
            ).execution,
          );
        }
        // Re-read sibling progress before deciding whether the repair pass can continue.
        await refreshExecution();
        if (execution.pendingHaltReason !== null) return "halted";
        repaired = true;
      }
      return repaired ? "changed" : "settled";
    }

    /**
     * Settle every loop the graph can currently decide (D4 R9/R16).
     *
     * Runs immediately AFTER route settlement and before scheduling: activation
     * reads the routes and the skips that pass just applied, and everything
     * downstream of a concluded loop reads the ledger this writes.
     *
     * A loop halt stops the pass, exactly as a routing halt does, and a halt
     * raised by a DECISION applies nothing; the shared-backstop halt keeps only
     * the grants it had already admitted in definition order (R10.3).
     * Materializations are decided here and installed through the staging seam,
     * because unrolling is whole-execution validation work that cannot run
     * inside the write queue.
     */
    async function settleLoopsForPass(): Promise<
      "settled" | "changed" | "halted"
    > {
      const { execution: next, settlement } = await deps.executionRepository
        .mutateActive(input.projectPath, input.sessionName, (current) => {
          const settlement: { value: LoopSettlementOutcome | null } = {
            value: null,
          };

          if (current.status !== "running") return unchanged({ settlement });
          if (current.pendingHaltReason !== null)
            return unchanged({ settlement });
          settlement.value = settleLoops(current, {
            now: new Date().toISOString(),
          });
          const outcome = settlement.value;
          if (
            !outcome.ledgerChanged &&
            outcome.activatedLoopGroupIds.length === 0 &&
            outcome.skippedLoopGroupIds.length === 0 &&
            outcome.concludedLoopGroupIds.length === 0
          )
            return unchanged({ settlement });
          return changed(current, { settlement });
        })
        .then((mutation) => ({
          execution: mutation.execution,
          ...mutationValue(mutation),
        }));
      adoptExecution(next);

      const outcome = settlement.value;
      if (!outcome) return "settled";

      for (const loopGroupId of outcome.activatedLoopGroupIds) {
        execLogger?.lifecycle("loop.activated", { loopGroupId });
      }
      for (const loopGroupId of outcome.skippedLoopGroupIds) {
        execLogger?.lifecycle("loop.skipped", { loopGroupId });
      }
      for (const loopGroupId of outcome.concludedLoopGroupIds) {
        logger.info("graph-workflow.loop.concluded", {
          executionId: execution.id,
          loopGroupId,
          passCount: execution.loopStates[loopGroupId]?.passCount ?? 0,
        });
        execLogger?.lifecycle("loop.concluded", {
          loopGroupId,
          concludingContextId:
            execution.loopStates[loopGroupId]?.concludingExitContextId ?? null,
        });
      }

      // Before the halt, not after it: a decision-raised halt reports no
      // materializations at all, and the one halt that can — the shared pass
      // backstop refusing a LATER loop — leaves the grants it already admitted
      // durable (R10.3). Their unrolls have to install, or the ledger would hold
      // a reservation for a pass that no resume ever creates.
      const liveRevisionBeforeMaterialization = execution.liveRevision;
      for (const request of outcome.materializations) {
        await materializeLoopPass(request);
      }

      if (outcome.halt) {
        logger.error("graph-workflow.loop.halted", {
          executionId: execution.id,
          haltType: outcome.halt.type,
          loopGroupId: outcome.halt.loopGroupId,
          pass: outcome.halt.pass,
        });
        execLogger?.lifecycle("loop.halted", {
          loopGroupId: outcome.halt.loopGroupId,
          haltType: outcome.halt.type,
        });
        await recordHalt(outcome.halt);
        return "halted";
      }

      return outcome.activatedLoopGroupIds.length > 0 ||
        outcome.skippedLoopGroupIds.length > 0 ||
        outcome.concludedLoopGroupIds.length > 0 ||
        execution.liveRevision !== liveRevisionBeforeMaterialization
        ? "changed"
        : "settled";
    }

    async function settleSchedulingInputs(): Promise<"settled" | "halted"> {
      while (
        execution.status === "running" &&
        execution.pendingHaltReason === null
      ) {
        if ((await settleRoutesForPass()) === "halted") return "halted";
        const repairs = await repairUnlandedCommitsForPass();
        if (repairs === "halted") return "halted";
        if (repairs === "changed") continue;
        const loops = await settleLoopsForPass();
        if (loops !== "changed") return loops;
      }
      return execution.pendingHaltReason === null ? "settled" : "halted";
    }

    /**
     * Install one decided unroll through the prepare/finalize staging seam.
     *
     * Prepare runs outside the write queue (whole-execution validation), so the
     * graph can move underneath it; `reprepare` is not a rejection and simply
     * asks for a retry against fresher state. A second failure is left to the
     * next scheduling pass, which re-decides from durable state — the decision
     * record makes that safe to repeat.
     *
     * `liveRevision` moves by exactly one per installed unroll, the same
     * contract every other accepted mutation of the working definition honors,
     * so a client editing against a pre-unroll outline is refused rather than
     * silently applied to a graph that grew.
     */
    async function materializeLoopPass(
      request: LoopMaterializationRequest,
    ): Promise<void> {
      const liveEditDeps = await buildLiveEditDeps(input.projectPath);
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const preparedLiveEditDeps: LiveEditDeps = {
          ...liveEditDeps,
          executionContract: executionContract.loadLiveEdit(execution),
        };
        const prepared = prepareLoopPassMaterialization(
          execution,
          request,
          preparedLiveEditDeps,
        );
        if (!prepared.ok) {
          logger.error("graph-workflow.loop.materialize_rejected", {
            executionId: execution.id,
            loopGroupId: request.loopGroupId,
            pass: request.nextPass,
            code: prepared.code,
            issues: prepared.issues.map((issue) => issue.code),
          });
          return;
        }

        const { execution: next, install } = await deps.executionRepository
          .mutateActive(input.projectPath, input.sessionName, (current) => {
            const install: { value: string | null } = { value: null };

            const installed = finalizeLoopPassMaterialization(
              current,
              prepared.prepared,
              request,
              { now: new Date().toISOString() },
            );
            if (!installed.ok) {
              install.value = installed.outcome;
              return unchanged({ install });
            }
            install.value = installed.install;
            return changed(
              {
                ...installed.execution,
                liveRevision: installed.execution.liveRevision + 1,
              },
              { install },
            );
          })
          .then((mutation) => ({
            execution: mutation.execution,
            ...mutationValue(mutation),
          }));
        adoptExecution(next);

        if (install.value !== "reprepare") {
          if (install.value === "spliced" || install.value === "merged") {
            logger.info("graph-workflow.loop.pass_materialized", {
              executionId: execution.id,
              loopGroupId: request.loopGroupId,
              pass: request.nextPass,
              install: install.value,
            });
            execLogger?.lifecycle("loop.pass_materialized", {
              loopGroupId: request.loopGroupId,
              pass: request.nextPass,
            });
          }
          return;
        }
      }
    }

    /**
     * Read the branch facts the commit modes land on, OUTSIDE the write queue —
     * git is I/O and reconciliation is pure (decision D8).
     *
     * Without this the only commit-mode landings ever proven are the ones the
     * committer settled in-process, so a crash between a commit and its
     * settlement would block the dependents until the next restart. The probe
     * set is the unlanded commit-mode intents of COMPLETED contexts, which is
     * empty on every pass of a run that is landing normally.
     *
     * A prober failure yields no evidence, never an exception: an unproven
     * landing blocks, which is the same answer the pass would reach anyway.
     */
    async function probeLandingEvidence(): Promise<
      ReadonlyMap<string, LandingBranchEvidence>
    > {
      const targets = collectLandingProbeTargets(execution);
      if (targets.length === 0) return new Map();
      try {
        return await landingEvidenceProber.probe(targets);
      } catch (error) {
        logger.warn("graph-workflow.landing.probe_failed", {
          executionId: execution.id,
          contextIds: targets.map((target) => target.contextId),
          error: error instanceof Error ? error.message : String(error),
        });
        return new Map();
      }
    }

    /**
     * Adopt an execution snapshot only if it still belongs to this loop's
     * generation. `getActive` is keyed by session, not execution, so after an
     * abort/replace or a halt/resume the session's active state belongs to a
     * successor generation — adopting it would turn this loop into a second,
     * unaccounted driver of state it does not own (the incident-622782a0
     * zombie). Staleness throws; the loop's error handling exits silently.
     *
     * The one snapshot outside this loop's generation it must still adopt is
     * its own retirement: pause/abort/halt/complete bump the epoch atomically
     * with the status change, so an operator-initiated transition fences this
     * loop out of the very execution it is driving. Refusing that snapshot
     * would make the loop return the pre-transition state it happens to be
     * holding — reporting `running` for an execution the operator aborted —
     * and skip the exit path that reacts to a non-running status. Adopting it
     * is read-only: writes remain fenced at the repository.
     */
    function adoptExecution(next: GraphWorkflowExecution | null): void {
      if (
        next === null ||
        !(matchesLoopFence(fence, next) || isOwnRetiredGeneration(fence, next))
      ) {
        throw new StaleLoopFenceError(fence, next);
      }
      execution = next;
    }

    /** Refresh from the session's active execution, fence-checked. */
    async function refreshExecution(): Promise<void> {
      adoptExecution(
        await deps.executionRepository.getActive(
          input.projectPath,
          input.sessionName,
        ),
      );
    }

    async function reacquireQueryCapacity(contextId: string): Promise<boolean> {
      const acquired = await queryCapacity.reacquire(
        contextId,
        loopAbortController.signal,
      );
      if (!acquired) return false;
      await refreshExecution();
      return (
        execution.status === "running" && execution.pendingHaltReason === null
      );
    }

    async function waitForInFlightOrCapacityProgress(
      observedGeneration: number,
    ): Promise<void> {
      const progress = queryCapacity.createProgressWait(observedGeneration);
      try {
        await Promise.race([...inFlight.values(), progress.promise]);
      } finally {
        progress.cancel();
      }
    }

    function startContextTask(contextId: string): void {
      const task = runContextTask(contextId);
      inFlight.set(contextId, task);
      const finish = () => {
        queryCapacity.finish(contextId);
        inFlight.delete(contextId);
      };
      // Keep the ORIGINAL task in `inFlight`: if it rejects, Promise.race must
      // observe that failure before the capacity-progress signal emitted by
      // cleanup. Chaining `.finally()` into the stored promise lets that signal
      // win the race and silently turns a failed turn into a reschedule loop.
      void task.then(finish, (error) => {
        pendingContextTaskErrors.push(error);
        finish();
      });
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
        conversationIds: unansweredPendingUserInputs(
          execution.contextStates[contextId] ?? { pendingUserInputs: {} },
        ).map((entry) => entry.record.conversationId),
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

        const contextState = execution.contextStates[contextId] ?? {
          pendingUserInputs: {},
        };
        const parked = pendingUserInputEntries(contextState);
        if (parked.length === 0) {
          // Every record is gone while the execution is still running: they
          // were withdrawn (abort cleanup raced this wait). The context is no
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

        // Resume as soon as ANY lane's answers land. The answered lane is the
        // only one the resumed iteration dispatches — a sibling the human has
        // not reached yet keeps its own park and its own question — so waiting
        // for the whole cohort here would serialize lanes that review
        // independently (R9.1).
        const answered = answeredPendingUserInputs(contextState);
        if (answered.length > 0) {
          execLogger?.iteration(contextId, "user_input.wait_exit", {
            cause: "answers_observed",
            questionBatchIds: answered.map(
              (entry) => entry.record.questionBatchId,
            ),
            stillParkedCount: parked.length - answered.length,
          });
          logger.info("graph-workflow.user_input.wait_exit", {
            executionId: execution.id,
            contextId,
            cause: "answers_observed",
            laneKeys: answered.map((entry) => entry.laneKey),
            stillParkedCount: parked.length - answered.length,
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
      // Applied-decision observability captured (pure) inside the reducer and
      // emitted AFTER the mutation commits, so the write-queue critical section
      // performs no logging I/O (`no-slow-work-in-critical-section`). The result
      // carries the applied decision and whether output requirements withheld it.

      const {
        execution: mutationExecution,
        exitedStatus,
        appliedBox,
        withheldBox,
      } = await deps.executionRepository
        .mutateActive<{
          exitedStatus: Exclude<
            GraphWorkflowExecution["status"],
            "running"
          > | null;
          appliedBox: { value: AppliedApprovalDecision | null };
          withheldBox: { value: boolean };
        }>(input.projectPath, input.sessionName, (e) => {
          let exitedStatus: Exclude<GraphWorkflowStatus, "running"> | null =
            null;
          const appliedBox: { value: AppliedApprovalDecision | null } = {
            value: null,
          };
          const withheldBox = { value: false };

          if (e.status !== "running") {
            exitedStatus = e.status;
            return unchanged({ exitedStatus, appliedBox, withheldBox });
          }
          const next = structuredClone(e);
          if (decision.type === "approved") {
            appliedBox.value = approvalGateService.applyApprovedDecision(
              next,
              contextId,
            );
            // An approval attests to the work, not to the contract. A live
            // edit can replace this context's `outputSchema` while it is
            // parked, and the edit drops the payload banked under the old
            // contract — completing here would leave a completed context with
            // no validated output for the schema it now declares (R2, R7.6,
            // R7.7).
            //
            // The context goes back to `ready` instead of `running`: this
            // mutation is the durable record of the abandoned park, and it
            // commits before the resolved-event publication and before any
            // local continuation. `ready` is the scheduler's own eligibility
            // status, so a pause, a restart, or a failure between here and the
            // caller leaves work the scheduler picks up again; `running` with
            // no live runner would be invisible to scheduling, to restart
            // normalization (which only reaches `activeContextIds`) and to the
            // parked-status re-entry passes, and the task-based completion
            // guard cannot see the owed output either.
            withheldBox.value = contextOwesOutput(next, contextId);
            if (next.contextStates[contextId]) {
              transitionContextStatus(
                next,
                contextId,
                withheldBox.value ? "ready" : "completed",
                {
                  reason: withheldBox.value
                    ? "approval_gate.apply_approved_decision_owes_output"
                    : "approval_gate.apply_approved_decision",
                },
              );
            }
          } else {
            appliedBox.value = approvalGateService.applyRejectedDecision(
              next,
              contextId,
            );
          }
          // Decision application rebuilds the snapshot the same way the
          // gate-off completion path would have; there is never a live
          // iteration at application time.
          next.machineSnapshot = buildLifecycleSnapshot(next, {
            hasLiveIteration: false,
          });
          return changed(next, { exitedStatus, appliedBox, withheldBox });
        })
        .then((mutation) => ({
          execution: mutation.execution,
          ...mutationValue(mutation),
        }));
      execution = mutationExecution;
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
      // Post-commit: emit `gate.applied` now that the decision has persisted.
      const applied = appliedBox.value;
      if (applied !== null) {
        logger.info("gate.applied", {
          executionId: execution.id,
          contextId,
          decisionType: applied.decisionType,
          ...(applied.decisionType === "rejected"
            ? {
                remediationTaskId: applied.remediationTaskId,
                rejectionMessageLength: applied.rejectionMessageLength,
              }
            : {}),
        });
      }
      if (withheldBox.value) {
        execLogger?.iteration(contextId, "gate.completion_withheld", {
          reason: "output_not_captured",
        });
        logger.warn("graph-workflow.gate.completion_withheld", {
          executionId: execution.id,
          contextId,
          reason: "output_not_captured",
        });
      }
      return { applied: true, completed: !withheldBox.value };
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
      execution = await deps.executionRepository
        .mutateActive(input.projectPath, input.sessionName, (latest) => {
          const delivery = eventPublisher.publishApprovalResolved({
            projectPath: input.projectPath,
            sessionName: input.sessionName,
            execution: latest,
            contextId,
            conversationId,
            decision: decision.type,
            message: decision.type === "rejected" ? decision.message : null,
            decidedAt: decision.decidedAt,
          });
          return eventsOnly(undefined, delivery);
        })
        .then((mutation) => mutation.execution);
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
          return (
            state.isolation === "worktree" ||
            ctx.placement.lane !== SESSION_LANE_ID
          );
        });
      if (!needsWorktreeBatch) return false;

      let dirty: DirtyPath[];
      try {
        dirty = await deps.getSessionWorktreeDirtyPaths({
          sessionWorktreePath: session.worktreePath,
        });
      } catch (error) {
        const message = getErrorMessage(error);
        logger.error("graph-workflow.preflight.dirty_read_failed", {
          executionId: execution.id,
          sessionWorktreePath: session.worktreePath,
          error: message,
        });
        await recordHalt({
          type: "execution_loop_failed",
          contextId: null,
          cause: "io",
          message,
        });
        return true;
      }
      const trackedDirty = dirty.filter((p) => p.tracked);
      if (trackedDirty.length === 0) return false;

      const firstEligibleContextId =
        execution.workingDefinition.executionContexts.find((ctx) => {
          const state = execution.contextStates[ctx.id];
          if (!state) return false;
          if (state.status !== "pending" && state.status !== "ready")
            return false;
          return (
            state.isolation === "worktree" ||
            ctx.placement.lane !== SESSION_LANE_ID
          );
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

    /**
     * Capture review evidence before work begins, alongside the attempt's
     * adoption baseline. Resumed attempts never replace either captured origin.
     */
    async function persistLandingBaseline(
      contextId: string,
      baselineSha: string | null,
    ): Promise<void> {
      if (baselineSha === null) return;
      let originCaptured = false;
      const next = await deps.executionRepository
        .mutateActive(input.projectPath, input.sessionName, (current) => {
          const state = current.contextStates[contextId];
          if (!state) return unchanged();
          const draft = structuredClone(current);
          originCaptured = captureContextReviewOrigin(
            draft,
            contextId,
            baselineSha,
            new Date().toISOString(),
          );
          const intent = draft.contextStates[contextId]!.landingIntent;
          const needsBaseline =
            intent?.state === "pending" && intent.baselineSha === null;
          if (!originCaptured && !needsBaseline) return unchanged();
          if (needsBaseline) intent.baselineSha = baselineSha;
          return changed(draft);
        })
        .then((mutation) => mutation.execution);
      adoptExecution(next);
      if (originCaptured) {
        logger.info("graph-workflow.review_origin.captured", {
          executionId: execution.id,
          contextId,
          baselineSha,
          laneId: execution.contextStates[contextId]?.reviewOrigin?.laneId,
        });
      }
    }

    /**
     * Repair the lane's shared index before a full-access member's first turn
     * (R7.2).
     *
     * An owned landing writes back only the entries for the paths it committed
     * (D7), so any entry that drifted from HEAD another way is still wrong here
     * — and `git commit -a`, which an agent may legitimately run, builds its
     * commit from the index and would publish the deletion of a path the index
     * has no entry for. Only a whole-tree member needs this: an enveloped
     * member cannot write outside its prefixes, so it cannot run git.
     *
     * Under the session git lock, the same lock a landing holds, so a sibling
     * landing cannot interleave with the reset. A failed resync must prevent the
     * turn: allowing a full-access agent to run against the stale index would
     * let `git commit -a` publish the deletion of a sibling's newly landed file.
     */
    async function prepareLaneForWholeTreeWriter(
      contextId: string,
      laneWorktreePath: string,
    ): Promise<void> {
      if (
        execution.contextStates[contextId]?.reservedOwnership?.mode !== "full"
      ) {
        return;
      }
      try {
        await deps.sessionGitLock.withSessionGitLock(
          { projectPath: input.projectPath, sessionName: input.sessionName },
          () => resyncSharedIndex(laneWorktreePath),
        );
      } catch (error) {
        logger.error("graph-workflow.lane_commit.index_resync_failed", {
          executionId: execution.id,
          contextId,
          laneWorktreePath,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    }

    async function runContextTask(contextId: string): Promise<void> {
      execLogger?.lifecycle("parallel.context_started", {
        contextId,
      });
      logger.info("graph-workflow.parallel.context_started", {
        executionId: execution.id,
        contextId,
      });

      let isolation: "session" | "worktree" = "session";
      let featureWorktreePath: string | null = null;
      let featureBranchName: string | null = null;
      let featureLaneId: string | null = null;
      // Lane HEAD captured before the context's first turn. Implementer
      // agents often commit their own work mid-turn, leaving the commit
      // phase a clean worktree; this baseline lets the committer adopt the
      // moved HEAD as the context's snapshot so commit evidence still exists.
      // Best-effort: a failed capture only disables adoption, never halts.
      let preTurnLaneHeadSha: string | null = null;
      let laneHeadCaptured = false;

      async function runCommitPhase(): Promise<void> {
        if (
          isolation === "worktree" &&
          (featureWorktreePath === null || featureBranchName === null)
        )
          return;
        const target: ContextLandingInput["target"] =
          isolation === "worktree" &&
          featureWorktreePath !== null &&
          featureBranchName !== null
            ? {
                isolation,
                worktreePath: featureWorktreePath,
                branchName: featureBranchName,
                laneId: featureLaneId,
              }
            : { isolation: "session" };
        const landed = await contextLanding.land({
          ...input,
          executionId: execution.id,
          contextId,
          preTurnHeadSha: preTurnLaneHeadSha,
          target,
        });
        adoptExecution(landed.execution);
      }

      try {
        // Inner per-context iteration loop
        // eslint-disable-next-line no-constant-condition
        contextIterations: while (true) {
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
            if (!laneHeadCaptured) {
              laneHeadCaptured = true;
              try {
                preTurnLaneHeadSha = await deps.laneCommitter.resolveHead(
                  target.worktreePath,
                );
              } catch {
                preTurnLaneHeadSha = null;
              }
              await prepareLaneForWholeTreeWriter(
                contextId,
                target.worktreePath,
              );
              await persistLandingBaseline(contextId, preTurnLaneHeadSha);
              preTurnLaneHeadSha =
                execution.contextStates[contextId]?.landingIntent
                  ?.baselineSha ?? preTurnLaneHeadSha;
            }
          } else if (!laneHeadCaptured) {
            // Session isolation: the same self-commit adoption baseline,
            // captured against the session worktree, so solo runs also carry
            // commit evidence when the implementer commits its own work.
            laneHeadCaptured = true;
            try {
              preTurnLaneHeadSha = await deps.laneCommitter.resolveHead(
                target.worktreePath,
              );
            } catch {
              preTurnLaneHeadSha = null;
            }
            await persistLandingBaseline(contextId, preTurnLaneHeadSha);
            preTurnLaneHeadSha =
              execution.contextStates[contextId]?.landingIntent?.baselineSha ??
              preTurnLaneHeadSha;
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
            queryCapacity.release(contextId);
            const outcome = await waitForApprovalResolution(contextId);
            if (
              outcome.kind === "execution_exited" ||
              outcome.kind === "halt_pending"
            ) {
              return;
            }
            if (!(await reacquireQueryCapacity(contextId))) return;

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
                if (application.completed) {
                  await runCommitPhase();
                }
                // A withheld approval hands the context back to the scheduler
                // rather than continuing here: the durable `ready` state is
                // what re-enters it, so recovery does not depend on this
                // runner surviving. The scheduler re-seeds it, the
                // validation-only iteration captures the replacement contract,
                // and the gate parks again for a fresh decision.
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
          // answers land, `consumeAnswers` clears the answered records and (once
          // no lane is left parked) flips the status back to `running`, and the
          // next iteration runs as an ordinary seeded turn (the answer-block
          // prompt + conversation pin that deliver the answers into that turn
          // are owned by later tasks).
          //
          // A RUNNING context enters here too when it holds an undelivered
          // validator answer. A cohort writes its parks only once every lane
          // settles, so an answer to a lane whose turn ended early can land
          // before the park — leaving the answer recorded with nothing parked.
          // The lane still owes its round a verdict, and only a re-dispatch can
          // deliver the answer to it, so the wait (which short-circuits on
          // answers present) consumes it exactly as it would a parked lane's.
          //
          // Answers already consumed skip the wait: with a sibling still parked
          // the context is legitimately `awaiting_user_input` AND owed a
          // dispatch, and re-entering the wait here would strand the answers
          // this runner is holding until the sibling was answered too — the
          // serialization R9.1 forbids.
          if (
            (execution.contextStates[contextId]?.status ===
              "awaiting_user_input" ||
              hasUndeliveredValidatorAnswer(
                execution.contextStates[contextId],
              )) &&
            !pendingResumeUserInput.has(contextId)
          ) {
            if (
              execution.contextStates[contextId]?.status ===
              "awaiting_user_input"
            ) {
              queryCapacity.release(contextId);
            }
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
            if (!(await reacquireQueryCapacity(contextId))) return;
            // Answers observed — consume them (clears the answered records, and
            // flips to running once no lane is left parked) and re-iterate. An
            // empty consume means the records vanished between the wait and
            // this mutation (withdrawn) — treat it as a withdrawal and exit.
            const consumed = await userInputGateService.consumeAnswers({
              projectPath: input.projectPath,
              sessionName: input.sessionName,
              contextId,
            });
            await refreshExecution();
            if (consumed.length === 0) {
              return;
            }
            // Carry each lane's answers across the `continue` so the next
            // iteration for this context delivers them (pin + answer block) to
            // the lane that asked, and to no other.
            pendingResumeUserInput.set(contextId, consumed);
            execLogger?.iteration(contextId, "user_input.resumed", {
              laneKeys: consumed.map((entry) => entry.laneKey),
              questionBatchIds: consumed.map((entry) => entry.questionBatchId),
            });
            logger.info("graph-workflow.user_input.resumed", {
              executionId: execution.id,
              contextId,
              laneKeys: consumed.map((entry) => entry.laneKey),
            });
            continue;
          }

          const resumeUserInputs = pendingResumeUserInput.get(contextId);
          pendingResumeUserInput.delete(contextId);

          let iterationResult: GraphWorkflowIterationResult;
          try {
            iterationResult = await deps.iterationOrchestrator.runIteration({
              projectPath: input.projectPath,
              projectName: input.projectName,
              sessionName: input.sessionName,
              contextId,
              executionTarget: target,
              ...(resumeUserInputs ? { resumeUserInputs } : {}),
              signal: loopAbortController.signal,
            });
            retryableRecoveryAttempts.delete(contextId);
            sdkErrorRecoveryAttempts.delete(contextId);
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
            const recoverRetryableIterationError =
              deps.workflowManager.recoverRetryableIterationError;
            const transportRecovery = isRetryableIterationError(error);
            const stallRecovery = isStallCausedTurnFailure(error);
            const sdkErrorRecovery =
              !transportRecovery &&
              !stallRecovery &&
              isSdkErrorCausedTurnFailure(error);
            const recoveryKind = sdkErrorRecovery
              ? "sdk_error"
              : stallRecovery
                ? "stall"
                : "transport";
            const attemptCounter = sdkErrorRecovery
              ? sdkErrorRecoveryAttempts
              : retryableRecoveryAttempts;
            const recoveryAttempts = attemptCounter.get(contextId) ?? 0;
            const canRecover =
              (transportRecovery || stallRecovery || sdkErrorRecovery) &&
              recoveryAttempts < 1 &&
              recoverRetryableIterationError;

            if (!canRecover) {
              await recordHalt(
                toHaltReason(error, { contextId, cause: "sdk_error" }),
              );
              return;
            }

            const errorMessage = getErrorMessage(error);
            attemptCounter.set(contextId, recoveryAttempts + 1);
            execLogger?.decision("iteration.retryable_error_detected", {
              contextId,
              error: errorMessage,
              recoveryKind,
              recoveryAttempt: recoveryAttempts + 1,
              maxRecoveryAttempts: 1,
            });
            logger.warn("graph-workflow.loop.retryable_iteration_error", {
              executionId: execution.id,
              contextId,
              error: errorMessage,
              recoveryKind,
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

          const decision = iterationResult.decision;
          if (decision.kind === "await_collaboration") {
            execLogger?.iteration(contextId, "loop.collaboration_pending", {
              workflowId: decision.workflowId,
            });
            logger.info("graph-workflow.parallel.collaboration_pending", {
              executionId: execution.id,
              contextId,
              workflowId: decision.workflowId,
            });
            return;
          }

          if (
            execution.status !== "running" ||
            decision.kind === "execution_stopped"
          ) {
            return;
          }

          // During drain, a successful sibling may land; another turn must wait
          // for the execution-wide halt to settle.
          if (
            execution.pendingHaltReason !== null &&
            decision.kind === "continue"
          ) {
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

          if (decision.kind === "halted") {
            execLogger?.iteration(contextId, "loop.context_halted", {
              haltReason: decision.haltReason,
            });
            logger.info("graph-workflow.parallel.context_halted", {
              executionId: execution.id,
              contextId,
              haltReasonType: decision.haltReason.type,
            });
            return;
          }

          const contextState = execution.contextStates[contextId];
          const contextDef = execution.workingDefinition.executionContexts.find(
            (c) => c.id === contextId,
          );

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
              summary: null,
            });
            return;
          }

          switch (decision.kind) {
            case "continue":
              execLogger?.iteration(contextId, "loop.continue_in_context", {
                conversationId: iterationResult.conversationId,
                reason: decision.reason,
              });
              continue;
            case "await_approval":
            case "await_user_input":
            case "deliver_validator_answers":
              continue;
            case "yield":
              logger.info("graph-workflow.parallel.context_yielded", {
                executionId: execution.id,
                contextId,
                reason: decision.reason,
              });
              return;
            case "ready_to_land":
              break contextIterations;
            default: {
              const unreachable: never = decision;
              throw new Error(
                `Unhandled context decision: ${JSON.stringify(unreachable)}`,
              );
            }
          }
        }
      } finally {
        execLogger?.lifecycle("parallel.context_finished", {
          contextId,
          isolation,
        });
        logger.info("graph-workflow.parallel.context_finished", {
          executionId: execution.id,
          contextId,
          isolation,
        });
      }

      await runCommitPhase();
    }

    type ContextJoinCandidate = {
      join: GraphWorkflowExecutionJoinState;
      alreadyPersisted: boolean;
    };
    type BlockedContextJoinCandidate = ContextJoinCandidate & {
      busyLaneIds: string[];
    };
    type ContextJoinSelection = {
      runnable: ContextJoinCandidate | null;
      blocked: BlockedContextJoinCandidate[];
      requiredCandidateExists: boolean;
      activeFinalPublish: GraphWorkflowExecutionJoinState | null;
    };
    type JoinRunOutcome = "ran" | "halted" | "none" | "retry";

    function selectEligibleContextJoin(): ContextJoinSelection {
      const active = findActiveJoin(execution);
      if (active?.kind === "final_publish") {
        return {
          runnable: null,
          blocked: [],
          requiredCandidateExists: false,
          activeFinalPublish: active,
        };
      }
      if (active) {
        const busyLaneIds = findBusyJoinSourceLaneIds(active, execution);
        if (busyLaneIds.length > 0) {
          return {
            runnable: null,
            blocked: [{ join: active, alreadyPersisted: true, busyLaneIds }],
            requiredCandidateExists: true,
            activeFinalPublish: null,
          };
        }
        return {
          runnable: { join: active, alreadyPersisted: true },
          blocked: [],
          requiredCandidateExists: true,
          activeFinalPublish: null,
        };
      }

      const blocked: BlockedContextJoinCandidate[] = [];
      let runnable: ContextJoinCandidate | null = null;
      let requiredCandidateExists = false;
      const eligibleIds = getEligibleContextIds(
        execution.workingDefinition,
        execution,
      );
      for (const contextId of eligibleIds) {
        const classification = classifyContextSchedulability({
          contextId,
          definition: execution.workingDefinition,
          execution,
        });
        if (classification.kind !== "wait-for-join") continue;

        const planned = planContextJoin({
          contextId,
          execution,
          now: () => new Date().toISOString(),
          generateJoinId: () => createJobId(),
        });
        if (!planned) continue;
        requiredCandidateExists = true;

        const busyLaneIds = findBusyJoinSourceLaneIds(planned, execution);
        if (busyLaneIds.length > 0) {
          blocked.push({
            join: planned,
            alreadyPersisted: false,
            busyLaneIds,
          });
          continue;
        }

        runnable ??= { join: planned, alreadyPersisted: false };
      }

      return {
        runnable,
        blocked,
        requiredCandidateExists,
        activeFinalPublish: null,
      };
    }

    function logBlockedContextJoins(
      blocked: readonly BlockedContextJoinCandidate[],
    ): void {
      for (const candidate of blocked) {
        const { join, busyLaneIds } = candidate;
        const contextKey = join.contextId ?? join.joinId;
        const signature = JSON.stringify(busyLaneIds);
        logger.info("graph-workflow.join.deferred_busy_source_lanes", {
          executionId: execution.id,
          contextId: join.contextId,
          sourceLaneIds: join.sourceLaneIds,
          busyLaneIds,
          activeContextIds: execution.activeContextIds,
        });
        if (deferredJoinBusySignatures.get(contextKey) === signature) continue;
        deferredJoinBusySignatures.set(contextKey, signature);
        execLogger?.lifecycle("join.deferred_busy_source_lanes", {
          contextId: join.contextId,
          sourceLaneIds: join.sourceLaneIds,
          busyLaneIds,
          activeContextIds: execution.activeContextIds,
        });
      }
    }

    async function executeJoin(
      join: GraphWorkflowExecutionJoinState,
      plannedFor: "context" | "final_publish",
      alreadyPersisted: boolean,
    ): Promise<Exclude<JoinRunOutcome, "none">> {
      const capacityLease = queryCapacity.tryAcquireTransient();
      if (capacityLease === null) return "retry";
      try {
        type ClaimDeferralReason =
          | "execution_not_running"
          | "pending_halt"
          | "active_join_changed"
          | "candidate_changed"
          | "busy_source_lanes"
          | "stale_final_publish_superseded";

        const { execution: claimedExecution, claim } =
          await deps.executionRepository
            .mutateActive(input.projectPath, input.sessionName, (current) => {
              const claim: {
                join: GraphWorkflowExecutionJoinState | null;
                deferredJoin: GraphWorkflowExecutionJoinState | null;
                busyLaneIds: string[];
                reason: ClaimDeferralReason | null;
              } = {
                join: null,
                deferredJoin: null,
                busyLaneIds: [],
                reason: null,
              };

              if (current.status !== "running") {
                claim.reason = "execution_not_running";
                return unchanged({ claim });
              }
              if (current.pendingHaltReason !== null) {
                claim.reason = "pending_halt";
                return unchanged({ claim });
              }

              const active = findActiveJoin(current);
              let currentJoin: GraphWorkflowExecutionJoinState | null = null;
              if (alreadyPersisted) {
                if (!active || active.joinId !== join.joinId) {
                  claim.reason = "active_join_changed";
                  return unchanged({ claim });
                }
                // A final_publish persisted before a halt window may be restored
                // while a source-eligible context still has unstarted tasks (a
                // never-started downstream, or a context reset during the halt).
                // Running it would deliver a candidate that structurally excludes
                // that work, so supersede it: mark it failed and let the next pass
                // re-plan from current state (ticket #28 / F25).
                if (active.kind === "final_publish") {
                  const unfinished = findContextsWithUnfinishedTasks(current);
                  if (unfinished.length > 0) {
                    claim.reason = "stale_final_publish_superseded";
                    return changed(
                      applyJoinProgress(
                        current,
                        active.joinId,
                        new Date().toISOString(),
                        {
                          status: "failed",
                          errorMessage: `Superseded: ${unfinished.length} context(s) still have unfinished tasks (${unfinished
                            .map((state) => state.contextId)
                            .join(
                              ", ",
                            )}). The final publish is re-planned after that work completes.`,
                        },
                      ),
                      { claim },
                    );
                  }
                  const validationDebt =
                    findValidationCertificationDebt(current);
                  if (validationDebt.length > 0) {
                    claim.reason = "stale_final_publish_superseded";
                    return changed(
                      applyJoinProgress(
                        current,
                        active.joinId,
                        new Date().toISOString(),
                        {
                          status: "failed",
                          errorMessage: `Superseded: required validation certification is owed by ${validationDebt
                            .map(describeValidationCertificationDebt)
                            .join(
                              ", ",
                            )}. The final publish is re-planned after that debt is resolved.`,
                        },
                      ),
                      { claim },
                    );
                  }
                }
                currentJoin = active;
              } else {
                if (active !== null) {
                  claim.reason = "active_join_changed";
                  return unchanged({ claim });
                }

                if (plannedFor === "context") {
                  const contextId = join.contextId;
                  const eligibleIds = getEligibleContextIds(
                    current.workingDefinition,
                    current,
                  );
                  if (contextId === null || !eligibleIds.includes(contextId)) {
                    claim.reason = "candidate_changed";
                    return unchanged({ claim });
                  }
                  const classification = classifyContextSchedulability({
                    contextId,
                    definition: current.workingDefinition,
                    execution: current,
                  });
                  if (classification.kind !== "wait-for-join") {
                    claim.reason = "candidate_changed";
                    return unchanged({ claim });
                  }
                  currentJoin = planContextJoin({
                    contextId,
                    execution: current,
                    now: () => new Date().toISOString(),
                    generateJoinId: () => join.joinId,
                  });
                } else {
                  currentJoin = planFinalPublishJoin({
                    execution: current,
                    sessionLaneId: SESSION_LANE_ID,
                    now: () => new Date().toISOString(),
                    generateJoinId: () => join.joinId,
                  });
                }

                if (!currentJoin) {
                  claim.reason = "candidate_changed";
                  return unchanged({ claim });
                }
              }

              const busyLaneIds = findBusyJoinSourceLaneIds(
                currentJoin,
                current,
              );
              if (busyLaneIds.length > 0) {
                claim.deferredJoin = currentJoin;
                claim.busyLaneIds = busyLaneIds;
                claim.reason = "busy_source_lanes";
                return unchanged({ claim });
              }

              const withJoin = alreadyPersisted
                ? current
                : appendPendingJoin(current, currentJoin);
              claim.join = currentJoin;
              return changed(
                applyJoinProgress(
                  withJoin,
                  currentJoin.joinId,
                  new Date().toISOString(),
                  { status: "running" },
                ),
                { claim },
              );
            })
            .then((mutation) => ({
              execution: mutation.execution,
              ...mutationValue(mutation),
            }));
        adoptExecution(claimedExecution);

        const claimedJoin = claim.join;
        if (!claimedJoin) {
          if (claim.deferredJoin && claim.busyLaneIds.length > 0) {
            logBlockedContextJoins([
              {
                join: claim.deferredJoin,
                alreadyPersisted,
                busyLaneIds: claim.busyLaneIds,
              },
            ]);
          }
          logger.info("graph-workflow.join.claim_deferred", {
            executionId: execution.id,
            joinId: join.joinId,
            kind: join.kind,
            plannedFor,
            reason: claim.reason,
            busyLaneIds: claim.busyLaneIds,
          });
          return "retry";
        }
        deferredJoinBusySignatures.delete(
          claimedJoin.contextId ?? claimedJoin.joinId,
        );

        if (!alreadyPersisted) {
          execLogger?.lifecycle("join.planned", {
            joinId: claimedJoin.joinId,
            kind: claimedJoin.kind,
            contextId: claimedJoin.contextId,
            sourceLaneIds: claimedJoin.sourceLaneIds,
            targetLaneId: claimedJoin.targetLaneId,
          });
          logger.info("graph-workflow.join.planned", {
            executionId: execution.id,
            joinId: claimedJoin.joinId,
            kind: claimedJoin.kind,
            plannedFor,
            sourceLaneIds: claimedJoin.sourceLaneIds,
            targetLaneId: claimedJoin.targetLaneId,
          });
        }

        execLogger?.lifecycle("join.started", {
          joinId: claimedJoin.joinId,
          kind: claimedJoin.kind,
          sourceLaneIds: claimedJoin.sourceLaneIds,
          targetLaneId: claimedJoin.targetLaneId,
        });
        logger.info("graph-workflow.join.started", {
          executionId: execution.id,
          joinId: claimedJoin.joinId,
          kind: claimedJoin.kind,
        });

        const landed = await contextLanding.runJoin({
          ...input,
          executionId: execution.id,
          joinId: claimedJoin.joinId,
        });
        adoptExecution(landed.execution);
        return landed.outcome.kind === "failed" ? "halted" : "ran";
      } finally {
        capacityLease.release();
      }
    }

    async function runEligibleContextJoinIfAny(): Promise<JoinRunOutcome> {
      const selection = selectEligibleContextJoin();
      logBlockedContextJoins(selection.blocked);
      if (!selection.runnable) return "none";

      const { join, alreadyPersisted } = selection.runnable;
      return executeJoin(join, "context", alreadyPersisted);
    }

    async function runQuiescentJoinIfAny(): Promise<JoinRunOutcome> {
      const selection = selectEligibleContextJoin();
      logBlockedContextJoins(selection.blocked);

      if (selection.activeFinalPublish) {
        return executeJoin(selection.activeFinalPublish, "final_publish", true);
      }
      if (selection.runnable) {
        const { join, alreadyPersisted } = selection.runnable;
        return executeJoin(join, "context", alreadyPersisted);
      }
      if (selection.requiredCandidateExists) return "none";

      const finalPublish = planFinalPublishJoin({
        execution,
        sessionLaneId: SESSION_LANE_ID,
        now: () => new Date().toISOString(),
        generateJoinId: () => createJobId(),
      });
      if (!finalPublish) return "none";

      const session = await deps.getSession(
        input.projectPath,
        input.sessionName,
      );
      if (!session) {
        await recordHalt({
          type: "recovery_error",
          message: `Session "${input.sessionName}" not found during final publish orchestration`,
        });
        return "halted";
      }

      const materialized = await deps.executionRepository
        .mutateActive(input.projectPath, input.sessionName, (e) =>
          changed(
            materializeSessionLane(e, {
              sessionLaneId: SESSION_LANE_ID,
              branchName: session.branchName,
              worktreePath: session.worktreePath,
              now: () => new Date().toISOString(),
            }),
          ),
        )
        .then((mutation) => mutation.execution);
      adoptExecution(materialized);

      return executeJoin(finalPublish, "final_publish", false);
    }

    // A merged lane's content lives on the session branch, so its worktree and
    // branch are disposable once the execution completes. Contexts that never
    // merged (halted/aborted executions) keep their lanes intact for forensics
    // until session delete. Failures are logged and never fail the completion.
    async function cleanupMergedLanes(): Promise<void> {
      // The branch recorded at provision time travels with the lane state so
      // cleanup never re-derives it from the (mutable) branch-prefix config.
      const laneBranches = new Map<string, string | null>();
      const recordLane = (laneId: string, branchName: string | null): void => {
        const existing = laneBranches.get(laneId);
        if (existing === undefined || existing === null) {
          laneBranches.set(laneId, branchName);
        }
      };
      for (const cs of Object.values(execution.contextStates)) {
        if (cs.mergeStatus !== "merged-success") continue;
        if (cs.isolation !== "worktree") continue;
        if (cs.laneId !== null) {
          recordLane(
            cs.laneId,
            execution.executionLanes[cs.laneId]?.branchName ?? cs.branchName,
          );
        }
      }
      if (laneBranches.size === 0) return;

      const session = await deps.getSession(
        input.projectPath,
        input.sessionName,
      );
      if (!session) {
        logger.warn("graph-workflow.lane_cleanup.session_missing", {
          executionId: execution.id,
          laneIds: [...laneBranches.keys()],
        });
        return;
      }
      const sessionDir = path.basename(session.worktreePath);

      for (const [laneId, branchName] of laneBranches) {
        try {
          const result = await deps.parallelWorktrees.cleanupLane({
            projectPath: input.projectPath,
            sessionName: input.sessionName,
            sessionDir,
            contextId: laneId,
            branchName,
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
      const maxConcurrency = await getMaxConcurrentQueries();
      queryCapacity = createQueryCapacityCoordinator(maxConcurrency);
      // Outer scheduling loop: schedule currently-eligible work, wait for the
      // next in-flight context or merge event to settle, refresh execution
      // state, and reschedule. Downstream contexts can become eligible the
      // moment an upstream context lands without waiting for the full wave to
      // drain.
      // eslint-disable-next-line no-constant-condition
      while (true) {
        if (pendingContextTaskErrors.length > 0) {
          throw pendingContextTaskErrors.shift();
        }
        if (execution.status !== "running") {
          if (inFlight.size > 0) {
            await Promise.race(inFlight.values());
            continue;
          }
          // Withdrawing the parked questions an abort orphans (Req 7.4) is the
          // manager's job, committed with the abort transition itself: that
          // transition retires this loop's generation, so any write issued from
          // here is fenced out, and an abort of a paused or halted execution
          // has no loop to run cleanup at all. This loop only reports the
          // terminal state it was told to stop in.
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

        // Route settlement precedes every scheduling decision this pass makes:
        // the scheduler, the joins and the completion invariant all read the
        // skips and settlements it writes.
        if ((await settleSchedulingInputs()) === "halted") {
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

        // A live runner can transiently make itself scheduler-eligible while
        // handing work back (for example, approval exposed a replaced output
        // contract). Let that runner retire before a new pass claims the same
        // context; unrelated parked runners do not enter this branch because
        // parked statuses are not scheduler-eligible.
        const eligibleContextIdsWithRunner = getEligibleContextIds(
          execution.workingDefinition,
          execution,
        ).filter((contextId) => inFlight.has(contextId));
        if (eligibleContextIdsWithRunner.length > 0) {
          await Promise.race(
            eligibleContextIdsWithRunner.map(
              (contextId) => inFlight.get(contextId)!,
            ),
          );
          await refreshExecution();
          continue;
        }

        // Parked gates stay in `inFlight` for lifecycle and join safety, but
        // their agent query has ended. The capacity ledger releases only that
        // query permit and retains the runner that owns the durable wait.
        const observedCapacityGeneration = queryCapacity.snapshot().generation;
        if (queryCapacity.snapshot().available > 0) {
          const eagerJoinOutcome = await runEligibleContextJoinIfAny();
          if (
            eagerJoinOutcome === "ran" ||
            eagerJoinOutcome === "halted" ||
            eagerJoinOutcome === "retry"
          ) {
            continue;
          }
        }

        // Reserve before the asynchronous scheduling mutation. A parked
        // runner whose answer arrives during that await cannot claim the same
        // last permit; it queues for reacquisition behind this reservation.
        const capacityRemaining = queryCapacity.reserveForScheduler();
        const capacitySnapshot = queryCapacity.snapshot();
        execLogger?.lifecycle("loop.schedule_capacity", {
          maxConcurrency,
          inFlight: inFlight.size,
          held: capacitySnapshot.held,
          released: capacitySnapshot.released,
          waiting: capacitySnapshot.waiting,
          reserved: capacitySnapshot.reserved,
          transient: capacitySnapshot.transient,
          available: capacitySnapshot.available,
          capacityRemaining,
        });
        let reservationOutstanding = true;
        let scheduleResult: ScheduleEligibleContextsResult;
        let scheduledContextIds: string[] = [];
        try {
          scheduleResult = await deps.contextScheduler.scheduleEligibleContexts(
            {
              projectPath: input.projectPath,
              sessionName: input.sessionName,
              sessionLaneEnabled: input.sessionLaneEnabled,
              capacityRemaining,
              excludedContextIds: [...inFlight.keys()],
            },
          );
          adoptExecution(scheduleResult.execution);
          scheduledContextIds =
            scheduleResult.scheduled.kind === "none"
              ? []
              : scheduleResult.scheduled.kind === "solo"
                ? [scheduleResult.scheduled.contextId]
                : scheduleResult.scheduled.contextIds;
          queryCapacity.settleSchedulerReservation(
            capacityRemaining,
            scheduledContextIds,
          );
          reservationOutstanding = false;
          // A parked runner can resolve and commit while the scheduler's
          // asynchronous mutation is returning. Re-read after fence-checking
          // the scheduler result so an older parked snapshot cannot re-enter
          // a context whose decision or answers already landed.
          await refreshExecution();
        } finally {
          if (reservationOutstanding) {
            queryCapacity.cancelSchedulerReservation(capacityRemaining);
          }
        }

        // An in-flight runner can finish between a refresh capturing its
        // parked state and this pass observing that its local task is gone.
        // Re-read at that handoff boundary before creating a recovery runner;
        // otherwise the captured park can be applied a second time after the
        // durable decision or answers already cleared it.
        // The scheduler only seeds pending/ready contexts, so a context
        // restored as awaiting_approval (a park persisted across a pause,
        // halt, or restart) gets its runner here and re-enters the gate
        // wait directly. A context that parked under this loop is skipped:
        // its runner is still in flight, holding the wait.
        for (const contextState of Object.values(execution.contextStates)) {
          if (contextState.status !== "awaiting_approval") continue;
          const contextId = contextState.contextId;
          if (inFlight.has(contextId)) continue;
          await refreshExecution();
          if (
            execution.contextStates[contextId]?.status !==
              "awaiting_approval" ||
            inFlight.has(contextId)
          ) {
            continue;
          }
          execLogger?.iteration(contextId, "gate.reentered", {
            conversationId:
              contextState.pendingApproval?.conversationId ?? null,
          });
          logger.info("graph-workflow.gate.reentered", {
            executionId: execution.id,
            contextId,
          });
          queryCapacity.registerReleased(contextId);
          startContextTask(contextId);
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
          await refreshExecution();
          if (
            execution.contextStates[contextId]?.status !==
              "awaiting_user_input" ||
            inFlight.has(contextId)
          ) {
            continue;
          }
          execLogger?.iteration(contextId, "user_input.reentered", {
            laneKeys: pendingUserInputEntries(contextState).map(
              (entry) => entry.laneKey,
            ),
          });
          logger.info("graph-workflow.user_input.reentered", {
            executionId: execution.id,
            contextId,
          });
          queryCapacity.registerReleased(contextId);
          startContextTask(contextId);
        }

        if (scheduleResult.scheduled.kind === "none") {
          if (inFlight.size > 0) {
            await waitForInFlightOrCapacityProgress(observedCapacityGeneration);
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
          const joinOutcome = await runQuiescentJoinIfAny();
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
          if (joinOutcome === "retry") {
            continue;
          }
          const unpublished = unpublishedContributions(execution);
          if (
            unpublished.length > 0 &&
            findContextsWithUnfinishedTasks(execution).length === 0
          ) {
            logger.error("graph-workflow.loop.completion_blocked_unpublished", {
              executionId: execution.id,
              contextIds: unpublished,
            });
            execLogger?.lifecycle("loop.completion_blocked_unpublished", {
              contextIds: unpublished,
            });
            await recordHalt({
              type: "recovery_error",
              message: `Refusing to complete: contributions have not reached the session branch (${unpublished.join(", ")}). No eligible lane can currently publish them. Restore the missing source or resolve its outstanding lane gates, then resume.`,
            });
            execution = await deps.workflowManager.drainAndHalt({
              projectPath: input.projectPath,
              sessionName: input.sessionName,
            });
            break;
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
          const incompleteContexts = findContextsWithUnfinishedTasks(execution);
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
          // The same refusal for the debt the task-based predicate above
          // cannot see: a schema-declaring context is not finished when its
          // tasks are (R2). Its tasks can all be complete while the validated
          // output the contract demands does not exist — after a live edit
          // replaced the contract, or after any path left the context
          // unscheduled — and completing then would report a finished run that
          // silently violates the exactly-one-validated-output guarantee.
          //
          // A context the routing declined owes no output at all (R4.1), and
          // that exemption comes from the same land-gated publish settlement
          // the task invariant above uses, not from the persisted status
          // (decision D1) and not from a skip whose source has yet to land.
          const publishSettlement = landGatedPublishSettlement(execution);
          const routeDeclinedContextIds = new Set(
            publishSettlement.skippedContextIds,
          );
          const contextsOwingOutput =
            execution.workingDefinition.executionContexts
              .map((context) => context.id)
              .filter(
                (contextId) =>
                  !routeDeclinedContextIds.has(contextId) &&
                  contextOwesOutput(execution, contextId),
              );
          if (contextsOwingOutput.length > 0) {
            logger.error("graph-workflow.loop.completion_blocked_owed_output", {
              executionId: execution.id,
              contextIds: contextsOwingOutput,
            });
            execLogger?.lifecycle("loop.completion_blocked_owed_output", {
              contextIds: contextsOwingOutput,
            });
            await recordHalt({
              type: "recovery_error",
              message: `Refusing to complete: ${contextsOwingOutput.length} execution context(s) declare an output schema with no validated output (${contextsOwingOutput.join(", ")}). The scheduler found no eligible work, which would otherwise report the run as finished while a declared contract went unsatisfied.`,
            });
            execution = await deps.workflowManager.drainAndHalt({
              projectPath: input.projectPath,
              sessionName: input.sessionName,
            });
            break;
          }
          const validationDebt = findValidationCertificationDebt(execution);
          if (validationDebt.length > 0) {
            const contextIds = validationDebt.map((debt) => debt.contextId);
            const summary = validationDebt
              .map(describeValidationCertificationDebt)
              .join(", ");
            logger.error(
              "graph-workflow.loop.completion_blocked_validation_debt",
              {
                executionId: execution.id,
                contextIds,
              },
            );
            execLogger?.lifecycle("loop.completion_blocked_validation_debt", {
              contextIds,
            });
            await recordHalt({
              type: "recovery_error",
              message: `Refusing to complete: required validation is not certified for ${summary}. The context is already terminal or the scheduler found no recertification path. Abandon this execution and launch a replacement; terminal landed contexts are not reopened in place.`,
            });
            execution = await deps.workflowManager.drainAndHalt({
              projectPath: input.projectPath,
              sessionName: input.sessionName,
            });
            break;
          }
          // The same refusal for a loop that has neither concluded nor been
          // declined (R9), read off the SAME land-gated publish settlement — the
          // projection owns what is outstanding, and this reads back only the
          // loop-exit share of it, because the rest legitimately reports a
          // context whose tasks are done but whose status has not flipped yet.
          //
          // Loop settlement runs at the top of THIS iteration, before anything
          // here, so reaching the completion point with a running loop is not a
          // timing window: it means the pass could not be settled at all — an
          // exit whose landing never reconciled, most likely a failed merge
          // awaiting retry. Completing then would report a finished run whose
          // loop never reached its exit condition.
          const unsettledLoopExits =
            publishSettlement.outstandingLoopExitContextIds;
          if (unsettledLoopExits.length > 0) {
            logger.error("graph-workflow.loop.completion_blocked_unsettled", {
              executionId: execution.id,
              loopExitContextIds: unsettledLoopExits,
            });
            execLogger?.lifecycle("loop.completion_blocked_unsettled", {
              loopExitContextIds: unsettledLoopExits,
            });
            await recordHalt({
              type: "recovery_error",
              message: `Refusing to complete: ${unsettledLoopExits.length} loop(s) have not reached their exit condition (exit context(s) ${unsettledLoopExits.join(", ")}). The scheduler found no eligible work and loop settlement could not decide the current pass, which would otherwise report the run as finished mid-loop.`,
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

        for (const contextId of scheduledContextIds) {
          if (inFlight.has(contextId)) continue;
          startContextTask(contextId);
        }

        // Wait for the next in-flight context or merge event to settle, then
        // refresh and reschedule. Newly eligible downstream contexts are
        // picked up immediately instead of being held behind the slowest peer
        // in the current wave.
        if (inFlight.size > 0) {
          await waitForInFlightOrCapacityProgress(observedCapacityGeneration);
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
      const activeLoops = getActiveLoops();
      if (activeLoops.get(key)?.token === loopInstanceToken) {
        activeLoops.delete(key);
      }
    }
  }

  return { run };
}
