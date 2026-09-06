/**
 * Graph lane continuity (plan §3.2.3): the single continuity door for graph
 * implementer/validator lanes, composed from the shared workflow-primitive
 * stack — `LaneService` over the durable `GraphLaneStore` for lane state, and
 * the owning backend's `BackendContinuityAdapter` (resolved through the
 * registry, exactly as `WorkflowAgentCaller` resolves it) for backend-native
 * handle lifecycle. Backend identity never appears on the surface: callers
 * resolve a lane call and record a neutral `LaneOutcome`; handle semantics
 * live in the adapters.
 *
 * Graph-owned concerns that are NOT backend continuity stay here:
 *  - CC lane conversations (role-stamped via `createConversation`) anchor
 *    every implementer lane and the conversation-holding validator lane; the
 *    conversation actor owns the backend session underneath, so the lane's
 *    conversation is the durable dispatch anchor.
 *  - rotation policy (context-window rotation, continuity toggles, resume
 *    pins) and the rotation handoff note.
 *  - retiring a replaced lane conversation's actor so a rotation does not
 *    leak the retired subprocess.
 */

import { createLogger } from "@/lib/logging";
import type { AgentProfileSnapshot } from "@/lib/agent-profiles/schemas";
import {
  laneStateKey,
  type LaneIdentity,
} from "@/lib/workflow-graph/lane-identity";
import { getErrorMessage } from "@/lib/shared/errors";
import { getExecutionLogger } from "@/lib/workflow-graph/execution-logger";
import type {
  BackendContinuityAdapter,
  ContinuityResumption,
} from "@/lib/agent-backends/continuity";
import {
  DEFAULT_AGENT_BACKEND_ID,
  type AgentBackendId,
  type AgentSessionRef,
} from "@/lib/shared/schemas";
import {
  toGraphLaneState,
  toNeutralLaneState,
} from "@/lib/workflow-graph/graph-lane-store";
import { descriptorContinuityAdapter } from "@/lib/workflows/primitives/workflow-agent-caller";
import {
  deriveLaneOutcome,
  type LaneOutcome,
  type LaneService,
} from "@/lib/workflows/primitives/lane-service";
import type { ContextLimitEvaluation } from "@/lib/workflows/primitives/context-limit-gate";
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

export interface GraphLaneContinuityExecutionRepository {
  mutateActive(
    projectPath: string,
    sessionName: string,
    fn: (execution: GraphWorkflowExecution) => GraphWorkflowExecution,
  ): Promise<GraphWorkflowExecution>;
}

export interface GraphLaneContinuityDeps {
  /**
   * Shared workflow-primitive lane service; production backs it with the
   * durable `GraphLaneStore` so lane continuity state lives on the execution
   * row and survives restarts.
   */
  laneService: LaneService;
  /**
   * Persists the graph-only lane extras (`limitEvaluation`) and mirrors the
   * post-outcome lane state onto the execution row after a turn is recorded.
   * Production threads the workflow manager's `mutateActive`.
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
  ): Promise<{ id: string } | null>;
  /**
   * Resolves the continuity adapter owning a backend's native handles.
   * Defaults to the registered descriptor's `conversation.continuity` — the
   * same resolution `WorkflowAgentCaller` uses.
   */
  continuityAdapter?(backend: AgentBackendId): BackendContinuityAdapter;
  /**
   * Read the retiring conversation's final handoff message when a
   * context-window rotation replaces it. The note is injected verbatim into
   * the fresh conversation's seed prompt so environment gotchas and in-flight
   * state cross the rotation boundary. Best-effort: absent dep, null return,
   * or a throw all resolve to "no handoff".
   */
  loadRotationHandoff?(conversationId: string): Promise<string | null>;
  /**
   * Stop the replaced conversation-anchored lane's actor (and with it the
   * backend subprocess) when a same-context rotation creates its successor.
   * Without this, a retired lane's subprocess lives on until the
   * workflow-lane idle TTL fires — up to an hour of leaked subprocess per
   * rotation. Best-effort: a throw is logged and never fails the rotation.
   */
  retireLaneConversation?(input: {
    projectPath: string;
    sessionName: string;
    conversationId: string;
  }): void;
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
  /**
   * Present only on a context-limit rotation: the retiring conversation's
   * final handoff message, for verbatim injection into the seed prompt.
   */
  previousConversationHandoff?: {
    conversationId: string;
    note: string;
  };
}

