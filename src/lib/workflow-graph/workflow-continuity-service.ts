import { createLogger } from "@/lib/logging";
import { getExecutionLogger } from "@/lib/workflow-graph/execution-logger";
import {
  toGraph,
  toGraphLimitEvaluation,
  toPrimitive,
  type GraphWorkflowLaneAdapterInputContext,
} from "@/lib/workflows/primitives/graph-workflow-lane-adapter";
import {
  createLaneService,
  type LaneOutcome,
  type LaneService,
} from "@/lib/workflows/primitives/lane-service";
import { createInMemoryLaneStore } from "@/lib/workflows/primitives/lane-store";
import type { LaneState } from "@/lib/workflows/primitives/lane-vocabulary";
import type {
  GraphWorkflowExecution,
  GraphWorkflowLaneKind,
  GraphWorkflowAgentSessionState,
  GraphWorkflowAgentSessionTurnUsage,
} from "@/lib/workflows/schemas";
const logger = createLogger("workflow-continuity");

// ============================================================
// Dependency Injection
// ============================================================

export interface WorkflowContinuityServiceDeps {
  createConversation(
    projectPath: string,
    sessionName: string,
    opts: {
      role: "iteration" | "validator";
      agentBackend?: "claude" | "codex";
    },
  ): Promise<{ id: string }>;
  getConversation(
    projectPath: string,
    sessionName: string,
    conversationId: string,
  ): Promise<{ id: string } | null>;
  startCodexThread(): Promise<{ threadId: string }>;
  resumeCodexThread(threadId: string): Promise<{ threadId: string }>;
  now?(): string;
  /**
   * Shared workflow primitive lane service. When provided, the continuity
   * service routes lane creation and post-turn outcome recording through the
   * primitive layer, keeping the graph-only fields (contextId,
   * workflowConversationId, limitEvaluation) in the adapter extras while the
   * shared metrics live in the primitive lane state.
   *
   * Defaults to a service backed by an in-memory lane store so existing
   * callers see no behavioral change beyond shared schema validation.
   */
  laneService?: LaneService;
}

// ============================================================
// Resolved call types
// ============================================================

export interface ResolvedImplementerCall {
  execution: GraphWorkflowExecution;
  conversationId: string;
  sessionAction: "reuse" | "create";
  promptMode: "iteration_seed" | "follow_up";
}

export type ResolvedValidatorCall =
  | {
      execution: GraphWorkflowExecution;
      sessionAction: "reuse" | "create";
      engine: "claude";
      conversationId: string;
    }
  | {
      execution: GraphWorkflowExecution;
      sessionAction: "reuse" | "create";
      engine: "codex";
      threadId: string;
    };

// ============================================================
// Input types
// ============================================================

export interface ResolveImplementerCallInput {
  execution: GraphWorkflowExecution;
  projectPath: string;
  sessionName: string;
  contextId: string;
  engine?: "claude" | "codex";
}

export interface ResolveValidatorCallInput {
  execution: GraphWorkflowExecution;
  projectPath: string;
  sessionName: string;
  contextId: string;
  lane: "context_validator";
  engine: "claude" | "codex";
}

export interface RecordClaudeLaneTurnInput {
  execution: GraphWorkflowExecution;
  contextId: string;
  lane: GraphWorkflowLaneKind;
  contextTokens: number | null;
  contextWindowMax: number | null;
  contextLimitTokens: number | undefined;
  /** True when the SDK auto-compacted the context at least once this turn. */
  compacted?: boolean;
}

export interface RecordCodexLaneTurnInput {
  execution: GraphWorkflowExecution;
  contextId: string;
  lane: GraphWorkflowLaneKind;
  usage: GraphWorkflowAgentSessionTurnUsage | null;
  contextLimitTokens: number | undefined;
  /** Real Codex thread ID captured after the turn completes. Updates sessionRef when provided. */
  newThreadId?: string | null;
  /** True when the turn failed before producing a real thread. Forces the next call to rotate so phantom thread IDs are not reused. */
  failed?: boolean;
}

// ============================================================
// Internal helpers
// ============================================================

function getNow(deps: WorkflowContinuityServiceDeps): string {
  return deps.now?.() ?? new Date().toISOString();
}

