/**
 * Collaboration flow-agent lane identity and the default backend pairing.
 *
 * A collaboration run has exactly two flow agents — `agent_one` (the
 * originating conversation's agent) and `agent_two` — and each owns one lane
 * keyed by its flow-agent id. Lane identity is deliberately NOT the backend
 * name: both agents may run the same backend, and two same-backend lanes must
 * stay distinct records with isolated continuity refs.
 *
 * `COLLABORATION_BACKEND_PAIR` / `oppositeCollaborationBackend` survive as the
 * DEFAULT-SUGGESTION helper only: when a caller does not configure Agent Two,
 * its backend defaults to the opposite of Agent One's. They are no longer
 * derivation authority for lane identity or per-lane settings.
 *
 * Seed policy (continuity, per-lane resume ref, each agent's backend) stays a
 * caller concern so each envelope expresses its own variant over the fixed
 * flow-agent pair.
 */

import type { AgentBackendId, AgentSessionRef } from "@/lib/shared/schemas";
import type { CollaborationFlowAgent } from "@/lib/workflow-graph/collaboration-schemas";
import type {
  LanePolicy,
  LaneState,
  LaneWriteCapability,
} from "@/lib/workflows/primitives/lane-vocabulary";

/**
 * The ordered flow-agent pair. Order is the lane-seed order — lanes are always
 * seeded `agent_one` then `agent_two`. `laneId` equals the flow-agent id.
 */
export const COLLABORATION_FLOW_AGENTS = ["agent_one", "agent_two"] as const;

/**
 * The ordered default backend pairing (claude first, codex second). Used only
 * to suggest Agent Two's default backend as the opposite of Agent One's.
 */
export const COLLABORATION_BACKEND_PAIR = ["claude", "codex"] as const;

/** The two backends of the default pairing, as a readonly tuple. */
export type CollaborationBackendPair = typeof COLLABORATION_BACKEND_PAIR;

/**
 * The backend paired opposite `backend` in the DEFAULT pairing. This is the
 * suggestion a caller applies when Agent Two has no explicit backend; an
 * explicitly configured Agent Two backend (including the same backend as
 * Agent One) always wins.
 */
export function oppositeCollaborationBackend(
  backend: AgentBackendId,
): AgentBackendId {
  const [first, second] = COLLABORATION_BACKEND_PAIR;
  return backend === first ? second : first;
}

/**
 * Per-lane seed inputs the caller supplies over the fixed flow-agent pair. The
 * pair's identity (its members, their order, lane-id-equals-flow-agent) is
 * owned here; everything genuinely per-run — each agent's backend, continuity
 * policy, write capability, and the optional resume ref to seed a lane with —
 * is passed in.
 */
export interface CollaborationLaneSeedInput {
  workflowId: string;
  writeCapability: LaneWriteCapability;
  policy: LanePolicy;
  lastUsedAt: string;
  /** Resolves the backend a given flow agent's lane runs on. */
  backendFor(agent: CollaborationFlowAgent): AgentBackendId;
  /**
   * Resolves the opaque continuity `ref` a given flow agent's lane starts
   * with, or `null` for a fresh lane. Called once per pair member in order.
   */
  seedRefFor(agent: CollaborationFlowAgent): string | null;
}

/**
 * The ordered `LaneState[]` seeding the collaboration pair — one lane per flow
 * agent, in flow-agent order, each keyed by its flow-agent id and carrying its
 * resolved backend.
 */
export function buildCollaborationLaneSeeds(
  input: CollaborationLaneSeedInput,
): LaneState[] {
  return COLLABORATION_FLOW_AGENTS.map((agent) => ({
    workflowId: input.workflowId,
    laneId: agent,
    backend: input.backendFor(agent),
    ref: input.seedRefFor(agent),
    writeCapability: input.writeCapability,
    policy: input.policy,
    metrics: { rotateBeforeNextTurn: false },
    lastUsedAt: input.lastUsedAt,
  }));
}

/**
 * The resume ref to seed `agent_one`'s lane with under the "only Agent One
 * inherits the originating conversation" rule: seed with `priorBackendRef.ref`
 * only when that prior ref belongs to Agent One's backend. `agent_two` always
 * starts fresh.
 */
export function agentOneLaneSeedRef(
  agentOneBackend: AgentBackendId,
  priorBackendRef: AgentSessionRef | null | undefined,
): string | null {
  if (priorBackendRef?.backend !== agentOneBackend) return null;
  return priorBackendRef.ref;
}