export type ValidatorExecutionStrategy = "conversation" | "task";

export type ResolvedValidatorCall =
  | {
      execution: GraphWorkflowExecution;
      sessionAction: "reuse" | "create";
      strategy: "conversation";
      backend: AgentBackendId;
      conversationId: string;
    }
  | {
      execution: GraphWorkflowExecution;
      sessionAction: "reuse" | "create";
      strategy: "task";
      backend: AgentBackendId;
      backendRef: AgentSessionRef;
    };

// ============================================================
// Input types
// ============================================================

export interface ResolveImplementerCallInput {
  execution: GraphWorkflowExecution;
  projectPath: string;
  sessionName: string;
  contextId: string;
  backend?: AgentBackendId;
  /**
   * Resume pin: when set and it matches the lane's `workflowConversationId`,
   * the asking conversation is reused even with continuity configured off.
   * Context-window rotation (`rotateBeforeNextTurn`) still outranks the pin.
   */
  pinnedConversationId?: string;
  /**
   * The implementer assignment's fingerprint (see `assignmentFingerprint`).
   * Stamped on creation and compared on reuse, exactly as for a validator
   * assignment: an implementer swapped, refocused, or re-pointed at a new
   * profile revision under a running execution gets a fresh conversation
   * rather than one that already replayed the superseded profile block.
   * Absent means the caller cannot fingerprint, which never rotates a lane.
   */
  assignmentFingerprint?: string;
  /**
   * The context implementer's execution-seeded snapshot. Handed to every lane
   * conversation this call creates so the lane runs the seeded bytes rather
   * than whatever the library holds now (R4).
   */
  profileSnapshot?: AgentProfileSnapshot;
}

export interface ResolveValidatorCallInput {
  execution: GraphWorkflowExecution;
  projectPath: string;
  sessionName: string;
  contextId: string;
  lane: "context_validator";
  /**
   * Which cohort member is calling. Every lane concern — continuity handle,
   * conversation anchor, rotation, artifacts — is keyed by it, so two
   * assignments of one profile reviewing one context never share state.
   */
  assignmentId: string;
  /**
   * The calling assignment's fingerprint (see `assignmentFingerprint`).
   * Stamped onto the lane on creation and compared on reuse: an assignment
   * edited under a running execution gets a fresh lane rather than a resumed
   * handle still carrying the superseded instructions. Optional because a
   * caller that cannot fingerprint simply forgoes that rotation trigger — an
   * absent fingerprint never rotates a lane.
   */
  assignmentFingerprint?: string;
  backend: AgentBackendId;
  strategy: ValidatorExecutionStrategy;
  /**
   * Resume pin: when set and it matches the lane's `workflowConversationId`,
   * the asking conversation is reused even with continuity configured off.
   * Context-window rotation (`rotateBeforeNextTurn`) still outranks the pin.
   */
  pinnedConversationId?: string;
  /**
   * The calling assignment's execution-seeded snapshot. A conversation-strategy
   * validator lane persists it so the lane's record names the profile the
   * assignment actually runs under; the block itself reaches a validator turn
   * through the per-turn instruction channel, not this record (D9).
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
   * Neutral post-turn outcome, recorded through the shared lane service.
   * `ref` is honored only for lanes whose continuity handle is backend-native;
   * a conversation-anchored lane's handle is its CC conversation id, which a
   * turn never advances.
   */
  outcome: LaneOutcome;
}

// ============================================================
// Internal helpers
// ============================================================

