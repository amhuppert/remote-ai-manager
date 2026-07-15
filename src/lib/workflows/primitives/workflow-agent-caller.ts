/**
 * Production composition point above the AgentCall primitive for lane-backed
 * agent calls.
 *
 *  1. Resolve lane state by `(workflowId, laneId)` via `LaneService`.
 *  2. Resolve the lane's continuity handle through the owning backend's
 *     `BackendContinuityAdapter` (start / resumeOrRecover) so the underlying
 *     `AgentCall` sees a continuity-aware resume reference. Backend identity
 *     never branches here — the adapter owns handle semantics.
 *  3. Wrap the call with `LaneScheduler.schedule()` keyed on the session
 *     worktree. This is the ONE scheduler acquisition point (D16): write-
 *     capable lanes sharing a session serialize while read-only /
 *     artifact-only calls overlap. Missing `writeCapability` defaults to
 *     `write_capable` via the shared vocabulary constant.
 *  4. Record post-turn outcomes on the lane (continuity handle, normalized
 *     usage metrics, rotation decisions) without inventing unsupported
 *     metrics on any backend.
 *  5. Recover from stale continuity handles without losing the
 *     workflow-owned lane identity by starting a fresh backend session,
 *     updating lane state, and retrying the call once.
 *
 * `AgentCall` itself stays focused on execution normalization.
 *
 * Deps use method syntax to leverage TypeScript's bivariant parameter
 * checking (per CLAUDE.md testing rules), which keeps assignment of
 * production functions to the deps interface free of contravariance friction.
 */

import { createLogger, type Logger } from "@/lib/logging";
import { getBackendDescriptor } from "@/lib/agent-backends/registry";
import type {
  BackendContinuityAdapter,
  ContinuityContext,
} from "@/lib/agent-backends/continuity";
import { refValueForBackend } from "@/lib/agent-backends/continuity";
import type { AgentBackendId, AgentSessionRef } from "@/lib/shared/schemas";
import {
  DEFAULT_LANE_WRITE_CAPABILITY,
  type AgentCallRequest,
  type AgentCallResult,
  type LaneWriteCapability,
} from "./agent-call-vocabulary";
import type { LaneScheduler } from "./lane-scheduler";
import type { LaneOutcome, LaneService } from "./lane-service";
import {
  laneSessionRef,
  type LaneRef,
  type LaneState,
} from "./lane-vocabulary";
import { getErrorMessage } from "@/lib/shared/errors";

const defaultLogger = createLogger(
  "workflows.primitives.workflow-agent-caller",
);

/**
 * Continuity context the adapter hands to the underlying AgentCall so the
 * runtime/runner resolution layer can target the resolved backend session
 * (or detect that a fresh one is being created).
 */
export interface WorkflowAgentCallContinuity {
  laneRef: LaneRef;
  resumeRef: AgentSessionRef | null;
  laneAction: "reuse" | "create";
}

/**
 * Errors carrying this marker flag tell the adapter that a persisted backend
 * reference is stale and a fresh backend session should be created. Either
 * the backend factory or the underlying callAgent can throw with this flag.
 */
const STALE_BACKEND_REF_FLAG = "__workflowAgentCallerStaleBackendRef";

export interface StaleBackendRefError extends Error {
  [STALE_BACKEND_REF_FLAG]: true;
}

export function markStaleBackendRefError(err: Error): StaleBackendRefError {
  (err as StaleBackendRefError)[STALE_BACKEND_REF_FLAG] = true;
  return err as StaleBackendRefError;
}

function isStaleBackendRefError(err: unknown): err is StaleBackendRefError {
  return (
    err instanceof Error &&
    (err as Partial<StaleBackendRefError>)[STALE_BACKEND_REF_FLAG] === true
  );
}

