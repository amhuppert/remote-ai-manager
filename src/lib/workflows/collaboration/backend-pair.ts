/**
 * Collaboration flow-agent lane identity and the pair policy.
 *
 * A collaboration run has exactly two flow agents — `agent_one` (the
 * originating conversation's agent) and `agent_two` — and each owns one lane
 * keyed by its flow-agent id. Lane identity is deliberately NOT the backend
 * name: both agents may run the same backend, and two same-backend lanes must
 * stay distinct records with isolated continuity refs.
 *
 * The pair policy lives here, next to the lane identity it governs:
 *
 *  - `COLLABORATION_SUPPORTED_PAIRS` is the explicit matrix of ordered
 *    (agent_one, agent_two) backend pairs the flow admits.
 *  - `COLLABORATION_DEFAULT_PARTNER` is the DEFAULT-SUGGESTION half: when a
 *    caller does not configure Agent Two, its backend defaults to Agent One's
 *    partner here. It is never derivation authority for lane identity or
 *    per-lane settings — an explicitly configured Agent Two backend (including
 *    the same backend as Agent One) always wins.
 *
 * Which backends participate at all is `collaborationAgentSchema` in
 * ./types.ts; this module only says how participants pair. Seed policy
 * (continuity, per-lane resume ref) stays a caller concern so each envelope
 * expresses its own variant over the fixed flow-agent pair.
 */

import type { AgentBackendId, AgentSessionRef } from "@/lib/shared/schemas";
import { requireCollaborationAgent, type CollaborationAgent } from "./types";
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
 * The suggested partner for each participant when the caller configures no
 * Agent Two. Claude and Codex keep their historical pairing; Cursor is
 * partnered with Claude so its default counterpart is the participant with the
 * strongest enforcement and continuity guarantees.
 */
export const COLLABORATION_DEFAULT_PARTNER: Readonly<
  Record<CollaborationAgent, CollaborationAgent>
> = {
  claude: "codex",
  codex: "claude",
  cursor: "claude",
};

/**
 * The backend suggested for Agent Two when Agent One runs `backend`. A
 * suggestion only — see the module doc.
 */
export function defaultCollaborationPartner(
  backend: CollaborationAgent,
): CollaborationAgent {
  return COLLABORATION_DEFAULT_PARTNER[backend];
}

/**
 * Every ordered (agent_one, agent_two) backend pair Collaboration Mode admits.
 * Written out rather than derived so that adding a participant is a decision
 * about every position it may take; `backend-pair.test.ts` pins the matrix to
 * the full cross product of the participation enum, so a participant that is
 * added to the enum without being placed here fails loudly.
 */
export const COLLABORATION_SUPPORTED_PAIRS: ReadonlyArray<
  readonly [agentOne: CollaborationAgent, agentTwo: CollaborationAgent]
> = [
  ["claude", "codex"],
  ["claude", "claude"],
  ["claude", "cursor"],
  ["codex", "claude"],
  ["codex", "codex"],
  ["codex", "cursor"],
  ["cursor", "claude"],
  ["cursor", "codex"],
  ["cursor", "cursor"],
];

/**
 * Why the ordered pair is not admitted, or null when it is. Every ordered pair
 * of participants is admitted today, so this refuses only a pair the matrix
 * above omits — the guard that keeps the matrix authoritative if a future
 * participant is admitted to one position only.
 */
export function collaborationPairRefusal(
  agentOne: CollaborationAgent,
  agentTwo: CollaborationAgent,
): string | null {
  const supported = COLLABORATION_SUPPORTED_PAIRS.some(
    ([one, two]) => one === agentOne && two === agentTwo,
  );
  if (supported) return null;
  return `Collaboration Mode does not run ${agentOne} as agent_one with ${agentTwo} as agent_two`;
}

/**
 * The two lane backends of a graph-workflow collaboration, whose configuration
 * names only `secondAgent`: Agent Two runs it and Agent One runs its default
 * partner. A configured backend outside the participation policy fails here,
 * before any lane is seeded.
 */
export function resolveGraphCollaborationBackends(
  secondAgent: AgentBackendId,
): Record<CollaborationFlowAgent, CollaborationAgent> {
  const agentTwo = requireCollaborationAgent("agent_two", secondAgent);
  return {
    agent_one: defaultCollaborationPartner(agentTwo),
    agent_two: agentTwo,
  };
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
    metrics: {},
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