/**
 * Maps the primitive-layer `ContextLimitEvaluation` taxonomy onto the coarser
 * `limitEvaluation` value the graph schema persists. The graph state only
 * records whether occupancy metrics were reported, so both occupancy verdicts
 * (`no_rotation` / `rotation_required`) collapse to `supported`; `disabled`,
 * `unsupported`, and `metrics_unavailable` pass through unchanged.
 */
export function toGraphLimitEvaluation(
  evaluation: ContextLimitEvaluation,
): "disabled" | "supported" | "unsupported" | "metrics_unavailable" {
  switch (evaluation) {
    case "disabled":
      return "disabled";
    case "unsupported":
      return "unsupported";
    case "metrics_unavailable":
      return "metrics_unavailable";
    case "no_rotation":
      return "supported";
    case "rotation_required":
      return "supported";
  }
}

/**
 * True when a resume pin should force reuse of this lane conversation. The pin
 * matches the backend-neutral `workflowConversationId`, so every lane pins
 * identically regardless of the native continuity-ref shape.
 */
function laneMatchesPin(
  laneState: GraphWorkflowAgentSessionState | undefined,
  pinnedConversationId: string | undefined,
): boolean {
  return (
    pinnedConversationId !== undefined &&
    laneState?.workflowConversationId === pinnedConversationId
  );
}

/**
 * Returns true when the lane should start a fresh session instead of reusing.
 *
 * A resume pin forces reuse even when continuity is configured off, but never
 * overrides `rotateBeforeNextTurn` (context-window rotation) or a structural
 * mismatch (missing lane, changed context, changed backend).
 */
function shouldRotate(
  laneState: GraphWorkflowAgentSessionState | undefined,
  contextId: string,
  continuityEnabled: boolean,
  backend?: AgentBackendId,
  pinnedConversationId?: string,
  assignmentFingerprint?: string,
): boolean {
  if (!laneState) return true;
  if (laneState.contextId !== contextId) return true;
  if (!continuityEnabled && !laneMatchesPin(laneState, pinnedConversationId))
    return true;
  if (laneState.metrics.rotateBeforeNextTurn) return true;
  if (backend !== undefined && laneState.backend !== backend) return true;
  if (assignmentChanged(laneState, assignmentFingerprint)) return true;
  return false;
}

/**
 * True only when BOTH fingerprints are known and differ. A lane that predates
 * fingerprinting has nothing to compare against, and rotating it on that basis
 * would discard live continuity to learn nothing — it acquires a fingerprint at
 * its next natural rotation instead.
 */
function assignmentChanged(
  laneState: GraphWorkflowAgentSessionState,
  assignmentFingerprint: string | undefined,
): boolean {
  return (
    assignmentFingerprint !== undefined &&
    laneState.assignmentFingerprint !== undefined &&
    laneState.assignmentFingerprint !== assignmentFingerprint
  );
}

function getLaneContinuityEnabled(
  execution: GraphWorkflowExecution,
  contextId: string,
  identity: LaneIdentity,
): boolean {
  const ctx = execution.workingDefinition.executionContexts.find(
    (c) => c.id === contextId,
  );
  if (!ctx) return true;
  if (identity.lane === "implementer") {
    return ctx.iterationPolicy.continuity.enabled ?? true;
  }
  return (
    ctx.contextValidator.assignments.find(
      (assignment) => assignment.id === identity.assignmentId,
    )?.continuity.enabled ?? true
  );
}

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

function rotationReason(
  laneState: GraphWorkflowAgentSessionState | undefined,
  contextId: string,
  continuityEnabled: boolean,
  pinned: boolean,
  backend: AgentBackendId,
  assignmentFingerprint?: string,
): string {
  if (!laneState) return "no_prior_lane";
  if (laneState.contextId !== contextId) return "context_changed";
  if (!continuityEnabled && !pinned) return "continuity_disabled";
  if (laneState.backend !== backend) return "engine_changed";
  if (assignmentChanged(laneState, assignmentFingerprint))
    return "assignment_changed";
  return "rotation_scheduled";
}

/**
 * The lane's independent CC dispatch anchor. Legacy lane states acquire this
 * field while being normalized by the persisted lane schema.
 */