export interface WorkflowAgentCallerRequest {
  laneRef: LaneRef;
  sessionKey: string;
  writeCapability?: LaneWriteCapability;
  agentCallRequest: AgentCallRequest;
  /**
   * Optional second backend turn run on the SAME lane inside the SAME
   * scheduled critical section as `agentCallRequest`. This is the two-pass
   * prose-then-format collaboration repair: the work turn (`agentCallRequest`)
   * answers in prose, then this format turn restates the answer as
   * schema-conforming JSON. Modeling it as one caller request keeps the whole
   * prose→format operation a single serialized semantic phase — the scheduler
   * is acquired exactly once around both turns (D16), so no competing
   * same-session writer can interleave between them.
   *
   * The format turn resolves continuity independently, so on a
   * continuity-enabled lane it resumes the ref the work turn advanced, and on
   * a continuity-disabled lane it starts fresh (matching a lane's per-turn
   * continuity policy). When the work turn does not `complete`, the format
   * turn is skipped and the work result is returned.
   */
  formatFollowUp?: AgentCallRequest;
  /**
   * Optional context-limit threshold forwarded into the lane outcome so the
   * lane service can flip `rotateBeforeNextTurn` when the turn's
   * `contextTokens` exceeds it. Lanes on backends without context-window
   * metrics record an honest `unsupported` evaluation instead.
   */
  contextLimitTokens?: number;
}

export interface WorkflowAgentCallerDeps {
  /**
   * Underlying AgentCall execution. Receives a continuity context carrying
   * the resolved backend reference (or `null` for a fresh session) so the
   * downstream resolveConversationRuntime / resolveTaskRunner layer can
   * target the right backend session.
   */
  callAgent(
    request: AgentCallRequest,
    continuity: WorkflowAgentCallContinuity,
  ): Promise<AgentCallResult>;
  laneService: LaneService;
  laneScheduler: LaneScheduler;
  /**
   * Project/session scope forwarded to every continuity operation
   * (start / resumeOrRecover).
   */
  continuityContext: ContinuityContext;
  /**
   * Resolves the continuity adapter owning a backend's handles. Defaults to
   * the registered descriptor's `conversation.continuity`; callers whose
   * lanes use synthetic handles (collaboration) inject their own adapters.
   */
  continuityAdapter?(backend: AgentBackendId): BackendContinuityAdapter;
  now?(): string;
  logger?: Logger;
}

export interface WorkflowAgentCaller {
  call(request: WorkflowAgentCallerRequest): Promise<AgentCallResult>;
}

export function descriptorContinuityAdapter(
  backend: AgentBackendId,
): BackendContinuityAdapter {
  const descriptor = getBackendDescriptor(backend);
  if (!descriptor.conversation) {
    throw new Error(
      `WorkflowAgentCaller: backend "${backend}" has no conversation facet, so no continuity adapter is available`,
    );
  }
  return descriptor.conversation.continuity;
}

export function createWorkflowAgentCaller(
  deps: WorkflowAgentCallerDeps,
): WorkflowAgentCaller {
  const log = deps.logger ?? defaultLogger;
  const now = deps.now ?? (() => new Date().toISOString());
  const resolveAdapter = deps.continuityAdapter
    ? (backend: AgentBackendId) => deps.continuityAdapter!(backend)
    : descriptorContinuityAdapter;

  return {
    async call(request) {
      const writeCapability =
        request.writeCapability ?? DEFAULT_LANE_WRITE_CAPABILITY;

      return deps.laneScheduler.schedule(
        {
          sessionKey: request.sessionKey,
          writeCapability,
          workflowId: request.laneRef.workflowId,
          laneId: request.laneRef.laneId,
        },
        async () =>
          executeWithContinuity(request, deps, resolveAdapter, log, now),
      );
    },
  };
}

async function executeWithContinuity(
  request: WorkflowAgentCallerRequest,
  deps: WorkflowAgentCallerDeps,
  resolveAdapter: (backend: AgentBackendId) => BackendContinuityAdapter,
  log: Logger,
  now: () => string,
): Promise<AgentCallResult> {
  const workResult = await runOneTurn(
    request,
    request.agentCallRequest,
    deps,
    resolveAdapter,
    log,
    now,
  );

  // The prose→format two-pass repair runs both turns in this same scheduled
  // section (single acquisition, D16). The format turn only runs if the work
  // turn completed; it re-resolves continuity so it resumes the ref the work
  // turn advanced (continuity-enabled lane) or starts fresh (disabled).
  if (
    request.formatFollowUp === undefined ||
    workResult.outcome.kind !== "completed"
  ) {
    return workResult;
  }

  return runOneTurn(
    request,
    request.formatFollowUp,
    deps,
    resolveAdapter,
    log,
    now,
  );
}

