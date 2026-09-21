import { unchanged } from "@/lib/workflow-graph/execution-mutation";
import { changed } from "@/lib/workflow-graph/execution-mutation";
import type { GraphWorkflowExecutionRepository } from "./execution-repository";
/** Durable CC conversations for graph workflow lanes. */

import { createLogger } from "@/lib/logging";
import type { AgentProfileSnapshot } from "@/lib/agent-profiles/schemas";
import {
  laneStateKey,
  type LaneIdentity,
} from "@/lib/workflow-graph/lane-identity";
import {
  DEFAULT_AGENT_BACKEND_ID,
  type AgentBackendId,
  type AgentSessionRef,
} from "@/lib/shared/schemas";
import {
  toGraphLaneState,
  toNeutralLaneState,
} from "@/lib/workflow-graph/graph-lane-store";
import {
  deriveLaneOutcome,
  type LaneOutcome,
  type LaneService,
} from "@/lib/workflows/primitives/lane-service";
import {
  graphWorkflowAgentSessionStateSchema,
  type GraphWorkflowAgentSessionState,
  type GraphWorkflowExecution,
  type GraphWorkflowLaneKind,
} from "@/lib/workflow-graph/schemas";

const logger = createLogger("workflow-graph.lane-continuity");

// ============================================================
// Dependency Injection
// ============================================================

export type GraphLaneContinuityExecutionRepository = Pick<
  GraphWorkflowExecutionRepository,
  "mutateActive"
>;

