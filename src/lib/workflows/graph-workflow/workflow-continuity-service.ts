import { createLogger } from "@/lib/logging";
import type {
  GraphWorkflowExecution,
  GraphWorkflowLaneKind,
  GraphWorkflowLaneState,
  GraphWorkflowLaneTurnUsage,
} from "@/types";

const logger = createLogger("workflow-continuity");

// ============================================================
// Dependency Injection
// ============================================================

export interface WorkflowContinuityServiceDeps {
  createConversation(
    projectPath: string,
    sessionName: string,
    opts: { role: "iteration" | "validator" },
  ): Promise<{ id: string }>;
  getConversation(
    projectPath: string,
    sessionName: string,
    conversationId: string,
  ): Promise<{ id: string } | null>;
  startCodexThread(): Promise<{ threadId: string }>;
  resumeCodexThread(threadId: string): Promise<{ threadId: string }>;
  now?(): string;
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
}

export interface ResolveValidatorCallInput {
  execution: GraphWorkflowExecution;
  projectPath: string;
  sessionName: string;
  contextId: string;
  lane: "task_validator" | "context_validator";
  engine: "claude" | "codex";
}

export interface RecordClaudeLaneTurnInput {
  execution: GraphWorkflowExecution;
  lane: GraphWorkflowLaneKind;
  contextTokens: number | null;
  contextWindowMax: number | null;
  contextLimitTokens: number | undefined;
}

export interface RecordCodexLaneTurnInput {
  execution: GraphWorkflowExecution;
  lane: GraphWorkflowLaneKind;
  usage: GraphWorkflowLaneTurnUsage | null;
  contextLimitTokens: number | undefined;
  /** Real Codex thread ID captured after the turn completes. Updates sessionRef when provided. */
  newThreadId?: string | null;
}

// ============================================================
// Internal helpers
// ============================================================

function getNow(deps: WorkflowContinuityServiceDeps): string {
  return deps.now?.() ?? new Date().toISOString();
}

/** Returns true when the lane should start a fresh session instead of reusing. */
function shouldRotate(
  laneState: GraphWorkflowLaneState | undefined,
  contextId: string,
  continuityEnabled: boolean,
): boolean {
  if (!laneState) return true;
  if (laneState.contextId !== contextId) return true;
  if (!continuityEnabled) return true;
  if (laneState.rotateBeforeNextTurn) return true;
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
  lane: "task_validator" | "context_validator",
): boolean {
  const ctx = execution.workingDefinition.executionContexts.find(
    (c) => c.id === contextId,
  );
  if (!ctx) return true;
  if (lane === "task_validator") {
    return ctx.taskValidation?.continuity.enabled ?? true;
  }
  // context_validator
  return ctx.contextValidation?.agentValidator?.continuity.enabled ?? true;
}

function withLaneState(
  execution: GraphWorkflowExecution,
  lane: GraphWorkflowLaneKind,
  state: GraphWorkflowLaneState,
): GraphWorkflowExecution {
  return {
    ...execution,
    laneStates: {
      ...execution.laneStates,
      [lane]: state,
    },
  };
}

function getCurrentLane(
  execution: GraphWorkflowExecution,
  lane: GraphWorkflowLaneKind,
): GraphWorkflowLaneState | undefined {
  return execution.laneStates[lane];
}

// ============================================================
// Service factory
// ============================================================