async function runOneTurn(
  request: WorkflowAgentCallerRequest,
  agentCallRequest: AgentCallRequest,
  deps: WorkflowAgentCallerDeps,
  resolveAdapter: (backend: AgentBackendId) => BackendContinuityAdapter,
  log: Logger,
  now: () => string,
): Promise<AgentCallResult> {
  const lane = await deps.laneService.resolve(request.laneRef);
  if (!lane) {
    throw new Error(
      `WorkflowAgentCaller: lane ${request.laneRef.workflowId}/${request.laneRef.laneId} is not initialized; call laneService.initialize() first`,
    );
  }

  const adapter = resolveAdapter(lane.backend);
  const firstAttempt = await resolveContinuity(lane, adapter, deps, log);
  let activeContinuity = firstAttempt.continuity;
  let activeLane = firstAttempt.lane;

  let result: AgentCallResult;
  try {
    result = await deps.callAgent(agentCallRequest, activeContinuity);
  } catch (err) {
    if (!isStaleBackendRefError(err)) {
      throw err;
    }
    log.warn("workflow_agent_caller.stale_backend_ref.recovery", {
      workflowId: request.laneRef.workflowId,
      laneId: request.laneRef.laneId,
      backend: activeLane.backend,
      reason: "callAgent_threw_stale",
    });
    const recovered = await startFreshBackend(activeLane, adapter, deps, log);
    activeContinuity = recovered.continuity;
    activeLane = recovered.lane;
    result = await deps.callAgent(agentCallRequest, activeContinuity);
  }

  await applyPostTurnOutcome({
    lane: activeLane,
    request,
    result,
    deps,
    now,
    log,
  });

  return result;
}

interface ContinuityResolution {
  lane: LaneState;
  continuity: WorkflowAgentCallContinuity;
}

async function resolveContinuity(
  lane: LaneState,
  adapter: BackendContinuityAdapter,
  deps: WorkflowAgentCallerDeps,
  log: Logger,
): Promise<ContinuityResolution> {
  if (lane.metrics.rotateBeforeNextTurn) {
    log.debug("workflow_agent_caller.rotation.scheduled", {
      workflowId: lane.workflowId,
      laneId: lane.laneId,
      backend: lane.backend,
    });
    return startFreshBackend(lane, adapter, deps, log);
  }

  if (!lane.policy.continuityEnabled) {
    log.debug("workflow_agent_caller.continuity.disabled", {
      workflowId: lane.workflowId,
      laneId: lane.laneId,
      backend: lane.backend,
    });
    return startFreshBackend(lane, adapter, deps, log);
  }

  const persistedRef = laneSessionRef(lane);
  if (persistedRef === null) {
    return startFreshBackend(lane, adapter, deps, log);
  }

  try {
    const resumption = await adapter.resumeOrRecover(
      persistedRef,
      deps.continuityContext,
    );
    if (!resumption.recovered) {
      return {
        lane,
        continuity: {
          laneRef: { workflowId: lane.workflowId, laneId: lane.laneId },
          resumeRef: resumption.ref,
          laneAction: "reuse",
        },
      };
    }
    log.warn("workflow_agent_caller.stale_backend_ref.recovery", {
      workflowId: lane.workflowId,
      laneId: lane.laneId,
      backend: lane.backend,
      reason: "adapter_recovered_fresh_handle",
      staleRef: persistedRef.ref,
      freshRef: resumption.ref.ref,
    });
    const updated = await persistFreshLane(lane, resumption.ref.ref, deps);
    return {
      lane: updated,
      continuity: {
        laneRef: { workflowId: lane.workflowId, laneId: lane.laneId },
        resumeRef: resumption.ref,
        laneAction: "create",
      },
    };
  } catch (err) {
    log.warn("workflow_agent_caller.stale_backend_ref.recovery", {
      workflowId: lane.workflowId,
      laneId: lane.laneId,
      backend: lane.backend,
      reason: "resume_failed",
      ref: persistedRef.ref,
      error: getErrorMessage(err),
    });
    return startFreshBackend(lane, adapter, deps, log);
  }
}

