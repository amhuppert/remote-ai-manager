/**
 * Production composition point above the AgentCall primitive for lane-backed
 * agent calls.
 *
 * Centralises the work that graph workflow currently does manually in
 * `workflow-continuity-service`:
 *
 *  1. Resolve lane state by `(workflowId, laneId)` via `LaneService`.
 *  2. Create or resume the right backend runtime (Claude conversation /
 *     Codex thread) so the underlying `AgentCall` sees a continuity-aware
 *     resume reference.
 *  3. Wrap the call with `LaneScheduler.schedule()` keyed on the session
 *     worktree so write-capable lanes sharing a session serialize while
 *     read-only calls overlap. Missing `writeCapability` is treated as
 *     `write_capable` per the integration plan.
 *  4. Record post-turn outcomes on the lane (backend ref, usage, rotation
 *     decisions) without inventing unsupported metrics on either backend.
 *  5. Recover from stale Claude/Codex references without losing the
 *     workflow-owned lane identity by creating a fresh backend session,
 *     updating lane state, and retrying the call once.
 *
 * `AgentCall` itself stays focused on execution normalization. This adapter
 * is the production seam the integration plan calls for; the existing
 * `workflow-continuity-service` is the legacy graph-only equivalent.
 *
 * Deps use method syntax to leverage TypeScript's bivariant parameter
 * checking (per CLAUDE.md testing rules), which keeps assignment of
 * production functions to the deps interface free of contravariance friction.
 */

import { createLogger, type Logger } from "@/lib/logging";
import type { AgentSessionRef } from "@/lib/schemas";
import type {
  AgentCallRequest,
  AgentCallResult,
  LaneWriteCapability,
} from "./agent-call-vocabulary";
import type { LaneScheduler } from "./lane-scheduler";
import type { LaneOutcome, LaneService } from "./lane-service";
import type { LaneRef, LaneState } from "./lane-vocabulary";

const defaultLogger = createLogger(
  "workflows.primitives.workflow-agent-caller",
);

const DEFAULT_WRITE_CAPABILITY: LaneWriteCapability = "write_capable";

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
   * Optional Claude context-limit threshold forwarded into the lane outcome
   * so the lane service can flip `rotateBeforeNextTurn` when the turn's
   * `contextTokens` exceeds it. Codex lanes ignore this — Codex never
   * exposes context-window metrics.
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
   * Creates a fresh Claude conversation for the lane. The adapter calls this
   * on the create path and on stale-recovery, and persists the new
   * conversationId on lane state.
   */
  createClaudeConversation(input: {
    laneRef: LaneRef;
  }): Promise<{ conversationId: string }>;
  /**
   * Probes the backend for an existing Claude conversation; resolves `false`
   * when stale so the adapter can swap to fresh-session before the call.
   */
  validateClaudeConversation(input: {
    conversationId: string;
  }): Promise<boolean>;
  /** Creates a fresh Codex thread for the lane. */
  startCodexThread(input: { laneRef: LaneRef }): Promise<{ threadId: string }>;
  /**
   * Resumes a Codex thread by id; rejects when the thread no longer exists
   * so the adapter can swap to fresh-thread before the call.
   */
  resumeCodexThread(input: { threadId: string }): Promise<{ threadId: string }>;
  now?(): string;
  logger?: Logger;
}

export interface WorkflowAgentCaller {
  call(request: WorkflowAgentCallerRequest): Promise<AgentCallResult>;
}

export function createWorkflowAgentCaller(
  deps: WorkflowAgentCallerDeps,
): WorkflowAgentCaller {
  const log = deps.logger ?? defaultLogger;
  const now = deps.now ?? (() => new Date().toISOString());

  return {
    async call(request) {
      const writeCapability =
        request.writeCapability ?? DEFAULT_WRITE_CAPABILITY;

      return deps.laneScheduler.schedule(
        {
          sessionKey: request.sessionKey,
          writeCapability,
          workflowId: request.laneRef.workflowId,
          laneId: request.laneRef.laneId,
        },
        async () => executeWithContinuity(request, deps, log, now),
      );
    },
  };
}