function laneConversationId(
  laneState: GraphWorkflowAgentSessionState,
): string | null {
  return laneState.workflowConversationId ?? null;
}

// ============================================================
// Service factory
// ============================================================

export function createGraphLaneContinuity(deps: GraphLaneContinuityDeps) {
  const getNow = () => deps.now?.() ?? new Date().toISOString();
  const resolveAdapter = deps.continuityAdapter
    ? (backend: AgentBackendId) => deps.continuityAdapter!(backend)
    : descriptorContinuityAdapter;

  async function persistLaneState(
    execution: GraphWorkflowExecution,
    laneState: GraphWorkflowAgentSessionState,
    identity: LaneIdentity,
    contextId: string,
  ): Promise<void> {
    await deps.laneService.initialize(
      toNeutralLaneState(execution, laneState, identity, contextId),
    );
  }

  /**
   * The assignment identity a freshly created lane records about itself, so a
   * later resolve can tell "same assignment, resume" from "this assignment was
   * edited, rebuild".
   */
  function assignmentFields(
    identity: LaneIdentity,
    assignmentFingerprint: string | undefined,
  ): Record<string, string> {
    return {
      ...(identity.assignmentId !== null
        ? { assignmentId: identity.assignmentId }
        : {}),
      ...(assignmentFingerprint !== undefined ? { assignmentFingerprint } : {}),
    };
  }

  async function createFreshConversationLane(
    execution: GraphWorkflowExecution,
    projectPath: string,
    sessionName: string,
    identity: LaneIdentity,
    contextId: string,
    backend: AgentBackendId,
    role: "iteration" | "validator",
    reason: string,
    assignmentFingerprint?: string,
    profileSnapshot?: AgentProfileSnapshot,
  ): Promise<{
    laneState: GraphWorkflowAgentSessionState;
    conversationId: string;
  }> {
    // Pre-resolved handoff, never a reference (R4): a lane created long after
    // execution start — or after a rotation — must run the bytes the execution
    // was seeded with, so the library is not consulted on this path at all.
    const conversation = await deps.createConversation(
      projectPath,
      sessionName,
      {
        role,
        agentBackend: backend,
        ...(profileSnapshot !== undefined ? { profileSnapshot } : {}),
      },
    );
    const laneState = graphWorkflowAgentSessionStateSchema.parse({
      backend,
      refKind: "conversation",
      lane: identity.lane,
      contextId,
      ...assignmentFields(identity, assignmentFingerprint),
      workflowConversationId: conversation.id,
      sessionRef: { backend, ref: conversation.id },
      metrics: { rotateBeforeNextTurn: false },
      limitEvaluation: "disabled",
      lastUsedAt: getNow(),
    });

    await persistLaneState(execution, laneState, identity, contextId);

    logger.info("workflow-continuity.lane.create", {
      lane: identity.lane,
      assignmentId: identity.assignmentId,
      engine: backend,
      contextId,
      conversationId: conversation.id,
      reason,
    });

    return { laneState, conversationId: conversation.id };
  }

  /**
   * Best-effort read of the retiring conversation's final handoff. Only a
   * same-context `rotation_scheduled` replacement qualifies — a first lane has
   * nothing to hand off, and a lane inherited from another context or backend
   * would hand off foreign state.
   */
  async function loadHandoffForRotation(
    laneState: GraphWorkflowAgentSessionState | null | undefined,
    reason: string,
  ): Promise<{ conversationId: string; note: string } | undefined> {
    if (
      reason !== "rotation_scheduled" ||
      !laneState ||
      !deps.loadRotationHandoff
    ) {
      return undefined;
    }
    const previousConversationId = laneConversationId(laneState);
    if (!previousConversationId) {
      return undefined;
    }
    try {
      const note = await deps.loadRotationHandoff(previousConversationId);
      if (!note || note.trim().length === 0) {
        return undefined;
      }
      logger.info("workflow-continuity.rotation_handoff.loaded", {
        conversationId: previousConversationId,
        noteLength: note.length,
      });
      return { conversationId: previousConversationId, note };
    } catch (error) {
      logger.warn("workflow-continuity.rotation_handoff.load_failed", {
        conversationId: previousConversationId,
        error: getErrorMessage(error),
      });
      return undefined;
    }
  }

  /**
   * Stop the conversation a same-context rotation just replaced.
   * Conversation-anchored lanes only — the leaked resource is the live
   * actor's backend subprocess, which a headless lane does not hold.
   * Called after the fresh lane exists so a failed replacement never strands
   * the context laneless, and after the rotation handoff has been read from
   * the retiring transcript.
   */
  function retireReplacedLaneConversation(
    laneState: GraphWorkflowAgentSessionState | null | undefined,
    contextId: string,
    projectPath: string,
    sessionName: string,
  ): void {
    if (!deps.retireLaneConversation || !laneState) return;
    if (laneState.contextId !== contextId) return;
    if (laneState.refKind !== "conversation") return;
    const conversationId = laneConversationId(laneState);
    if (!conversationId) return;
    try {
      deps.retireLaneConversation({ projectPath, sessionName, conversationId });
      logger.info("workflow-continuity.lane.retired", {
        contextId,
        conversationId,
      });
    } catch (error) {
      logger.warn("workflow-continuity.lane.retire_failed", {
        contextId,
        conversationId,
        error: getErrorMessage(error),
      });
    }
  }

  async function resolveImplementerCall(
    input: ResolveImplementerCallInput,
  ): Promise<ResolvedImplementerCall> {
    const { execution, projectPath, sessionName, contextId } = input;
    const backend = input.backend ?? DEFAULT_AGENT_BACKEND_ID;
    const lane: GraphWorkflowLaneKind = "implementer";
    const identity: LaneIdentity = { lane, assignmentId: null };
    const laneState = getCurrentLane(execution, contextId, identity);
    const continuityEnabled = getLaneContinuityEnabled(
      execution,
      contextId,
      identity,
    );
    const pinned = laneMatchesPin(laneState, input.pinnedConversationId);
    const rotate = shouldRotate(
      laneState,
      contextId,
      continuityEnabled,
      backend,
      input.pinnedConversationId,
      input.assignmentFingerprint,
    );

    if (rotate) {
      const reason = rotationReason(
        laneState,
        contextId,
        continuityEnabled,
        pinned,
        backend,
        input.assignmentFingerprint,
      );

      const execLogger = getExecutionLogger(execution.id);
      execLogger?.decision("implementer.rotation", {
        contextId,
        engine: backend,
        reason,
        continuityEnabled,
        previousContextId: laneState?.contextId ?? null,
        previousEngine: laneState?.backend ?? null,
      });

      if (reason === "context_changed" && laneState) {
        logger.warn("workflow-continuity.stale_session.reset", {
          lane,
          engine: backend,
          contextId,
          staleContextId: laneState.contextId,
        });
      }

      const previousConversationHandoff = await loadHandoffForRotation(
        laneState,
        reason,
      );

      const { laneState: newLaneState, conversationId } =
        await createFreshConversationLane(
          execution,
          projectPath,
          sessionName,
          identity,
          contextId,
          backend,
          "iteration",
          reason,
          input.assignmentFingerprint,
          input.profileSnapshot,
        );

      retireReplacedLaneConversation(
        laneState,
        contextId,
        projectPath,
        sessionName,
      );

      return {
        execution: withLaneState(execution, contextId, identity, newLaneState),
        conversationId,
        sessionAction: "create",
        promptMode: "iteration_seed",
        ...(previousConversationHandoff ? { previousConversationHandoff } : {}),
      };
    }

    // Reuse path — the lane's CC conversation must still exist.
    const existingLane = laneState!;
    const conversationId = laneConversationId(existingLane) ?? "";

    const existingConversation = await deps.getConversation(
      projectPath,
      sessionName,
      conversationId,
    );

    if (!existingConversation) {
      logger.warn("workflow-continuity.stale_session.recovery", {
        lane,
        engine: backend,
        contextId,
        conversationId,
        reason: "conversation_not_found",
      });

      const { laneState: newLaneState, conversationId: freshId } =
        await createFreshConversationLane(
          execution,
          projectPath,
          sessionName,
          identity,
          contextId,
          backend,
          "iteration",
          "stale_recovery",
          input.assignmentFingerprint,
          input.profileSnapshot,
        );

      return {
        execution: withLaneState(execution, contextId, identity, newLaneState),
        conversationId: freshId,
        sessionAction: "create",
        promptMode: "iteration_seed",
      };
    }

    const updatedLaneState: GraphWorkflowAgentSessionState = {
      ...existingLane,
      lastUsedAt: getNow(),
    };

    logger.info("workflow-continuity.lane.reuse", {
      lane,
      engine: backend,
      contextId,
      conversationId,
    });

    return {
      execution: withLaneState(
        execution,
        contextId,
        identity,
        updatedLaneState,
      ),
      conversationId,
      sessionAction: "reuse",
      promptMode: "follow_up",
    };
  }

  async function resolveValidatorCall(
    input: ResolveValidatorCallInput,
  ): Promise<ResolvedValidatorCall> {
    const {
      execution,
      projectPath,
      sessionName,
      contextId,
      lane,
      backend,
      strategy,
      assignmentFingerprint,
    } = input;
    const identity: LaneIdentity = {
      lane,
      assignmentId: input.assignmentId,
    };
    const laneState = getCurrentLane(execution, contextId, identity);
    const continuityEnabled = getLaneContinuityEnabled(
      execution,
      contextId,
      identity,
    );
    const pinned = laneMatchesPin(laneState, input.pinnedConversationId);
    const expectedRefKind =
      strategy === "conversation" ? "conversation" : "backend";
    const rotate =
      shouldRotate(
        laneState,
        contextId,
        continuityEnabled,
        backend,
        input.pinnedConversationId,
        assignmentFingerprint,
      ) ||
      laneState?.refKind !== expectedRefKind ||
      (expectedRefKind === "backend" && laneState?.sessionRef === undefined);

    // Validator lanes schedule rotations through the same recordLaneTurnOutcome
    // path as implementers, so without this decision their applications are
    // invisible and scheduled-vs-applied reconciliation always shows a deficit.
    if (rotate) {
      const execLogger = getExecutionLogger(execution.id);
      execLogger?.decision("validator.rotation", {
        contextId,
        lane,
        assignmentId: identity.assignmentId,
        engine: backend,
        reason: rotationReason(
          laneState,
          contextId,
          continuityEnabled,
          pinned,
          backend,
          assignmentFingerprint,
        ),
        continuityEnabled,
        previousContextId: laneState?.contextId ?? null,
        previousEngine: laneState?.backend ?? null,
      });
    }

    if (strategy === "conversation") {
      if (rotate) {
        const reason = rotationReason(
          laneState,
          contextId,
          continuityEnabled,
          pinned,
          backend,
          assignmentFingerprint,
        );

        const { laneState: newLaneState, conversationId } =
          await createFreshConversationLane(
            execution,
            projectPath,
            sessionName,
            identity,
            contextId,
            backend,
            "validator",
            reason,
            assignmentFingerprint,
            input.profileSnapshot,
          );

        retireReplacedLaneConversation(
          laneState,
          contextId,
          projectPath,
          sessionName,
        );

        return {
          execution: withLaneState(
            execution,
            contextId,
            identity,
            newLaneState,
          ),
          sessionAction: "create",
          strategy,
          backend,
          conversationId,
        };
      }

      // Reuse path — the lane's CC conversation must still exist.
      const conversationId = laneConversationId(laneState!) ?? "";

      const existingConversation = await deps.getConversation(
        projectPath,
        sessionName,
        conversationId,
      );

      if (!existingConversation) {
        logger.warn("workflow-continuity.stale_session.recovery", {
          lane,
          engine: backend,
          contextId,
          conversationId,
          reason: "conversation_not_found",
        });
        getExecutionLogger(execution.id)?.decision("validator.rotation", {
          contextId,
          lane,
          assignmentId: identity.assignmentId,
          engine: backend,
          reason: "stale_recovery",
          continuityEnabled,
          previousContextId: laneState?.contextId ?? null,
          previousEngine: laneState?.backend ?? null,
        });

        const { laneState: newLaneState, conversationId: freshId } =
          await createFreshConversationLane(
            execution,
            projectPath,
            sessionName,
            identity,
            contextId,
            backend,
            "validator",
            "stale_recovery",
            assignmentFingerprint,
            input.profileSnapshot,
          );

        return {
          execution: withLaneState(
            execution,
            contextId,
            identity,
            newLaneState,
          ),
          sessionAction: "create",
          strategy,
          backend,
          conversationId: freshId,
        };
      }

      const updatedLane: GraphWorkflowAgentSessionState = {
        ...laneState!,
        lastUsedAt: getNow(),
      };

      logger.info("workflow-continuity.lane.reuse", {
        lane,
        assignmentId: identity.assignmentId,
        engine: backend,
        contextId,
        conversationId,
      });

      return {
        execution: withLaneState(execution, contextId, identity, updatedLane),
        sessionAction: "reuse",
        strategy,
        backend,
        conversationId,
      };
    }

    // Task-strategy validator lane: the continuity handle is owned by the
    // backend's continuity adapter.
    const adapter = resolveAdapter(backend);
    const continuityContext = { projectPath, sessionName };

    async function persistFreshBackendLane(
      started: AgentSessionRef,
      reason: string,
    ): Promise<Extract<ResolvedValidatorCall, { strategy: "task" }>> {
      const newLaneState = graphWorkflowAgentSessionStateSchema.parse({
        backend,
        refKind: "backend",
        lane,
        contextId,
        ...assignmentFields(identity, assignmentFingerprint),
        sessionRef: started,
        metrics: { lastTurnUsage: null, rotateBeforeNextTurn: false },
        limitEvaluation: "disabled",
        lastUsedAt: getNow(),
      });

      await persistLaneState(execution, newLaneState, identity, contextId);

      logger.info("workflow-continuity.lane.create", {
        lane,
        assignmentId: identity.assignmentId,
        engine: backend,
        contextId,
        threadId: started.ref,
        reason,
      });

      return {
        execution: withLaneState(execution, contextId, identity, newLaneState),
        sessionAction: "create",
        strategy: "task",
        backend,
        backendRef: started,
      };
    }

    async function createFreshBackendLane(
      reason: string,
    ): Promise<Extract<ResolvedValidatorCall, { strategy: "task" }>> {
      return persistFreshBackendLane(
        await adapter.start(continuityContext),
        reason,
      );
    }

    if (rotate) {
      return createFreshBackendLane(
        rotationReason(
          laneState,
          contextId,
          continuityEnabled,
          pinned,
          backend,
          assignmentFingerprint,
        ),
      );
    }

    // Resume the existing backend handle through the adapter, with fallback
    // to a fresh handle when the persisted one is stale.
    const storedRef = laneState!.sessionRef!;

    let resumption: ContinuityResumption;
    try {
      resumption = await adapter.resumeOrRecover(storedRef, continuityContext);
    } catch (error) {
      // Stale backend reference — start a fresh handle instead of failing.
      logger.warn("workflow-continuity.stale_session.recovery", {
        lane,
        engine: backend,
        contextId,
        storedRef: storedRef.ref,
        error: getErrorMessage(error),
      });
      return createFreshBackendLane("stale_recovery");
    }

    if (resumption.recovered) {
      logger.warn("workflow-continuity.stale_session.recovery", {
        lane,
        engine: backend,
        contextId,
        storedRef: storedRef.ref,
        recoveredRef: resumption.ref.ref,
      });
      return persistFreshBackendLane(resumption.ref, "stale_recovery");
    }

    const updatedLane: GraphWorkflowAgentSessionState = {
      ...laneState!,
      lastUsedAt: getNow(),
    };

    logger.info("workflow-continuity.lane.reuse", {
      lane,
      assignmentId: identity.assignmentId,
      engine: backend,
      contextId,
      ref: resumption.ref.ref,
    });

    return {
      execution: withLaneState(execution, contextId, identity, updatedLane),
      sessionAction: "reuse",
      strategy,
      backend,
      backendRef: resumption.ref,
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
    if (!laneState || laneState.backend !== input.outcome.backend) {
      return execution;
    }

    // A conversation-anchored lane's continuity handle is its CC conversation
    // id; a turn's backend session ref never advances it. Only a
    // backend-native handle accepts a post-turn ref update.
    const { ref: outcomeRef, ...refless } = input.outcome;
    const outcome: LaneOutcome =
      laneState.refKind === "conversation" || outcomeRef === undefined
        ? refless
        : { ...refless, ref: outcomeRef };

    // Record the neutral outcome and the graph-only `limitEvaluation` in ONE
    // execution mutation. The lane service stays the single decision site
    // (`deriveLaneOutcome`), but the durable write happens once, here, inside
    // the shared critical section — so a competing same-lane mutation cannot
    // land between a separate read and a mirror-back and be silently clobbered.
    let rotationScheduled = false;
    const recorded = await deps.executionRepository.mutateActive(
      projectPath,
      sessionName,
      (latest) => {
        const existingGraphLane = latest.laneStates[contextId]?.[laneKey];
        if (!existingGraphLane) return latest;
        const existingNeutral = toNeutralLaneState(
          latest,
          existingGraphLane,
          identity,
          contextId,
        );
        const { state, contextLimitEvaluation } = deriveLaneOutcome(
          existingNeutral,
          outcome,
          getNow(),
        );
        rotationScheduled =
          state.metrics.rotateBeforeNextTurn === true &&
          existingNeutral.metrics.rotateBeforeNextTurn !== true;
        // Map the service's honest verdict onto the coarser graph label. A turn
        // without occupancy metrics on a metrics-capable backend surfaces as
        // "metrics_unavailable" rather than a fabricated "supported".
        const limitEvaluation = toGraphLimitEvaluation(contextLimitEvaluation);
        const mirrored = toGraphLaneState(
          state,
          identity,
          contextId,
          existingGraphLane,
        );
        const nextLane = graphWorkflowAgentSessionStateSchema.parse({
          ...mirrored,
          limitEvaluation,
        });
        return withLaneState(latest, contextId, identity, nextLane);
      },
    );
    if (rotationScheduled) {
      const overLimit =
        outcome.contextLimitTokens !== undefined &&
        outcome.contextTokens !== undefined &&
        outcome.contextTokens > outcome.contextLimitTokens;
      const reason: "context_over_limit" | "compaction_detected" = overLimit
        ? "context_over_limit"
        : "compaction_detected";

      logger.info("workflow-continuity.rotation.scheduled", {
        lane,
        contextTokens: outcome.contextTokens ?? null,
        limit: outcome.contextLimitTokens,
        reason,
      });

      const execLogger = getExecutionLogger(execution.id);
      execLogger?.decision("rotation.scheduled", {
        lane,
        engine: laneState.backend,
        contextId,
        contextTokens: outcome.contextTokens ?? null,
        contextWindowMax: outcome.contextWindowMax ?? null,
        contextLimitTokens: outcome.contextLimitTokens,
        reason,
        utilization:
          outcome.contextWindowMax !== undefined &&
          outcome.contextTokens !== undefined
            ? Math.round(
                (outcome.contextTokens / outcome.contextWindowMax) * 100,
              )
            : null,
      });
    }
    return recorded;
  }

  return {
    resolveImplementerCall,
    resolveValidatorCall,
    recordLaneTurnOutcome,
  };
}

export type GraphLaneContinuity = ReturnType<typeof createGraphLaneContinuity>;