async function persistFreshLane(
  lane: LaneState,
  ref: string,
  deps: WorkflowAgentCallerDeps,
): Promise<LaneState> {
  const fresh: LaneState = {
    workflowId: lane.workflowId,
    laneId: lane.laneId,
    backend: lane.backend,
    ref,
    writeCapability: lane.writeCapability,
    policy: lane.policy,
    metrics: { rotateBeforeNextTurn: false },
    lastUsedAt: lane.lastUsedAt,
  };
  return deps.laneService.initialize(fresh);
}

async function startFreshBackend(
  lane: LaneState,
  adapter: BackendContinuityAdapter,
  deps: WorkflowAgentCallerDeps,
  log: Logger,
): Promise<ContinuityResolution> {
  const started = await adapter.start(deps.continuityContext);
  log.info("workflow_agent_caller.lane.create_fresh", {
    workflowId: lane.workflowId,
    laneId: lane.laneId,
    backend: lane.backend,
    ref: started.ref,
  });
  const updated = await persistFreshLane(lane, started.ref, deps);
  return {
    lane: updated,
    continuity: {
      laneRef: { workflowId: lane.workflowId, laneId: lane.laneId },
      resumeRef: started,
      laneAction: "create",
    },
  };
}

interface ApplyPostTurnOutcomeInput {
  lane: LaneState;
  request: WorkflowAgentCallerRequest;
  result: AgentCallResult;
  deps: WorkflowAgentCallerDeps;
  now: () => string;
  log: Logger;
}

async function applyPostTurnOutcome(
  input: ApplyPostTurnOutcomeInput,
): Promise<void> {
  const { lane, request, result, deps, log } = input;
  const ref = { workflowId: lane.workflowId, laneId: lane.laneId };
  const outcome = buildLaneOutcome(lane, request, result);
  try {
    await deps.laneService.recordOutcome(ref, outcome);
  } catch (err) {
    log.error("workflow_agent_caller.record_outcome_failed", {
      workflowId: lane.workflowId,
      laneId: lane.laneId,
      backend: lane.backend,
      message: getErrorMessage(err),
    });
    throw err;
  }
}

function buildLaneOutcome(
  lane: LaneState,
  request: WorkflowAgentCallerRequest,
  result: AgentCallResult,
): LaneOutcome {
  const usage = result.usage;
  const advancedRef = refValueForBackend(result.backendRef, lane.backend);
  const lastTurnUsage =
    usage.inputTokens !== undefined ||
    usage.outputTokens !== undefined ||
    usage.cachedInputTokens !== undefined
      ? {
          inputTokens: usage.inputTokens ?? 0,
          cachedInputTokens: usage.cachedInputTokens ?? 0,
          outputTokens: usage.outputTokens ?? 0,
        }
      : undefined;

  return {
    backend: lane.backend,
    ...(advancedRef !== undefined ? { ref: advancedRef } : {}),
    ...(usage.contextTokens !== undefined
      ? { contextTokens: usage.contextTokens }
      : {}),
    ...(usage.contextWindowMax !== undefined
      ? { contextWindowMax: usage.contextWindowMax }
      : {}),
    ...(request.contextLimitTokens !== undefined
      ? { contextLimitTokens: request.contextLimitTokens }
      : {}),
    ...(lastTurnUsage !== undefined ? { lastTurnUsage } : {}),
    ...(result.continuationDisposition !== undefined
      ? { continuationDisposition: result.continuationDisposition }
      : {}),
    ...(result.compacted === true ? { compactedThisTurn: true } : {}),
  };
}
