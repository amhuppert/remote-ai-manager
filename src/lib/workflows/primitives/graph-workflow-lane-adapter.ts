/**
 * Adapter that round-trips `GraphWorkflowAgentSessionState` through the shared
 * primitive `LaneState` shape used by the workflow primitive lane service.
 *
 * Graph workflow lanes carry semantics the primitive layer does not model
 * directly:
 *
 * - `contextId` pins continuity to a specific execution context within a
 *   workflow, which the rotation logic uses to detect stale sessions.
 * - `lane` (`implementer` | `context_validator`) determines the lane's
 *   write capability — implementer writes to the worktree, context_validator
 *   only reads.
 * - `workflowConversationId` references the CC-side conversation that owns
 *   the workflow turn, which is independent of the underlying backend
 *   session reference.
 * - `limitEvaluation` records whether the engine reports context-window
 *   metrics so consumers can branch on real backend capability instead of
 *   guessed parity.
 *
 * Splitting a graph state into `{primitive, extras}` lets the lane service
 * own only the fields it understands while leaving graph-only fields under
 * the graph workflow's control. `toGraph` reconstitutes the original graph
 * state without losing supported metadata or stale-session recovery flags.
 */

import { createLogger } from "@/lib/logging";
import {
  graphWorkflowAgentSessionStateSchema,
  type GraphWorkflowLaneKind,
  type GraphWorkflowAgentSessionState,
} from "@/lib/schemas";
import {
  laneStateSchema,
  type LanePolicy,
  type LaneState,
  type LaneWriteCapability,
} from "./lane-vocabulary";

const logger = createLogger("workflows.primitives.lane.graph-workflow-adapter");

export type GraphLaneLimitEvaluation = "disabled" | "supported" | "unsupported";

export interface GraphWorkflowLaneAdapterInputContext {
  executionId: string;
  policy: LanePolicy;
}

export interface GraphWorkflowLaneExtras {
  lane: GraphWorkflowLaneKind;
  contextId: string;
  workflowConversationId?: string;
  limitEvaluation: GraphLaneLimitEvaluation;
}

export interface GraphWorkflowLanePrimitiveProjection {
  primitive: LaneState;
  extras: GraphWorkflowLaneExtras;
}

export function toPrimitive(
  state: GraphWorkflowAgentSessionState,
  ctx: GraphWorkflowLaneAdapterInputContext,
): GraphWorkflowLanePrimitiveProjection {
  if (state.engine === "claude") {
    return projectClaude(state, ctx);
  }
  return projectCodex(state, ctx);
}

export function toGraph(
  primitive: LaneState,
  extras: GraphWorkflowLaneExtras,
): GraphWorkflowAgentSessionState {
  if (primitive.backend === "claude") {
    return reconstructClaude(primitive, extras);
  }
  return reconstructCodex(primitive, extras);
}

function inferWriteCapability(
  lane: GraphWorkflowLaneKind,
): LaneWriteCapability {
  return lane === "implementer" ? "write_capable" : "read_only";
}

function projectClaude(
  state: Extract<GraphWorkflowAgentSessionState, { engine: "claude" }>,
  ctx: GraphWorkflowLaneAdapterInputContext,
): GraphWorkflowLanePrimitiveProjection {
  if (state.sessionRef.engine !== "claude") {
    throw new Error(
      "graph-lane adapter: Claude lane sessionRef must be engine=claude",
    );
  }
  const sessionRefConversationId = state.sessionRef.conversationId;
  const primitive = laneStateSchema.parse({
    workflowId: ctx.executionId,
    laneId: state.lane,
    backend: "claude",
    writeCapability: inferWriteCapability(state.lane),
    policy: ctx.policy,
    backendState: {
      backend: "claude",
      conversationId: sessionRefConversationId,
    },
    metrics: {
      backend: "claude",
      ...(state.lastContextTokens !== null
        ? { contextTokens: state.lastContextTokens }
        : {}),
      ...(state.lastContextWindowMax !== null
        ? { contextWindowMax: state.lastContextWindowMax }
        : {}),
      rotateBeforeNextTurn: state.rotateBeforeNextTurn,
    },
    lastUsedAt: state.lastUsedAt,
  });

  const extras: GraphWorkflowLaneExtras = {
    lane: state.lane,
    contextId: state.contextId,
    ...(state.workflowConversationId !== undefined
      ? { workflowConversationId: state.workflowConversationId }
      : {}),
    limitEvaluation: state.limitEvaluation,
  };

  logger.debug("graph-lane.adapter.toPrimitive", {
    executionId: ctx.executionId,
    lane: state.lane,
    backend: "claude",
    contextId: state.contextId,
  });

  return { primitive, extras };
}

