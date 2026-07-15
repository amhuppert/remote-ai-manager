/**
 * The collaboration backend pair, named once as explicit config.
 *
 * Collaboration Mode is a curated Claude×Codex pairing, not a generalized
 * N-backend orchestrator (design decision D19): the two agents always run on
 * opposite backends drawn from this exact ordered pair. This module is the
 * single source of that fact. It replaces the per-call-site
 * `backend === "claude" ? "codex" : "claude"` arithmetic and the hardcoded
 * `claudeLane`/`codexLane` seed literals that otherwise duplicate the pair's
 * identity across the two collaboration envelopes.
 *
 * Naming the pair here does NOT unify the two envelopes: each envelope keeps
 * its own duplicated phase-sequence body (the no-pause construction guarantee,
 * D5). Only the pair identity — its members, their order, and the opposite
 * mapping — is shared. Seed policy (continuity, per-lane resume ref) stays a
 * caller concern so each envelope expresses its own variant over the one
 * ordered pair.
 */

import type { AgentBackendId, AgentSessionRef } from "@/lib/shared/schemas";
import type {
  LanePolicy,
  LaneState,
  LaneWriteCapability,
} from "@/lib/workflows/primitives/lane-vocabulary";

/**
 * The ordered collaboration backend pair. Order is the lane-seed order — the
 * two lanes are always seeded `claude` then `codex` regardless of which
 * backend the primary agent runs on. `laneId` equals the backend id: each
 * backend owns exactly one collaboration lane, keyed by its own id.
 */
export const COLLABORATION_BACKEND_PAIR = ["claude", "codex"] as const;

/** The two backends that make up a collaboration run, as a readonly tuple. */
export type CollaborationBackendPair = typeof COLLABORATION_BACKEND_PAIR;

/**
 * The backend paired opposite `backend` in a collaboration run. Agent Two
 * always runs on the opposite backend from Agent One (the primary). Derived
 * from `COLLABORATION_BACKEND_PAIR` so the pair is stated in exactly one place.
 */
export function oppositeCollaborationBackend(
  backend: AgentBackendId,
): AgentBackendId {
  const [first, second] = COLLABORATION_BACKEND_PAIR;
  return backend === first ? second : first;
}

/**
 * Per-lane seed inputs the caller supplies over the fixed ordered pair. The
 * pair's identity (which backends, their order, each lane's id) is owned here;
 * everything genuinely per-envelope — continuity policy, write capability, and
 * the optional resume ref to seed a lane with — is passed in.
 */
export interface CollaborationLaneSeedInput {
  workflowId: string;
  writeCapability: LaneWriteCapability;
  policy: LanePolicy;
  lastUsedAt: string;
  /**
   * Resolves the opaque continuity `ref` a given lane's backend starts with,
   * or `null` for a fresh lane. Called once per pair member in pair order.
   */
  seedRefFor(backend: AgentBackendId): string | null;
}

/**
 * The ordered `LaneState[]` seeding the collaboration pair — one lane per pair
 * member, in pair order. Replaces the hardcoded `claudeLane`/`codexLane`
 * literals so the pair's members, order, and lane-id-equals-backend-id rule
 * live in one place.
 */
export function buildCollaborationLaneSeeds(
  input: CollaborationLaneSeedInput,
): LaneState[] {
  return COLLABORATION_BACKEND_PAIR.map((backend) => ({
    workflowId: input.workflowId,
    laneId: backend,
    backend,
    ref: input.seedRefFor(backend),
    writeCapability: input.writeCapability,
    policy: input.policy,
    metrics: { rotateBeforeNextTurn: false },
    lastUsedAt: input.lastUsedAt,
  }));
}

/**
 * The resume ref to seed a lane with under the "only the primary lane inherits
 * the originating conversation" rule: seed `backend`'s lane with
 * `priorBackendRef.ref` only when that prior ref belongs to `backend` AND
 * `backend` is the primary agent's backend. All other lanes start fresh.
 */
export function primaryLaneSeedRef(
  backend: AgentBackendId,
  primaryAgentBackend: AgentBackendId,
  priorBackendRef: AgentSessionRef | null | undefined,
): string | null {
  if (backend !== primaryAgentBackend) return null;
  if (priorBackendRef?.backend !== backend) return null;
  return priorBackendRef.ref;
}