export interface GraphLaneContinuityDeps {
  /**
   * Shared workflow-primitive lane service; production backs it with the
   * durable `GraphLaneStore` so lane continuity state lives on the execution
   * row and survives restarts.
   */
  laneService: LaneService;
  /**
   * Persists post-turn metrics onto the execution row after a turn is recorded.
   * Production uses the fenced execution repository.
   */
  executionRepository: GraphLaneContinuityExecutionRepository;
  /** Creates a role-stamped CC lane conversation (the lane dispatch anchor). */
  createConversation(
    projectPath: string,
    sessionName: string,
    opts: {
      role: "iteration" | "validator";
      agentBackend?: AgentBackendId;
      /**
       * The calling assignment's execution-seeded snapshot, handed over rather
       * than re-resolved (R4). Absent only when the caller has no seeded
       * assignment to hand over, in which case the conversation service applies
       * its own default.
       */
      profileSnapshot?: AgentProfileSnapshot;
    },
  ): Promise<{ id: string }>;
  /** Existence check for a lane's CC conversation on the reuse path. */
  getConversation(
    projectPath: string,
    sessionName: string,
    conversationId: string,
  ): Promise<{
    id: string;
    promptCount: number;
    backendRef: AgentSessionRef | null;
  } | null>;
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

export interface EnsuredValidatorConversation {
  execution: GraphWorkflowExecution;
  sessionAction: "reuse" | "create";
  backend: AgentBackendId;
  conversationId: string;
}

// ============================================================
// Input types
// ============================================================

export interface ResolveImplementerCallInput {
  execution: GraphWorkflowExecution;
  projectPath: string;
  sessionName: string;
  contextId: string;
  backend?: AgentBackendId;
  /** Frozen assignment identity, checked before reusing the lane. */
  assignmentFingerprint?: string;
  /**
   * The context implementer's execution-seeded snapshot. Handed to every lane
   * conversation this call creates so the lane runs the seeded bytes rather
   * than whatever the library holds now (R4).
   */
  profileSnapshot?: AgentProfileSnapshot;
}

export interface EnsureValidatorConversationInput {
  execution: GraphWorkflowExecution;
  projectPath: string;
  sessionName: string;
  contextId: string;
  lane: "context_validator";
  /**
   * Which cohort member is calling. Every lane concern — continuity handle,
   * conversation anchor and artifacts — is keyed by it, so two
   * assignments of one profile reviewing one context never share state.
   */
  assignmentId: string;
  /** Frozen assignment identity, checked before reusing the lane. */
  assignmentFingerprint?: string;
  backend: AgentBackendId;
  /**
   * The calling assignment's execution-seeded snapshot. The validator lane
   * persists it so the lane's record names the profile the assignment actually
   * runs under. The actor injects this stored block when it opens the runtime.
   */
  profileSnapshot?: AgentProfileSnapshot;
}

export interface RecordLaneTurnOutcomeInput {
  execution: GraphWorkflowExecution;
  projectPath: string;
  sessionName: string;
  contextId: string;
  lane: GraphWorkflowLaneKind;
  /** Required for assignment-scoped lanes; absent for the implementer. */
  assignmentId?: string;
  /**
   * Neutral post-turn outcome, recorded through the shared lane service. A
   * lane's continuity handle is its CC conversation id, which a turn never
   * advances, so `ref` is ignored here: the backend-native continuation lives
   * on the conversation row, owned by the conversation actor.
   */
  outcome: LaneOutcome;
}

// ============================================================
// Internal helpers
// ============================================================

function withLaneState(
  execution: GraphWorkflowExecution,
  contextId: string,
  identity: LaneIdentity,
  state: GraphWorkflowAgentSessionState,
): GraphWorkflowExecution {
  const previousContextLanes = execution.laneStates[contextId] ?? {};
  return {
    ...execution,
    laneStates: {
      ...execution.laneStates,
      [contextId]: {
        ...previousContextLanes,
        [laneStateKey(identity.lane, identity.assignmentId ?? undefined)]:
          state,
      },
    },
  };
}

function getCurrentLane(
  execution: GraphWorkflowExecution,
  contextId: string,
  identity: LaneIdentity,
): GraphWorkflowAgentSessionState | undefined {
  const stored =
    execution.laneStates[contextId]?.[
      laneStateKey(identity.lane, identity.assignmentId ?? undefined)
    ];
  if (!stored) return undefined;
  return graphWorkflowAgentSessionStateSchema.parse(stored);
}

/** Existing lane identities are immutable, including on recovery. */
function requireReusableLane(
  state: GraphWorkflowAgentSessionState,
  contextId: string,
  backend: AgentBackendId,
  fingerprint?: string,
): void {
  if (
    state.contextId !== contextId ||
    state.backend !== backend ||
    (state.lane === "implementer" && state.staleSession) ||
    (fingerprint !== undefined &&
      state.assignmentFingerprint !== undefined &&
      state.assignmentFingerprint !== fingerprint)
  ) {
    throw new Error(
      `Cannot continue ${state.lane} conversation in context "${contextId}": its saved identity is no longer usable.`,
    );
  }
}

export function createGraphLaneContinuity(deps: GraphLaneContinuityDeps) {
  const getNow = () => deps.now?.() ?? new Date().toISOString();

  async function initialize(
    execution: GraphWorkflowExecution,
    state: GraphWorkflowAgentSessionState,
    identity: LaneIdentity,
    contextId: string,
  ): Promise<GraphWorkflowExecution> {
    await deps.laneService.initialize(
      toNeutralLaneState(execution, state, identity, contextId),
    );
    logger.info("workflow-continuity.lane.create", {
      contextId,
      lane: identity.lane,
      assignmentId: identity.assignmentId,
      engine: state.backend,
      conversationId: state.workflowConversationId,
    });
    return withLaneState(execution, contextId, identity, state);
  }

  async function resolveConversation(
    input: ResolveImplementerCallInput | EnsureValidatorConversationInput,
    identity: LaneIdentity,
    backend: AgentBackendId,
  ): Promise<{
    execution: GraphWorkflowExecution;
    conversationId: string;
    sessionAction: "create" | "reuse";
  }> {
    const { execution, contextId, projectPath, sessionName } = input;
    const existing = getCurrentLane(execution, contextId, identity);
    if (existing) {
      requireReusableLane(
        existing,
        contextId,
        backend,
        input.assignmentFingerprint,
      );
      const conversationId = existing.workflowConversationId;
      const conversation = await deps.getConversation(
        projectPath,
        sessionName,
        conversationId,
      );
      if (!conversation) {
        throw new Error(
          `Cannot continue ${identity.lane} conversation in context "${contextId}": saved conversation is missing.`,
        );
      }
      if (
        identity.lane === "implementer" &&
        conversation.promptCount > 0 &&
        conversation.backendRef === null
      ) {
        throw new Error(
          `Cannot continue ${identity.lane} conversation in context "${contextId}": its backend continuation was lost.`,
        );
      }
      logger.info("workflow-continuity.lane.reuse", {
        contextId,
        lane: identity.lane,
        assignmentId: identity.assignmentId,
        engine: backend,
        conversationId,
      });
      return {
        execution: withLaneState(execution, contextId, identity, {
          ...existing,
          lastUsedAt: getNow(),
        }),
        conversationId,
        sessionAction: "reuse",
      };
    }
    const conversation = await deps.createConversation(
      projectPath,
      sessionName,
      {
        role: identity.lane === "implementer" ? "iteration" : "validator",
        agentBackend: backend,
        ...(input.profileSnapshot !== undefined
          ? { profileSnapshot: input.profileSnapshot }
          : {}),
      },
    );
    const state = graphWorkflowAgentSessionStateSchema.parse({
      backend,
      lane: identity.lane,
      contextId,
      ...(identity.assignmentId !== null
        ? { assignmentId: identity.assignmentId }
        : {}),
      ...(input.assignmentFingerprint !== undefined
        ? { assignmentFingerprint: input.assignmentFingerprint }
        : {}),
      workflowConversationId: conversation.id,
      metrics: {},
      lastUsedAt: getNow(),
    });
    return {
      execution: await initialize(execution, state, identity, contextId),
      conversationId: conversation.id,
      sessionAction: "create",
    };
  }

  async function resolveImplementerCall(
    input: ResolveImplementerCallInput,
  ): Promise<ResolvedImplementerCall> {
    const resolved = await resolveConversation(
      input,
      { lane: "implementer", assignmentId: null },
      input.backend ?? DEFAULT_AGENT_BACKEND_ID,
    );
    return {
      ...resolved,
      promptMode:
        resolved.sessionAction === "create" ? "iteration_seed" : "follow_up",
    };
  }

  async function ensureValidatorConversation(
    input: EnsureValidatorConversationInput,
  ): Promise<EnsuredValidatorConversation> {
    const { lane, backend } = input;
    const identity: LaneIdentity = { lane, assignmentId: input.assignmentId };
    return {
      ...(await resolveConversation(input, identity, backend)),
      backend,
    };
  }

  async function recordLaneTurnOutcome(
    input: RecordLaneTurnOutcomeInput,
  ): Promise<GraphWorkflowExecution> {
    const { execution, projectPath, sessionName, contextId, lane } = input;
    const identity: LaneIdentity = {
      lane,
      assignmentId: input.assignmentId ?? null,
    };
    const laneKey = laneStateKey(lane, input.assignmentId);
    const laneState = getCurrentLane(execution, contextId, identity);
    if (!laneState || laneState.backend !== input.outcome.backend)
      return execution;
    // The CC conversation id is the handle, and the conversation actor owns
    // the backend-native continuation; a post-turn ref never moves the lane.
    const { ref: _ignoredRef, ...outcome } = input.outcome;
    const mutation = await deps.executionRepository.mutateActive(
      projectPath,
      sessionName,
      (latest) => {
        const existing = latest.laneStates[contextId]?.[laneKey];
        if (!existing) return unchanged();
        const { state } = deriveLaneOutcome(
          toNeutralLaneState(latest, existing, identity, contextId),
          outcome,
          getNow(),
        );
        return changed(
          withLaneState(
            latest,
            contextId,
            identity,
            toGraphLaneState(state, identity, contextId, existing),
          ),
        );
      },
    );
    return mutation.execution;
  }

  return {
    resolveImplementerCall,
    ensureValidatorConversation,
    recordLaneTurnOutcome,
  };
}

export type GraphLaneContinuity = ReturnType<typeof createGraphLaneContinuity>;
