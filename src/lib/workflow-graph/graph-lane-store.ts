/**
 * Durable graph-workflow lane store (plan §3.2.3).
 *
 * Implements the workflow-primitive `LaneStore` interface directly over the
 * execution repository: lane continuity state lives in
 * `execution.laneStates[contextId][laneKey]` and every read/write goes
 * through the persisted execution row in place. This is what makes lane
 * state (backend continuity handles, rotation flags, usage metrics) survive
 * a process restart — the design fix for the restart-losing in-memory
 * projections (bug §1.9.4).
 *
 * The store owns the mapping between the neutral primitive `LaneState` and
 * the persisted graph lane shape:
 *  - the primitive `laneId` encodes `(laneKind, contextId, assignment)` via
 *    `graphLaneId()`, because parallel contexts must never collide and each
 *    validator assignment reviewing one context holds its own durable lane;
 *  - the continuity handle maps to the graph's backend-neutral `sessionRef`,
 *    while `workflowConversationId` independently carries the optional CC
 *    dispatch anchor;
 *  - lane policy and write capability are derived from the working
 *    definition (they are configuration, not runtime state);
 *  - graph-only fields the primitive layer does not model
 *    (`workflowConversationId`, `limitEvaluation`) are preserved in place on
 *    update rather than round-tripped through the primitive state.
 */

import { createLogger } from "@/lib/logging";
import {
  graphLaneId,
  laneStateKey,
  parseGraphLaneId,
  parseLaneStateKey,
  type LaneIdentity,
} from "@/lib/workflow-graph/lane-identity";
import type { LaneStore } from "@/lib/workflows/primitives/lane-store";
import {
  laneStateSchema,
  type LanePolicy,
  type LaneRef,
  type LaneState,
  type LaneWriteCapability,
} from "@/lib/workflows/primitives/lane-vocabulary";
import {
  graphWorkflowAgentSessionStateSchema,
  type GraphWorkflowAgentSessionState,
  type GraphWorkflowExecution,
  type GraphWorkflowLaneKind,
} from "@/lib/workflow-graph/schemas";

const logger = createLogger("workflow-graph.lane-store");

/** The executions repo keys its active-execution map `projectPath<NUL>sessionName`. */
const ACTIVE_KEY_SEPARATOR = "\u0000";

// The lane-id encoding itself lives in `lane-identity`, which every addressing
// surface shares; re-exported here so the store's existing consumers keep one
// import.
export { graphLaneId, parseGraphLaneId };

export interface GraphLaneStoreDeps {
  /**
   * All active executions keyed by `${projectPath}\u0000${sessionName}`
   * (the executions repo's `listActive` shape). The store locates a lane's
   * owning session by execution id.
   */
  listActiveExecutions(): Promise<Map<string, GraphWorkflowExecution>>;
  /**
   * Atomic read-modify-write of a session's active execution. Production
   * threads the engine repository's `mutateActive`, so lane writes flow
   * through the same critical section (and loop fences) as every other
   * execution mutation.
   */
  mutateActiveExecution(
    projectPath: string,
    sessionName: string,
    fn: (execution: GraphWorkflowExecution) => GraphWorkflowExecution,
  ): Promise<GraphWorkflowExecution>;
}

interface LocatedExecution {
  projectPath: string;
  sessionName: string;
  execution: GraphWorkflowExecution;
}

/**
 * Each lane answers to its OWN assignment's continuity policy. Before cohorts
 * every validator lane in a context shared the first assignment's policy,
 * because there was only one lane to apply it to; now a cohort can pair a
 * long-lived reviewer with a fresh-eyes one in the same context.
 */
function resolveLanePolicy(
  execution: GraphWorkflowExecution,
  identity: LaneIdentity,
  contextId: string,
): LanePolicy {
  const ctx = execution.workingDefinition.executionContexts.find(
    (candidate) => candidate.id === contextId,
  );
  const continuity =
    identity.lane === "implementer"
      ? ctx?.iterationPolicy.continuity
      : ctx?.contextValidator.assignments.find(
          (assignment) => assignment.id === identity.assignmentId,
        )?.continuity;
  return {
    continuityEnabled: continuity?.enabled ?? true,
    ...(continuity?.contextLimitTokens !== undefined
      ? { contextLimitTokens: continuity.contextLimitTokens }
      : {}),
  };
}