export function createWorkflowContinuityService(
  deps: WorkflowContinuityServiceDeps,
) {
  async function createFreshClaudeLane(
    projectPath: string,
    sessionName: string,
    lane: GraphWorkflowLaneKind,
    contextId: string,
    role: "iteration" | "validator",
    reason: string,
    now: string,
  ): Promise<{ laneState: GraphWorkflowLaneState; conversationId: string }> {
    const conversation = await deps.createConversation(
      projectPath,
      sessionName,
      {
        role,
      },
    );
    const laneState: GraphWorkflowLaneState = {
      engine: "claude",
      lane,
      contextId,
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
    const lane: GraphWorkflowLaneKind = "implementer";
    const laneState = getCurrentLane(execution, lane);
    const continuityEnabled = getImplementerContinuityEnabled(
      execution,
      contextId,
    );
    const rotate = shouldRotate(laneState, contextId, continuityEnabled);
    const now = getNow(deps);

    if (rotate) {
      const reason = !laneState
        ? "no_prior_lane"
        : laneState.contextId !== contextId
          ? "context_changed"
          : !continuityEnabled
            ? "continuity_disabled"
            : "rotation_scheduled";

      if (reason === "context_changed" && laneState) {
        logger.warn("workflow-continuity.stale_session.reset", {
          lane,
          engine: "claude",
          contextId,
          staleContextId: laneState.contextId,
        });
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
        );

      return {
        execution: withLaneState(execution, lane, newLaneState),
        conversationId,
        sessionAction: "create",
        promptMode: "iteration_seed",
      };
    }

    // Reuse path — validate conversation still exists to guard against stale references
    const existingLane = laneState!;
    const conversationId =
      existingLane.engine === "claude" &&
      existingLane.sessionRef.engine === "claude"
        ? existingLane.sessionRef.conversationId
        : "";

    const existingConversation = await deps.getConversation(
      projectPath,
      sessionName,
      conversationId,
    );

    if (!existingConversation) {
      // Stale reference — conversation was deleted or never persisted; fall back to fresh
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
        );

      return {
        execution: withLaneState(execution, lane, newLaneState),
        conversationId: freshId,
        sessionAction: "create",
        promptMode: "iteration_seed",
      };
    }

    const updatedLaneState: GraphWorkflowLaneState = {
      ...existingLane,
      lastUsedAt: now,
    } as GraphWorkflowLaneState;

    logger.info("workflow-continuity.lane.reuse", {
      lane,
      engine: "claude",
      contextId,
      conversationId,
    });

    return {
      execution: withLaneState(execution, lane, updatedLaneState),
      conversationId,
      sessionAction: "reuse",
      promptMode: "follow_up",
    };
  }

  async function resolveValidatorCall(
    input: ResolveValidatorCallInput,
  ): Promise<ResolvedValidatorCall> {
    const { execution, projectPath, sessionName, contextId, lane, engine } =
      input;
    const laneState = getCurrentLane(execution, lane);
    const continuityEnabled = getValidatorContinuityEnabled(
      execution,
      contextId,
      lane,
    );
    const rotate = shouldRotate(laneState, contextId, continuityEnabled);
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
          );

        return {
          execution: withLaneState(execution, lane, newLaneState),
          sessionAction: "create",
          engine: "claude",
          conversationId,
        };
      }

      // Reuse path — validate conversation still exists
      const existingRef = laneState!.sessionRef;
      const conversationId =
        existingRef.engine === "claude" ? existingRef.conversationId : "";

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
          );

        return {
          execution: withLaneState(execution, lane, newLaneState),
          sessionAction: "create",
          engine: "claude",
          conversationId: freshId,
        };
      }

      const updatedLane: GraphWorkflowLaneState = {
        ...laneState!,
        lastUsedAt: now,
      } as GraphWorkflowLaneState;

      logger.info("workflow-continuity.lane.reuse", {
        lane,
        engine: "claude",
        contextId,
        conversationId,
      });

      return {
        execution: withLaneState(execution, lane, updatedLane),
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

      const newLaneState: GraphWorkflowLaneState = {
        engine: "codex",
        lane,
        contextId,
        sessionRef: { engine: "codex", lane, threadId },
        lastTurnUsage: null,
        rotateBeforeNextTurn: false,
        limitEvaluation: "disabled",
        lastUsedAt: now,
      };

      logger.info("workflow-continuity.lane.create", {
        lane,
        engine: "codex",
        contextId,
        threadId,
        reason,
      });

      return {
        execution: withLaneState(execution, lane, newLaneState),
        sessionAction: "create",
        engine: "codex",
        threadId,
      };
    }

    // Resume existing Codex thread, with fallback to a fresh thread on failure
    const existingRef = laneState!.sessionRef;
    const storedThreadId =
      existingRef.engine === "codex" ? existingRef.threadId : "";

    try {
      const { threadId: resumedThreadId } =
        await deps.resumeCodexThread(storedThreadId);

      const updatedLane: GraphWorkflowLaneState = {
        ...laneState!,
        lastUsedAt: now,
      } as GraphWorkflowLaneState;

      logger.info("workflow-continuity.lane.reuse", {
        lane,
        engine: "codex",
        contextId,
        threadId: resumedThreadId,
      });

      return {
        execution: withLaneState(execution, lane, updatedLane),
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
      const freshLaneState: GraphWorkflowLaneState = {
        engine: "codex",
        lane,
        contextId,
        sessionRef: { engine: "codex", lane, threadId: freshThreadId },
        lastTurnUsage: null,
        rotateBeforeNextTurn: false,
        limitEvaluation: "disabled",
        lastUsedAt: now,
      };

      logger.info("workflow-continuity.lane.create", {
        lane,
        engine: "codex",
        contextId,
        threadId: freshThreadId,
        reason: "stale_recovery",
      });

      return {
        execution: withLaneState(execution, lane, freshLaneState),
        sessionAction: "create",
        engine: "codex",
        threadId: freshThreadId,
      };
    }
  }

  function recordClaudeTurnOutcome(
    input: RecordClaudeLaneTurnInput,
  ): GraphWorkflowExecution {
    const {
      execution,
      lane,
      contextTokens,
      contextWindowMax,
      contextLimitTokens,
    } = input;
    const laneState = getCurrentLane(execution, lane);
    if (!laneState || laneState.engine !== "claude") return execution;

    let rotateBeforeNextTurn = false;
    let limitEvaluation: "disabled" | "supported" = "disabled";

    if (contextLimitTokens !== undefined) {
      limitEvaluation = "supported";
      if (contextTokens !== null && contextTokens > contextLimitTokens) {
        rotateBeforeNextTurn = true;

        logger.info("workflow-continuity.rotation.scheduled", {
          lane,
          contextTokens,
          limit: contextLimitTokens,
        });
      }
    }

    const updatedLane: GraphWorkflowLaneState = {
      ...laneState,
      lastContextTokens: contextTokens,
      lastContextWindowMax: contextWindowMax,
      rotateBeforeNextTurn,
      limitEvaluation,
      lastUsedAt: getNow(deps),
    };

    return withLaneState(execution, lane, updatedLane);
  }

  function recordCodexTurnOutcome(
    input: RecordCodexLaneTurnInput,
  ): GraphWorkflowExecution {
    const { execution, lane, usage, contextLimitTokens, newThreadId } = input;
    const laneState = getCurrentLane(execution, lane);
    if (!laneState || laneState.engine !== "codex") return execution;

    // Codex never supports context-window limit rotation
    const limitEvaluation: "disabled" | "unsupported" =
      contextLimitTokens !== undefined ? "unsupported" : "disabled";

    // Update sessionRef.threadId with the real Codex thread ID if captured post-run
    const sessionRef =
      newThreadId != null && laneState.sessionRef.engine === "codex"
        ? { ...laneState.sessionRef, threadId: newThreadId }
        : laneState.sessionRef;

    const updatedLane: GraphWorkflowLaneState = {
      ...laneState,
      sessionRef,
      lastTurnUsage: usage,
      rotateBeforeNextTurn: false,
      limitEvaluation,
      lastUsedAt: getNow(deps),
    };

    return withLaneState(execution, lane, updatedLane);
  }

  function clearForNewContext(
    execution: GraphWorkflowExecution,
    nextContextId: string,
  ): GraphWorkflowExecution {
    logger.info("workflow-continuity.context.reset", {
      nextContextId,
      clearedLanes: Object.keys(execution.laneStates),
    });

    return { ...execution, laneStates: {} };
  }

  return {
    resolveImplementerCall,
    resolveValidatorCall,
    recordClaudeTurnOutcome,
    recordCodexTurnOutcome,
    clearForNewContext,
  };
}