async function executeWithContinuity(
  request: WorkflowAgentCallerRequest,
  deps: WorkflowAgentCallerDeps,
  log: Logger,
  now: () => string,
): Promise<AgentCallResult> {
  const lane = await deps.laneService.resolve(request.laneRef);
  if (!lane) {
    throw new Error(
      `WorkflowAgentCaller: lane ${request.laneRef.workflowId}/${request.laneRef.laneId} is not initialized; call laneService.initialize() first`,
    );
  }

  const firstAttempt = await resolveContinuity(lane, deps, log);
  let activeContinuity = firstAttempt.continuity;
  let activeLane = firstAttempt.lane;

  let result: AgentCallResult;
  try {
    result = await deps.callAgent(request.agentCallRequest, activeContinuity);
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
    const recovered = await recoverFreshBackend(activeLane, deps, log);
    activeContinuity = recovered.continuity;
    activeLane = recovered.lane;
    result = await deps.callAgent(request.agentCallRequest, activeContinuity);
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
  deps: WorkflowAgentCallerDeps,
  log: Logger,
): Promise<ContinuityResolution> {
  if (lane.metrics.rotateBeforeNextTurn) {
    log.debug("workflow_agent_caller.rotation.scheduled", {
      workflowId: lane.workflowId,
      laneId: lane.laneId,
      backend: lane.backend,
    });
    return startFreshBackend(lane, deps, log);
  }

  if (!lane.policy.continuityEnabled) {
    log.debug("workflow_agent_caller.continuity.disabled", {
      workflowId: lane.workflowId,
      laneId: lane.laneId,
      backend: lane.backend,
    });
    return startFreshBackend(lane, deps, log);
  }

  if (lane.backend === "claude") {
    if (lane.backendState.backend !== "claude") {
      throw new Error(
        "WorkflowAgentCaller: lane backendState branch mismatched at resolve time",
      );
    }
    const conversationId = lane.backendState.conversationId;
    if (!conversationId) {
      return startFreshBackend(lane, deps, log);
    }
    const valid = await deps.validateClaudeConversation({ conversationId });
    if (!valid) {
      log.warn("workflow_agent_caller.stale_backend_ref.recovery", {
        workflowId: lane.workflowId,
        laneId: lane.laneId,
        backend: "claude",
        reason: "claude_conversation_not_found",
        conversationId,
      });
      return startFreshBackend(lane, deps, log);
    }
    return {
      lane,
      continuity: {
        laneRef: { workflowId: lane.workflowId, laneId: lane.laneId },
        resumeRef: { backend: "claude", sessionId: conversationId },
        laneAction: "reuse",
      },
    };
  }

  if (lane.backendState.backend !== "codex") {
    throw new Error(
      "WorkflowAgentCaller: lane backendState branch mismatched at resolve time",
    );
  }
  const threadId = lane.backendState.threadId;
  if (!threadId) {
    return startFreshBackend(lane, deps, log);
  }
  try {
    const resumed = await deps.resumeCodexThread({ threadId });
    return {
      lane,
      continuity: {
        laneRef: { workflowId: lane.workflowId, laneId: lane.laneId },
        resumeRef: { backend: "codex", threadId: resumed.threadId },
        laneAction: "reuse",
      },
    };
  } catch (err) {
    log.warn("workflow_agent_caller.stale_backend_ref.recovery", {
      workflowId: lane.workflowId,
      laneId: lane.laneId,
      backend: "codex",
      reason: "codex_resume_failed",
      threadId,
      error: err instanceof Error ? err.message : String(err),
    });
    return startFreshBackend(lane, deps, log);
  }
}

async function startFreshBackend(
  lane: LaneState,
  deps: WorkflowAgentCallerDeps,
  log: Logger,
): Promise<ContinuityResolution> {
  if (lane.backend === "claude") {
    const { conversationId } = await deps.createClaudeConversation({
      laneRef: { workflowId: lane.workflowId, laneId: lane.laneId },
    });
    log.info("workflow_agent_caller.lane.create_fresh", {
      workflowId: lane.workflowId,
      laneId: lane.laneId,
      backend: "claude",
      conversationId,
    });
    const fresh: LaneState = {
      workflowId: lane.workflowId,
      laneId: lane.laneId,
      backend: "claude",
      writeCapability: lane.writeCapability,
      policy: lane.policy,
      backendState: { backend: "claude", conversationId },
      metrics: { backend: "claude", rotateBeforeNextTurn: false },
      lastUsedAt: lane.lastUsedAt,
    };
    const updated = await deps.laneService.initialize(fresh);
    return {
      lane: updated,
      continuity: {
        laneRef: { workflowId: lane.workflowId, laneId: lane.laneId },
        resumeRef: { backend: "claude", sessionId: conversationId },
        laneAction: "create",
      },
    };
  }

  const { threadId } = await deps.startCodexThread({
    laneRef: { workflowId: lane.workflowId, laneId: lane.laneId },
  });
  log.info("workflow_agent_caller.lane.create_fresh", {
    workflowId: lane.workflowId,
    laneId: lane.laneId,
    backend: "codex",
    threadId,
  });
  const fresh: LaneState = {
    workflowId: lane.workflowId,
    laneId: lane.laneId,
    backend: "codex",
    writeCapability: lane.writeCapability,
    policy: lane.policy,
    backendState: { backend: "codex", threadId },
    metrics: { backend: "codex", rotateBeforeNextTurn: false },
    lastUsedAt: lane.lastUsedAt,
  };
  const updated = await deps.laneService.initialize(fresh);
  return {
    lane: updated,
    continuity: {
      laneRef: { workflowId: lane.workflowId, laneId: lane.laneId },
      resumeRef: { backend: "codex", threadId },
      laneAction: "create",
    },
  };
}

async function recoverFreshBackend(
  lane: LaneState,
  deps: WorkflowAgentCallerDeps,
  log: Logger,
): Promise<ContinuityResolution> {
  return startFreshBackend(lane, deps, log);
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
  if (outcome === null) {
    return;
  }
  try {
    await deps.laneService.recordOutcome(ref, outcome);
  } catch (err) {
    log.error("workflow_agent_caller.record_outcome_failed", {
      workflowId: lane.workflowId,
      laneId: lane.laneId,
      backend: lane.backend,
      message: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

function buildLaneOutcome(
  lane: LaneState,
  request: WorkflowAgentCallerRequest,
  result: AgentCallResult,
): LaneOutcome | null {
  const failed = result.outcome.kind === "failed";

  if (lane.backend === "claude") {
    const usage = result.usage;
    const conversationId =
      result.backendRef?.backend === "claude"
        ? result.backendRef.sessionId
        : undefined;
    const claudeOutcome: LaneOutcome = {
      backend: "claude",
      ...(usage.contextTokens !== undefined
        ? { contextTokens: usage.contextTokens }
        : {}),
      ...(usage.contextWindowMax !== undefined
        ? { contextWindowMax: usage.contextWindowMax }
        : {}),
      ...(request.contextLimitTokens !== undefined
        ? { contextLimitTokens: request.contextLimitTokens }
        : {}),
      ...(conversationId !== undefined ? { conversationId } : {}),
      ...(failed ? { failed: true } : {}),
    };
    return claudeOutcome;
  }

  const usage = result.usage;
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
  const threadId =
    result.backendRef?.backend === "codex"
      ? result.backendRef.threadId
      : undefined;
  const codexOutcome: LaneOutcome = {
    backend: "codex",
    ...(threadId !== undefined ? { threadId } : {}),
    ...(lastTurnUsage !== undefined ? { lastTurnUsage } : {}),
    ...(failed ? { failed: true } : {}),
  };
  return codexOutcome;
}