function laneWriteCapability(lane: GraphWorkflowLaneKind): LaneWriteCapability {
  return lane === "implementer" ? "write_capable" : "read_only";
}

export function toNeutralLaneState(
  execution: GraphWorkflowExecution,
  graphLane: GraphWorkflowAgentSessionState,
  identity: LaneIdentity,
  contextId: string,
): LaneState {
  const { lane } = identity;
  const normalized = graphWorkflowAgentSessionStateSchema.parse(graphLane);
  return laneStateSchema.parse({
    workflowId: execution.id,
    laneId: graphLaneId(lane, contextId, identity.assignmentId ?? undefined),
    backend: normalized.backend,
    refKind: normalized.refKind,
    ref: normalized.sessionRef?.ref ?? null,
    ...(normalized.workflowConversationId !== undefined
      ? { conversationId: normalized.workflowConversationId }
      : {}),
    writeCapability: laneWriteCapability(lane),
    policy: resolveLanePolicy(execution, identity, contextId),
    metrics: normalized.metrics,
    lastUsedAt: normalized.lastUsedAt,
  });
}

/** Context-window metrics exposed uniformly to graph consumers. */
export function graphLaneContextMetrics(
  lane: GraphWorkflowAgentSessionState | undefined,
): { contextTokens: number | null; contextWindowMax: number | null } {
  return {
    contextTokens: lane?.metrics.contextTokens ?? null,
    contextWindowMax: lane?.metrics.contextWindowMax ?? null,
  };
}

/**
 * Projects a neutral lane state onto the persisted graph shape, updating the
 * neutral-mappable fields in place and preserving graph-only fields from the
 * existing record. When a conversation anchor follows the continuity handle,
 * advancing that handle advances the anchor too rather than leaving it
 * pointing at a retired conversation.
 */
export function toGraphLaneState(
  state: LaneState,
  identity: LaneIdentity,
  contextId: string,
  existing: GraphWorkflowAgentSessionState | undefined,
): GraphWorkflowAgentSessionState {
  const { lane } = identity;
  const normalizedExisting = existing
    ? graphWorkflowAgentSessionStateSchema.parse(existing)
    : undefined;
  const existingMatchesBackend = Object.is(
    normalizedExisting?.backend,
    state.backend,
  );
  const sameContinuityRef =
    existingMatchesBackend && normalizedExisting?.sessionRef?.ref === state.ref;
  const priorConversationFollowedRef =
    existingMatchesBackend &&
    state.conversationId === normalizedExisting?.sessionRef?.ref;
  const conversationId = sameContinuityRef
    ? (normalizedExisting?.workflowConversationId ?? state.conversationId)
    : priorConversationFollowedRef
      ? (state.ref ?? undefined)
      : state.conversationId;
  const assignmentId =
    identity.assignmentId ?? normalizedExisting?.assignmentId;
  return graphWorkflowAgentSessionStateSchema.parse({
    backend: state.backend,
    refKind: state.refKind ?? normalizedExisting?.refKind ?? "backend",
    lane,
    contextId,
    ...(assignmentId !== undefined ? { assignmentId } : {}),
    // The fingerprint is rotation's business, not the neutral lane state's:
    // preserve whatever the continuity layer stamped rather than dropping it on
    // every post-turn mirror-back.
    ...(normalizedExisting?.assignmentFingerprint !== undefined
      ? { assignmentFingerprint: normalizedExisting.assignmentFingerprint }
      : {}),
    ...(conversationId !== undefined
      ? { workflowConversationId: conversationId }
      : {}),
    ...(state.ref !== null
      ? { sessionRef: { backend: state.backend, ref: state.ref } }
      : {}),
    metrics: state.metrics,
    limitEvaluation: existingMatchesBackend
      ? normalizedExisting!.limitEvaluation
      : "disabled",
    lastUsedAt: state.lastUsedAt,
  });
}