/** Returns true when the lane should start a fresh session instead of reusing. */
function shouldRotate(
  laneState: GraphWorkflowAgentSessionState | undefined,
  contextId: string,
  continuityEnabled: boolean,
  engine?: "claude" | "codex",
): boolean {
  if (!laneState) return true;
  if (laneState.contextId !== contextId) return true;
  if (!continuityEnabled) return true;
  if (laneState.rotateBeforeNextTurn) return true;
  if (engine !== undefined && laneState.engine !== engine) return true;
  return false;
}

function getImplementerContinuityEnabled(
  execution: GraphWorkflowExecution,
  contextId: string,
): boolean {
  const ctx = execution.workingDefinition.executionContexts.find(
    (c) => c.id === contextId,
  );
  return ctx?.iterationPolicy.continuity.enabled ?? true;
}

function getValidatorContinuityEnabled(
  execution: GraphWorkflowExecution,
  contextId: string,
): boolean {
  const ctx = execution.workingDefinition.executionContexts.find(
    (c) => c.id === contextId,
  );
  if (!ctx) return true;
  return ctx.contextValidator?.continuity.enabled ?? true;
}

function withLaneState(
  execution: GraphWorkflowExecution,
  contextId: string,
  lane: GraphWorkflowLaneKind,
  state: GraphWorkflowAgentSessionState,
): GraphWorkflowExecution {
  const previousContextLanes = execution.laneStates[contextId] ?? {};
  return {
    ...execution,
    laneStates: {
      ...execution.laneStates,
      [contextId]: {
        ...previousContextLanes,
        [lane]: state,
      },
    },
  };
}

function getCurrentLane(
  execution: GraphWorkflowExecution,
  contextId: string,
  lane: GraphWorkflowLaneKind,
): GraphWorkflowAgentSessionState | undefined {
  return execution.laneStates[contextId]?.[lane];
}

/**
 * Build the adapter context shared across primitive projections — the
 * execution id is the workflow scope and the iteration policy decides
 * continuity / context-limit semantics.
 */
function buildAdapterContext(
  execution: GraphWorkflowExecution,
  lane: GraphWorkflowLaneKind,
  contextId: string,
): GraphWorkflowLaneAdapterInputContext {
  const ctx = execution.workingDefinition.executionContexts.find(
    (c) => c.id === contextId,
  );
  const continuityEnabled =
    lane === "implementer"
      ? (ctx?.iterationPolicy.continuity.enabled ?? true)
      : (ctx?.contextValidator?.continuity.enabled ?? true);
  return {
    executionId: execution.id,
    policy: { continuityEnabled },
  };
}

// ============================================================
// Service factory
// ============================================================

