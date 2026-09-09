/**
 * The checkpoint lifecycle's transition authority, as a pure function.
 *
 * Kept out of the repository on purpose: an illegal transition must be
 * unrepresentable before a write is attempted, so the repository compares
 * expected evidence and asks this module whether the edge exists, rather than
 * encoding the lifecycle in SQL where each method could drift its own copy.
 *
 * Supersession is NOT modelled here. A recovery build does not move the
 * operation it supersedes to another phase — it takes that operation out of the
 * active set by linkage, so the blocked operation keeps `needs_reconciliation`
 * and restoring the gate is the removal of that link. Encoding it as a phase
 * change would need a backward edge out of a terminal phase and would lose the
 * reason the operation was blocked.
 */

import type { CheckpointPhase } from "./schemas";

export interface CheckpointTransitionRequest {
  from: CheckpointPhase;
  to: CheckpointPhase;
}

export type CheckpointTransitionVerdict =
  | { legal: true }
  | { legal: false; reason: string };

/**
 * Every edge the lifecycle actually walks. A phase absent from a list is
 * refused, so `failed` and `cancelled` are terminal by having no entries and
 * no phase reaches itself.
 */
const LEGAL_TRANSITIONS: Readonly<
  Record<CheckpointPhase, readonly CheckpointPhase[]>
> = {
  building: ["retiring", "failed", "cancelled"],
  retiring: ["ready", "needs_reconciliation"],
  ready: ["delivering", "needs_reconciliation"],
  // `ready` is reachable again from `delivering` only for an admission failure
  // that definitely happened before any input could be accepted; an uncertain
  // send goes to `needs_reconciliation` instead.
  delivering: ["applied", "ready", "needs_reconciliation"],
  applied: ["needs_reconciliation"],
  needs_reconciliation: ["ready", "applied"],
  failed: [],
  cancelled: [],
};

export function validateCheckpointTransition(
  request: CheckpointTransitionRequest,
): CheckpointTransitionVerdict {
  const { from, to } = request;
  if (LEGAL_TRANSITIONS[from].includes(to)) return { legal: true };
  return {
    legal: false,
    reason: `checkpoint phase ${from} does not transition to ${to}`,
  };
}

/** Terminal phases: an operation here is finished and never moves again. */
export function isTerminalCheckpointPhase(phase: CheckpointPhase): boolean {
  return LEGAL_TRANSITIONS[phase].length === 0;
}

export type CheckpointOutcomeEdgeVerdict =
  | { owned: true }
  | { owned: false; owner: string; reason: string };

/**
 * Legal edges whose meaning IS a piece of evidence, and the repository method
 * that supplies it.
 *
 * A generic outcome carries no payload, no reference clear, no attempt binding
 * and no acceptance receipt, so walking one of these edges through it would
 * announce a phase whose defining fact never happened: `retiring` without a
 * frozen seed, `ready` while the retired provider reference still stands,
 * `delivering` with nothing bound to refuse a stale attempt, `applied` with no
 * proof the seed was ever accepted. Every legal edge not listed here is a
 * decision about work that already finished, which is exactly what an outcome
 * reports.
 *
 * One edge is split by state rather than by edge and so cannot appear here:
 * `needs_reconciliation → ready` is an outcome when it proves a delivery never
 * landed, and `commitReady`'s clear-and-commit when it repairs an interrupted
 * retirement. The repository decides that one by the operation's
 * `lastStablePhase`, which a table over edges cannot see.
 */
const EVIDENCE_BEARING_EDGES: Readonly<
  Partial<Record<CheckpointPhase, Partial<Record<CheckpointPhase, string>>>>
> = {
  building: { retiring: "freezePayload" },
  retiring: { ready: "commitReady" },
  ready: { delivering: "beginDelivery" },
  delivering: { applied: "recordAcceptance" },
  needs_reconciliation: { applied: "recordAcceptance" },
};

/**
 * Whether a generic outcome may write this edge at all. Phase legality is a
 * separate question asked by `validateCheckpointTransition`: an edge can be
 * perfectly legal for the lifecycle and still belong to one method.
 */
export function validateCheckpointOutcomeEdge(
  request: CheckpointTransitionRequest,
): CheckpointOutcomeEdgeVerdict {
  const { from, to } = request;
  const owner = EVIDENCE_BEARING_EDGES[from]?.[to];
  if (owner === undefined) return { owned: true };
  return {
    owned: false,
    owner,
    reason: `checkpoint phase ${from} reaches ${to} only through ${owner}, which carries the evidence for it`,
  };
}
