/**
 * Durable graph-workflow lane store (plan §3.2.3).
 *
 * Implements the workflow-primitive `LaneStore` interface directly over the
 * execution repository: lane continuity state lives in
 * `execution.laneStates[contextId][laneKind]` and every read/write goes
 * through the persisted execution row in place. This is what makes lane
 * state (backend continuity handles, rotation flags, usage metrics) survive
 * a process restart — the design fix for the restart-losing in-memory
 * projections (bug §1.9.4).
 *
 * The store owns the mapping between the neutral primitive `LaneState` and
 * the persisted graph lane shape:
 *  - the primitive `laneId` encodes `(laneKind, contextId)` via
 *    `graphLaneId()`, because a workflow runs one lane per kind per context
 *    and parallel contexts must never collide;
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

const LANE_ID_SEPARATOR = "\u0000";

const LANE_KINDS: readonly GraphWorkflowLaneKind[] = [
  "implementer",
  "context_validator",
];

/**
 * Primitive-layer lane id for a graph lane. The NUL separator cannot occur
 * in a lane kind or a context id, so the encoding is unambiguous.
 */
export function graphLaneId(
  lane: GraphWorkflowLaneKind,
  contextId: string,
): string {
  return `${lane}${LANE_ID_SEPARATOR}${contextId}`;
}

export function parseGraphLaneId(
  laneId: string,
): { lane: GraphWorkflowLaneKind; contextId: string } | null {
  const separatorIndex = laneId.indexOf(LANE_ID_SEPARATOR);
  if (separatorIndex === -1) return null;
  const lane = laneId.slice(0, separatorIndex);
  const contextId = laneId.slice(separatorIndex + 1);
  if (!contextId) return null;
  const kind = LANE_KINDS.find((candidate) => candidate === lane);
  if (!kind) return null;
  return { lane: kind, contextId };
}

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
    fn: (
      execution: GraphWorkflowExecution,
    ) => GraphWorkflowExecution | Promise<GraphWorkflowExecution>,
  ): Promise<GraphWorkflowExecution>;
}

interface LocatedExecution {
  projectPath: string;
  sessionName: string;
  execution: GraphWorkflowExecution;
}

function resolveLanePolicy(
  execution: GraphWorkflowExecution,
  lane: GraphWorkflowLaneKind,
  contextId: string,
): LanePolicy {
  const ctx = execution.workingDefinition.executionContexts.find(
    (candidate) => candidate.id === contextId,
  );
  const continuity =
    lane === "implementer"
      ? ctx?.iterationPolicy.continuity
      : ctx?.contextValidator?.continuity;
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
  lane: GraphWorkflowLaneKind,
  contextId: string,
): LaneState {
  const normalized = graphWorkflowAgentSessionStateSchema.parse(graphLane);
  return laneStateSchema.parse({
    workflowId: execution.id,
    laneId: graphLaneId(lane, contextId),
    backend: normalized.backend,
    refKind: normalized.refKind,
    ref: normalized.sessionRef?.ref ?? null,
    ...(normalized.workflowConversationId !== undefined
      ? { conversationId: normalized.workflowConversationId }
      : {}),
    writeCapability: laneWriteCapability(lane),
    policy: resolveLanePolicy(execution, lane, contextId),
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
  lane: GraphWorkflowLaneKind,
  contextId: string,
  existing: GraphWorkflowAgentSessionState | undefined,
): GraphWorkflowAgentSessionState {
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
  return graphWorkflowAgentSessionStateSchema.parse({
    backend: state.backend,
    refKind: state.refKind ?? normalizedExisting?.refKind ?? "backend",
    lane,
    contextId,
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
      const separatorIndex = key.indexOf(LANE_ID_SEPARATOR);
      if (separatorIndex === -1) continue;
      return {
        projectPath: key.slice(0, separatorIndex),
        sessionName: key.slice(separatorIndex + 1),
        execution,
      };
    }
    return null;
  }

  function requireLaneId(laneId: string): {
    lane: GraphWorkflowLaneKind;
    contextId: string;
  } {
    const parsed = parseGraphLaneId(laneId);
    if (!parsed) {
      throw new Error(
        `graph lane store: laneId "${laneId}" is not a graph lane id — use graphLaneId(lane, contextId)`,
      );
    }
    return parsed;
  }

  return {
    async read(ref: LaneRef): Promise<LaneState | null> {
      const { lane, contextId } = requireLaneId(ref.laneId);
      const located = await locateExecution(ref.workflowId);
      if (!located) return null;
      const graphLane = located.execution.laneStates[contextId]?.[lane];
      if (!graphLane) return null;
      return toNeutralLaneState(located.execution, graphLane, lane, contextId);
    },

    async write(state: LaneState): Promise<void> {
      const parsed = laneStateSchema.parse(state);
      const { lane, contextId } = requireLaneId(parsed.laneId);
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
          const existing = execution.laneStates[contextId]?.[lane];
          const nextLane = toGraphLaneState(parsed, lane, contextId, existing);
          logger.debug("graph_lane_store.write", {
            executionId: execution.id,
            contextId,
            lane,
            backend: parsed.backend,
          });
          return {
            ...execution,
            laneStates: {
              ...execution.laneStates,
              [contextId]: {
                ...execution.laneStates[contextId],
                [lane]: nextLane,
              },
            },
          };
        },
      );
    },

    async delete(ref: LaneRef): Promise<void> {
      const { lane, contextId } = requireLaneId(ref.laneId);
      const located = await locateExecution(ref.workflowId);
      if (!located) return;
      await deps.mutateActiveExecution(
        located.projectPath,
        located.sessionName,
        (execution) => {
          const contextLanes = execution.laneStates[contextId];
          if (!contextLanes || !(lane in contextLanes)) {
            return execution;
          }
          const { [lane]: _removed, ...remainingLanes } = contextLanes;
          const nextLaneStates = { ...execution.laneStates };
          if (Object.keys(remainingLanes).length === 0) {
            delete nextLaneStates[contextId];
          } else {
            nextLaneStates[contextId] = remainingLanes;
          }
          logger.debug("graph_lane_store.delete", {
            executionId: execution.id,
            contextId,
            lane,
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
          const kind = LANE_KINDS.find((candidate) => candidate === laneKey);
          if (!kind) continue;
          lanes.push(
            toNeutralLaneState(located.execution, graphLane, kind, contextId),
          );
        }
      }
      return lanes;
    },
  };
}