export function createGraphLaneStore(deps: GraphLaneStoreDeps): LaneStore {
  async function locateExecution(
    workflowId: string,
  ): Promise<LocatedExecution | null> {
    const active = await deps.listActiveExecutions();
    for (const [key, execution] of active) {
      if (execution.id !== workflowId) continue;
      const separatorIndex = key.indexOf(ACTIVE_KEY_SEPARATOR);
      if (separatorIndex === -1) continue;
      return {
        projectPath: key.slice(0, separatorIndex),
        sessionName: key.slice(separatorIndex + 1),
        execution,
      };
    }
    return null;
  }

  function requireLaneId(
    laneId: string,
  ): LaneIdentity & { contextId: string; key: string } {
    const parsed = parseGraphLaneId(laneId);
    if (!parsed) {
      throw new Error(
        `graph lane store: laneId "${laneId}" is not a graph lane id — use graphLaneId(lane, contextId, assignmentId)`,
      );
    }
    return {
      ...parsed,
      key: laneStateKey(parsed.lane, parsed.assignmentId ?? undefined),
    };
  }

  return {
    async read(ref: LaneRef): Promise<LaneState | null> {
      const { contextId, key, ...identity } = requireLaneId(ref.laneId);
      const located = await locateExecution(ref.workflowId);
      if (!located) return null;
      const graphLane = located.execution.laneStates[contextId]?.[key];
      if (!graphLane) return null;
      return toNeutralLaneState(
        located.execution,
        graphLane,
        identity,
        contextId,
      );
    },

    async write(state: LaneState): Promise<void> {
      const parsed = laneStateSchema.parse(state);
      const { contextId, key, ...identity } = requireLaneId(parsed.laneId);
      const located = await locateExecution(parsed.workflowId);
      if (!located) {
        throw new Error(
          `graph lane store: no active execution with id "${parsed.workflowId}"`,
        );
      }
      await deps.mutateActiveExecution(
        located.projectPath,
        located.sessionName,
        (execution) => {
          if (execution.id !== parsed.workflowId) {
            throw new Error(
              `graph lane store: active execution changed (expected "${parsed.workflowId}", found "${execution.id}")`,
            );
          }
          const existing = execution.laneStates[contextId]?.[key];
          const nextLane = toGraphLaneState(
            parsed,
            identity,
            contextId,
            existing,
          );
          logger.debug("graph_lane_store.write", {
            executionId: execution.id,
            contextId,
            lane: identity.lane,
            assignmentId: identity.assignmentId,
            backend: parsed.backend,
          });
          return {
            ...execution,
            laneStates: {
              ...execution.laneStates,
              [contextId]: {
                ...execution.laneStates[contextId],
                [key]: nextLane,
              },
            },
          };
        },
      );
    },

    async delete(ref: LaneRef): Promise<void> {
      const { contextId, key, ...identity } = requireLaneId(ref.laneId);
      const located = await locateExecution(ref.workflowId);
      if (!located) return;
      await deps.mutateActiveExecution(
        located.projectPath,
        located.sessionName,
        (execution) => {
          const contextLanes = execution.laneStates[contextId];
          if (!contextLanes || !(key in contextLanes)) {
            return execution;
          }
          const { [key]: _removed, ...remainingLanes } = contextLanes;
          const nextLaneStates = { ...execution.laneStates };
          if (Object.keys(remainingLanes).length === 0) {
            delete nextLaneStates[contextId];
          } else {
            nextLaneStates[contextId] = remainingLanes;
          }
          logger.debug("graph_lane_store.delete", {
            executionId: execution.id,
            contextId,
            lane: identity.lane,
            assignmentId: identity.assignmentId,
          });
          return { ...execution, laneStates: nextLaneStates };
        },
      );
    },

    async listByWorkflow(workflowId: string): Promise<LaneState[]> {
      const located = await locateExecution(workflowId);
      if (!located) return [];
      const lanes: LaneState[] = [];
      for (const [contextId, contextLanes] of Object.entries(
        located.execution.laneStates,
      )) {
        for (const [laneKey, graphLane] of Object.entries(contextLanes)) {
          const identity = parseLaneStateKey(laneKey);
          if (!identity) continue;
          lanes.push(
            toNeutralLaneState(
              located.execution,
              graphLane,
              identity,
              contextId,
            ),
          );
        }
      }
      return lanes;
    },
  };
}