export function createWorkflowContinuityService(
  deps: WorkflowContinuityServiceDeps,
) {
  const laneService =
    deps.laneService ??
    createLaneService({ store: createInMemoryLaneStore(), now: deps.now });

  async function persistLaneState(
    execution: GraphWorkflowExecution,
    laneState: GraphWorkflowAgentSessionState,
    contextId: string,
  ): Promise<void> {
    const adapterCtx = buildAdapterContext(
      execution,
      laneState.lane,
      contextId,
    );
    const { primitive } = toPrimitive(laneState, adapterCtx);
    await laneService.initialize(primitive);
  }

  async function recordLaneOutcome(
    execution: GraphWorkflowExecution,
    laneState: GraphWorkflowAgentSessionState,
    outcome: LaneOutcome,
  ): Promise<GraphWorkflowAgentSessionState> {
    const adapterCtx = buildAdapterContext(
      execution,
      laneState.lane,
      laneState.contextId,
    );
    const { primitive, extras } = toPrimitive(laneState, adapterCtx);
    let existing: LaneState | null = null;
    try {
      existing = await laneService.resolve({
        workflowId: primitive.workflowId,
        laneId: primitive.laneId,
      });
    } catch {
      existing = null;
    }
    if (!existing) {
      await laneService.initialize(primitive);
    }
    const { state: updated, contextLimitEvaluation } =
      await laneService.recordOutcome(
        { workflowId: primitive.workflowId, laneId: primitive.laneId },
        outcome,
      );
    // The lane service is the single decision site; map its honest verdict onto
    // the coarser graph label. A Claude turn without occupancy metrics surfaces
    // as "metrics_unavailable" rather than a fabricated "supported".
    const nextExtras = {
      ...extras,
      limitEvaluation: toGraphLimitEvaluation(contextLimitEvaluation),
    };
    return toGraph(updated, nextExtras);
  }

  async function createFreshClaudeLane(
    projectPath: string,
    sessionName: string,
    lane: GraphWorkflowLaneKind,
    contextId: string,
    role: "iteration" | "validator",
    reason: string,
    now: string,
    execution: GraphWorkflowExecution,
  ): Promise<{
    laneState: GraphWorkflowAgentSessionState;
    conversationId: string;
  }> {
    const conversation = await deps.createConversation(
      projectPath,
      sessionName,
      { role, agentBackend: "claude" },
    );
    const laneState: GraphWorkflowAgentSessionState = {
      engine: "claude",
      lane,
      contextId,
      workflowConversationId: conversation.id,
      sessionRef: {
        engine: "claude",
        lane,
        conversationId: conversation.id,
      },
      lastContextTokens: null,
      lastContextWindowMax: null,
      rotateBeforeNextTurn: false,
      limitEvaluation: "disabled",
      lastUsedAt: now,
    };

    await persistLaneState(execution, laneState, contextId);

    logger.info("workflow-continuity.lane.create", {
      lane,
      engine: "claude",
      contextId,
      conversationId: conversation.id,
      reason,
    });

    return { laneState, conversationId: conversation.id };
  }

  async function resolveImplementerCall(
    input: ResolveImplementerCallInput,
  ): Promise<ResolvedImplementerCall> {
    const { execution, projectPath, sessionName, contextId } = input;
    const engine = input.engine ?? "claude";
    const lane: GraphWorkflowLaneKind = "implementer";
    const laneState = getCurrentLane(execution, contextId, lane);
    const continuityEnabled = getImplementerContinuityEnabled(
      execution,
      contextId,
    );
    const rotate = shouldRotate(
      laneState,
      contextId,
      continuityEnabled,
      engine,
    );
    const now = getNow(deps);

    if (rotate) {
      const reason = !laneState
        ? "no_prior_lane"
        : laneState.contextId !== contextId
          ? "context_changed"
          : !continuityEnabled
            ? "continuity_disabled"
            : laneState.engine !== engine
              ? "engine_changed"
              : "rotation_scheduled";

      const execLogger = getExecutionLogger(execution.id);
      execLogger?.decision("implementer.rotation", {
        contextId,
        engine,
        reason,
        continuityEnabled,
        previousContextId: laneState?.contextId ?? null,
        previousEngine: laneState?.engine ?? null,
      });

      if (reason === "context_changed" && laneState) {
        logger.warn("workflow-continuity.stale_session.reset", {
          lane,
          engine,
          contextId,
          staleContextId: laneState.contextId,
        });
      }

      if (engine === "codex") {
        return createFreshCodexImplementerLane(
          execution,
          projectPath,
          sessionName,
          contextId,
          reason,
          now,
        );
      }

      const { laneState: newLaneState, conversationId } =
        await createFreshClaudeLane(
          projectPath,
          sessionName,
          lane,
          contextId,
          "iteration",
          reason,
          now,
          execution,
        );

      return {
        execution: withLaneState(execution, contextId, lane, newLaneState),
        conversationId,
        sessionAction: "create",
        promptMode: "iteration_seed",
      };
    }

    // Reuse path — validate both CC conversation and backend session still exist
    const existingLane = laneState!;

    if (engine === "codex") {
      return reuseCodexImplementerLane(
        execution,
        existingLane,
        projectPath,
        sessionName,
        contextId,
        now,
      );
    }

    // Claude reuse path — validate conversation still exists
    const conversationId =
      existingLane.workflowConversationId ??
      (existingLane.engine === "claude" &&
      existingLane.sessionRef.engine === "claude"
        ? existingLane.sessionRef.conversationId
        : "");

    const existingConversation = await deps.getConversation(
      projectPath,
      sessionName,
      conversationId,
    );

    if (!existingConversation) {
      logger.warn("workflow-continuity.stale_session.recovery", {
        lane,
        engine: "claude",
        contextId,
        conversationId,
        reason: "conversation_not_found",
      });

      const { laneState: newLaneState, conversationId: freshId } =
        await createFreshClaudeLane(
          projectPath,
          sessionName,
          lane,
          contextId,
          "iteration",
          "stale_recovery",
          now,
          execution,
        );

      return {
        execution: withLaneState(execution, contextId, lane, newLaneState),
        conversationId: freshId,
        sessionAction: "create",
        promptMode: "iteration_seed",
      };
    }

    const updatedLaneState: GraphWorkflowAgentSessionState = {
      ...existingLane,
      lastUsedAt: now,
    } as GraphWorkflowAgentSessionState;

    logger.info("workflow-continuity.lane.reuse", {
      lane,
      engine: "claude",
      contextId,
      conversationId,
    });

    return {
      execution: withLaneState(execution, contextId, lane, updatedLaneState),
      conversationId,
      sessionAction: "reuse",
      promptMode: "follow_up",
    };
  }

  async function createFreshCodexImplementerLane(
    execution: GraphWorkflowExecution,
    projectPath: string,
    sessionName: string,
    contextId: string,
    reason: string,
    now: string,
  ): Promise<ResolvedImplementerCall> {
    const lane: GraphWorkflowLaneKind = "implementer";
    const conversation = await deps.createConversation(
      projectPath,
      sessionName,
      { role: "iteration", agentBackend: "codex" },
    );

    const newLaneState: GraphWorkflowAgentSessionState = {
      engine: "codex",
      lane,
      contextId,
      workflowConversationId: conversation.id,
      lastTurnUsage: null,
      rotateBeforeNextTurn: false,
      limitEvaluation: "disabled",
      lastUsedAt: now,
    };

    await persistLaneState(execution, newLaneState, contextId);

    logger.info("workflow-continuity.lane.create", {
      lane,
      engine: "codex",
      contextId,
      conversationId: conversation.id,
      reason,
    });

    return {
      execution: withLaneState(execution, contextId, lane, newLaneState),
      conversationId: conversation.id,
      sessionAction: "create",
      promptMode: "iteration_seed",
    };
  }

  async function reuseCodexImplementerLane(
    execution: GraphWorkflowExecution,
    existingLane: GraphWorkflowAgentSessionState,
    projectPath: string,
    sessionName: string,
    contextId: string,
    now: string,
  ): Promise<ResolvedImplementerCall> {
    const lane: GraphWorkflowLaneKind = "implementer";
    const ccConversationId = existingLane.workflowConversationId ?? "";

    // Verify the CC conversation still exists
    const existingConversation = await deps.getConversation(
      projectPath,
      sessionName,
      ccConversationId,
    );

    if (!existingConversation) {
      logger.warn("workflow-continuity.stale_session.recovery", {
        lane,
        engine: "codex",
        contextId,
        ccConversationId,
        reason: "conversation_not_found",
      });
      return createFreshCodexImplementerLane(
        execution,
        projectPath,
        sessionName,
        contextId,
        "stale_recovery",
        now,
      );
    }

    const updatedLane: GraphWorkflowAgentSessionState = {
      ...existingLane,
      lastUsedAt: now,
    } as GraphWorkflowAgentSessionState;

    logger.info("workflow-continuity.lane.reuse", {
      lane,
      engine: "codex",
      contextId,
      conversationId: ccConversationId,
    });

    return {
      execution: withLaneState(execution, contextId, lane, updatedLane),
      conversationId: ccConversationId,
      sessionAction: "reuse",
      promptMode: "follow_up",
    };
  }

  async function resolveValidatorCall(
    input: ResolveValidatorCallInput,
  ): Promise<ResolvedValidatorCall> {
    const { execution, projectPath, sessionName, contextId, lane, engine } =
      input;
    const laneState = getCurrentLane(execution, contextId, lane);
    const continuityEnabled = getValidatorContinuityEnabled(
      execution,
      contextId,
    );
    const rotate = shouldRotate(
      laneState,
      contextId,
      continuityEnabled,
      engine,
    );
    const now = getNow(deps);

    if (engine === "claude") {
      if (rotate) {
        const reason = !laneState
          ? "no_prior_lane"
          : laneState.contextId !== contextId
            ? "context_changed"
            : !continuityEnabled
              ? "continuity_disabled"
              : "rotation_scheduled";

        const { laneState: newLaneState, conversationId } =
          await createFreshClaudeLane(
            projectPath,
            sessionName,
            lane,
            contextId,
            "validator",
            reason,
            now,
            execution,
          );

        return {
          execution: withLaneState(execution, contextId, lane, newLaneState),
          sessionAction: "create",
          engine: "claude",
          conversationId,
        };
      }

      // Reuse path — validate conversation still exists
      const existingRef = laneState!.sessionRef;
      const conversationId =
        existingRef?.engine === "claude" ? existingRef.conversationId : "";

      const existingConversation = await deps.getConversation(
        projectPath,
        sessionName,
        conversationId,
      );

      if (!existingConversation) {
        logger.warn("workflow-continuity.stale_session.recovery", {
          lane,
          engine: "claude",
          contextId,
          conversationId,
          reason: "conversation_not_found",
        });

        const { laneState: newLaneState, conversationId: freshId } =
          await createFreshClaudeLane(
            projectPath,
            sessionName,
            lane,
            contextId,
            "validator",
            "stale_recovery",
            now,
            execution,
          );

        return {
          execution: withLaneState(execution, contextId, lane, newLaneState),
          sessionAction: "create",
          engine: "claude",
          conversationId: freshId,
        };
      }

      const updatedLane: GraphWorkflowAgentSessionState = {
        ...laneState!,
        lastUsedAt: now,
      } as GraphWorkflowAgentSessionState;

      logger.info("workflow-continuity.lane.reuse", {
        lane,
        engine: "claude",
        contextId,
        conversationId,
      });

      return {
        execution: withLaneState(execution, contextId, lane, updatedLane),
        sessionAction: "reuse",
        engine: "claude",
        conversationId,
      };
    }

    // Codex validator
    if (rotate) {
      const { threadId } = await deps.startCodexThread();
      const reason = !laneState
        ? "no_prior_lane"
        : laneState.contextId !== contextId
          ? "context_changed"
          : !continuityEnabled
            ? "continuity_disabled"
            : "rotation_scheduled";

      const newLaneState: GraphWorkflowAgentSessionState = {
        engine: "codex",
        lane,
        contextId,
        sessionRef: { engine: "codex", lane, threadId },
        lastTurnUsage: null,
        rotateBeforeNextTurn: false,
        limitEvaluation: "disabled",
        lastUsedAt: now,
      };

      await persistLaneState(execution, newLaneState, contextId);

      logger.info("workflow-continuity.lane.create", {
        lane,
        engine: "codex",
        contextId,
        threadId,
        reason,
      });

      return {
        execution: withLaneState(execution, contextId, lane, newLaneState),
        sessionAction: "create",
        engine: "codex",
        threadId,
      };
    }

    // Resume existing Codex thread, with fallback to a fresh thread on failure
    const existingRef = laneState!.sessionRef;
    const storedThreadId =
      existingRef?.engine === "codex" ? existingRef.threadId : "";

    try {
      const { threadId: resumedThreadId } =
        await deps.resumeCodexThread(storedThreadId);

      const updatedLane: GraphWorkflowAgentSessionState = {
        ...laneState!,
        lastUsedAt: now,
      } as GraphWorkflowAgentSessionState;

      logger.info("workflow-continuity.lane.reuse", {
        lane,
        engine: "codex",
        contextId,
        threadId: resumedThreadId,
      });

      return {
        execution: withLaneState(execution, contextId, lane, updatedLane),
        sessionAction: "reuse",
        engine: "codex",
        threadId: resumedThreadId,
      };
    } catch (error) {
      // Stale thread reference — start a fresh thread instead of failing
      logger.warn("workflow-continuity.stale_session.recovery", {
        lane,
        engine: "codex",
        contextId,
        storedThreadId,
        error: error instanceof Error ? error.message : String(error),
      });

      const { threadId: freshThreadId } = await deps.startCodexThread();
      const freshLaneState: GraphWorkflowAgentSessionState = {
        engine: "codex",
        lane,
        contextId,
        sessionRef: { engine: "codex", lane, threadId: freshThreadId },
        lastTurnUsage: null,
        rotateBeforeNextTurn: false,
        limitEvaluation: "disabled",
        lastUsedAt: now,
      };

      await persistLaneState(execution, freshLaneState, contextId);

      logger.info("workflow-continuity.lane.create", {
        lane,
        engine: "codex",
        contextId,
        threadId: freshThreadId,
        reason: "stale_recovery",
      });

      return {
        execution: withLaneState(execution, contextId, lane, freshLaneState),
        sessionAction: "create",
        engine: "codex",
        threadId: freshThreadId,
      };
    }
  }

  async function recordClaudeTurnOutcome(
    input: RecordClaudeLaneTurnInput,
  ): Promise<GraphWorkflowExecution> {
    const {
      execution,
      contextId,
      lane,
      contextTokens,
      contextWindowMax,
      contextLimitTokens,
      compacted,
    } = input;
    const laneState = getCurrentLane(execution, contextId, lane);
    if (!laneState || laneState.engine !== "claude") return execution;

    const overLimit =
      contextLimitTokens !== undefined &&
      contextTokens !== null &&
      contextTokens > contextLimitTokens;
    // A compaction deflates the recorded occupancy below the limit, so the
    // numeric comparison alone would miss it — treat "compacted under a
    // configured limit" as a rotation trigger too.
    const compactionUnderLimit =
      compacted === true && contextLimitTokens !== undefined;

    if (overLimit || compactionUnderLimit) {
      const reason: "context_over_limit" | "compaction_detected" = overLimit
        ? "context_over_limit"
        : "compaction_detected";

      logger.info("workflow-continuity.rotation.scheduled", {
        lane,
        contextTokens,
        limit: contextLimitTokens,
        reason,
      });

      const execLogger = getExecutionLogger(execution.id);
      execLogger?.decision("rotation.scheduled", {
        lane,
        engine: "claude",
        contextId,
        contextTokens,
        contextWindowMax,
        contextLimitTokens,
        reason,
        utilization:
          contextWindowMax && contextTokens !== null
            ? Math.round((contextTokens / contextWindowMax) * 100)
            : null,
      });
    }

    const outcome: LaneOutcome = {
      backend: "claude",
      ...(contextTokens !== null ? { contextTokens } : {}),
      ...(contextWindowMax !== null ? { contextWindowMax } : {}),
      ...(contextLimitTokens !== undefined ? { contextLimitTokens } : {}),
      compactedThisTurn: compacted ?? false,
    };

    const updatedLane = await recordLaneOutcome(execution, laneState, outcome);
    return withLaneState(execution, contextId, lane, updatedLane);
  }

  async function recordCodexTurnOutcome(
    input: RecordCodexLaneTurnInput,
  ): Promise<GraphWorkflowExecution> {
    const {
      execution,
      contextId,
      lane,
      usage,
      contextLimitTokens,
      newThreadId,
      failed,
    } = input;
    const laneState = getCurrentLane(execution, contextId, lane);
    if (!laneState || laneState.engine !== "codex") return execution;

    const outcome: LaneOutcome = {
      backend: "codex",
      lastTurnUsage: usage,
      ...(contextLimitTokens !== undefined ? { contextLimitTokens } : {}),
      ...(newThreadId != null ? { threadId: newThreadId } : {}),
      ...(failed === true ? { failed: true } : {}),
    };

    const updatedLane = await recordLaneOutcome(execution, laneState, outcome);
    return withLaneState(execution, contextId, lane, updatedLane);
  }

  function clearForNewContext(
    execution: GraphWorkflowExecution,
    nextContextId: string,
  ): GraphWorkflowExecution {
    const previousLanesForContext = execution.laneStates[nextContextId] ?? {};
    logger.info("workflow-continuity.context.reset", {
      nextContextId,
      clearedLanes: Object.keys(previousLanesForContext),
    });

    const { [nextContextId]: _cleared, ...remainingLaneStates } =
      execution.laneStates;
    return { ...execution, laneStates: remainingLaneStates };
  }

  return {
    resolveImplementerCall,
    resolveValidatorCall,
    recordClaudeTurnOutcome,
    recordCodexTurnOutcome,
    clearForNewContext,
  };
}