function projectCodex(
  state: Extract<GraphWorkflowAgentSessionState, { engine: "codex" }>,
  ctx: GraphWorkflowLaneAdapterInputContext,
): GraphWorkflowLanePrimitiveProjection {
  if (state.sessionRef !== undefined && state.sessionRef.engine !== "codex") {
    throw new Error(
      "graph-lane adapter: Codex lane sessionRef must be engine=codex when present",
    );
  }
  const sessionRefThreadId =
    state.sessionRef?.engine === "codex"
      ? state.sessionRef.threadId
      : undefined;
  const primitive = laneStateSchema.parse({
    workflowId: ctx.executionId,
    laneId: state.lane,
    backend: "codex",
    writeCapability: inferWriteCapability(state.lane),
    policy: ctx.policy,
    backendState: {
      backend: "codex",
      ...(sessionRefThreadId !== undefined
        ? { threadId: sessionRefThreadId }
        : {}),
    },
    metrics: {
      backend: "codex",
      lastTurnUsage: state.lastTurnUsage,
      rotateBeforeNextTurn: state.rotateBeforeNextTurn,
    },
    lastUsedAt: state.lastUsedAt,
  });

  const extras: GraphWorkflowLaneExtras = {
    lane: state.lane,
    contextId: state.contextId,
    ...(state.workflowConversationId !== undefined
      ? { workflowConversationId: state.workflowConversationId }
      : {}),
    limitEvaluation: state.limitEvaluation,
  };

  logger.debug("graph-lane.adapter.toPrimitive", {
    executionId: ctx.executionId,
    lane: state.lane,
    backend: "codex",
    contextId: state.contextId,
  });

  return { primitive, extras };
}

function reconstructClaude(
  primitive: LaneState,
  extras: GraphWorkflowLaneExtras,
): GraphWorkflowAgentSessionState {
  if (primitive.backendState.backend !== "claude") {
    throw new Error(
      "graph-lane adapter: primitive backendState branch is not Claude",
    );
  }
  if (primitive.metrics.backend !== "claude") {
    throw new Error(
      "graph-lane adapter: primitive metrics branch is not Claude",
    );
  }
  const conversationId = primitive.backendState.conversationId;
  if (conversationId === undefined) {
    throw new Error(
      "graph-lane adapter: graph workflow Claude lane requires a conversationId on the primitive backendState",
    );
  }
  if (extras.limitEvaluation === "unsupported") {
    throw new Error(
      "graph-lane adapter: a Claude lane cannot carry limitEvaluation=unsupported (graph schema only allows disabled|supported)",
    );
  }
  const limitEvaluation: "disabled" | "supported" = extras.limitEvaluation;

  return graphWorkflowAgentSessionStateSchema.parse({
    engine: "claude",
    lane: extras.lane,
    contextId: extras.contextId,
    ...(extras.workflowConversationId !== undefined
      ? { workflowConversationId: extras.workflowConversationId }
      : {}),
    sessionRef: {
      engine: "claude",
      lane: extras.lane,
      conversationId,
    },
    lastContextTokens: primitive.metrics.contextTokens ?? null,
    lastContextWindowMax: primitive.metrics.contextWindowMax ?? null,
    rotateBeforeNextTurn: primitive.metrics.rotateBeforeNextTurn,
    limitEvaluation,
    lastUsedAt: primitive.lastUsedAt,
  });
}

function reconstructCodex(
  primitive: LaneState,
  extras: GraphWorkflowLaneExtras,
): GraphWorkflowAgentSessionState {
  if (primitive.backendState.backend !== "codex") {
    throw new Error(
      "graph-lane adapter: primitive backendState branch is not Codex",
    );
  }
  if (primitive.metrics.backend !== "codex") {
    throw new Error(
      "graph-lane adapter: primitive metrics branch is not Codex",
    );
  }
  if (extras.limitEvaluation === "supported") {
    throw new Error(
      "graph-lane adapter: a Codex lane cannot carry limitEvaluation=supported (graph schema only allows disabled|unsupported)",
    );
  }
  const limitEvaluation: "disabled" | "unsupported" = extras.limitEvaluation;

  const sessionRef =
    primitive.backendState.threadId !== undefined
      ? {
          engine: "codex" as const,
          lane: extras.lane,
          threadId: primitive.backendState.threadId,
        }
      : undefined;

  return graphWorkflowAgentSessionStateSchema.parse({
    engine: "codex",
    lane: extras.lane,
    contextId: extras.contextId,
    ...(extras.workflowConversationId !== undefined
      ? { workflowConversationId: extras.workflowConversationId }
      : {}),
    ...(sessionRef !== undefined ? { sessionRef } : {}),
    lastTurnUsage: primitive.metrics.lastTurnUsage ?? null,
    rotateBeforeNextTurn: primitive.metrics.rotateBeforeNextTurn,
    limitEvaluation,
    lastUsedAt: primitive.lastUsedAt,
  });
}
