/**
 * The loop ledger view (D4 R16.2, decision D9).
 *
 * ONE pure derivation, shared by the inspector and the CLI, over the two durable
 * sources a loop's history lives in:
 *
 *  - **The blob markers** (`execution.loopStates`) — bounded CURRENT state:
 *    activation, pass count, the slot grants, and the LATEST decision per pass.
 *  - **The append-only event log** — the COMPLETE decision history, read through
 *    the cursor-paginated events reader. A pass re-decided under an amended
 *    `loopControlRevision` overwrites the blob's record but appends another
 *    event, so the log is the only place that history survives.
 *
 * Neither source alone answers the ledger question: the blob cannot hold the
 * history, and the log carries no activation, slot or pass-count state. Deriving
 * them together in one module is what keeps the two read surfaces from drifting
 * — and, because the derivation is pure over durable inputs, what makes it
 * reproduce identically after a restart.
 */

import type { GraphWorkflowExecutionEvent } from "./event-schemas";
import { parseLoopInstanceId } from "./loop-resolver";
import type {
  GraphWorkflowLoopDecisionRecord,
  GraphWorkflowLoopSlot,
  GraphWorkflowLoopState,
} from "./schemas";

export interface LoopLedgerDecisionEntry {
  readonly pass: number;
  readonly loopControlRevision: number;
  readonly templateVersion: number;
  readonly exitContextId: string;
  readonly exitCaptureIteration: number | null;
  readonly verdict: GraphWorkflowLoopDecisionRecord["verdict"];
  readonly outcome: GraphWorkflowLoopDecisionRecord["outcome"];
  readonly nextPass: number | null;
  readonly decidedAt: string;
  /**
   * True when this entry is the blob's current authoritative record for its
   * pass. Everything else is superseded history — a decision the loop really
   * made, under terms an operator has since amended.
   */
  readonly latest: boolean;
  /**
   * True when the entry came only from the blob marker: either the event log
   * page window did not reach it, or the row predates the loop-decision event.
   */
  readonly markerOnly: boolean;
}

export interface LoopLedgerEntry {
  readonly loopGroupId: string;
  readonly activation: GraphWorkflowLoopState["activation"];
  readonly loopControlRevision: number;
  readonly passCount: number;
  /** The loop's current cap, when the caller supplied the definition. */
  readonly maxPasses: number | null;
  readonly concludingExitContextId: string | null;
  readonly slots: readonly GraphWorkflowLoopSlot[];
  /** Every decision this loop is known to have made, oldest first. */
  readonly decisions: readonly LoopLedgerDecisionEntry[];
}

/** The definition-side facts the ledger reports beside the runtime markers. */
export interface LoopLedgerGroup {
  readonly id: string;
  readonly maxPasses: number;
}

/**
 * The marker fields the ledger actually reads — deliberately narrower than
 * `GraphWorkflowLoopState`, which satisfies it structurally.
 *
 * The CLI mirrors the wire permissively and cannot re-derive the persisted
 * schema; forcing it to declare fields this projection never reads is how a
 * mirror drifts into rejecting a real execution over a field nobody looks at.
 * The narrow port makes "what the ledger needs" checkable at the type level.
 */
export interface LoopLedgerStateInput {
  readonly activation: GraphWorkflowLoopState["activation"];
  readonly loopControlRevision: number;
  readonly passCount: number;
  readonly concludingExitContextId: string | null;
  readonly slotLedger: readonly GraphWorkflowLoopSlot[];
  readonly decisions: Readonly<Record<string, GraphWorkflowLoopDecisionRecord>>;
}

export interface DeriveLoopLedgerInput {
  readonly loopStates: Readonly<Record<string, LoopLedgerStateInput>>;
  /**
   * Loop-decision history in log order (oldest first). Callers pass whatever
   * window they read; a partial window degrades to the blob markers rather than
   * losing a pass.
   */
  readonly events: readonly GraphWorkflowExecutionEvent[];
  /** Definition order and caps; omitted, the ledger falls back to marker order. */
  readonly loopGroups?: readonly LoopLedgerGroup[];
}

/**
 * A materialized pass instance, as every read surface badges it (R13).
 *
 * Derived rather than persisted: the body contexts live in the frozen template,
 * not in `executionContexts`, so membership is decoded from the reserved id
 * namespace and joined to the group's cap and the loop's ledger.
 */
export interface LoopPassMembership {
  readonly loopGroupId: string;
  readonly pass: number;
  /** The loop's declared cap (R10) — the badge's denominator. */
  readonly maxPasses: number;
  /** Passes materialized so far, from the loop's own ledger. */
  readonly passCount: number;
  readonly activation: GraphWorkflowLoopState["activation"];
  /** The body template version this pass CLONED; null on a pre-ledger pass. */
  readonly templateVersion: number | null;
  /** The authored body id this instance was cloned from. */
  readonly authoredContextId: string;
}

/** The definition-side facts membership needs: the group's id and its cap. */
export interface LoopMembershipGroup {
  readonly id: string;
  readonly maxPasses: number;
}

/**
 * The marker fields membership reads — narrower than `GraphWorkflowLoopState`,
 * which satisfies it structurally, for the same reason as
 * {@link LoopLedgerStateInput}.
 */
export interface LoopMembershipStateInput {
  readonly activation: GraphWorkflowLoopState["activation"];
  readonly passCount: number;
  readonly passTemplateVersions: Readonly<Record<string, number>>;
}

/**
 * Which loop pass a context IS, or null when it is not a pass instance. Shared
 * by the graph node, the inspector and the CLI outline so one context can never
 * be badged three different ways.
 */
export function resolveLoopPassMembership(input: {
  readonly contextId: string;
  readonly loopGroups: readonly LoopMembershipGroup[];
  readonly loopStates: Readonly<Record<string, LoopMembershipStateInput>>;
}): LoopPassMembership | null {
  if (input.loopGroups.length === 0) return null;
  const parsed = parseLoopInstanceId(
    input.contextId,
    input.loopGroups.map((group) => group.id),
  );
  if (!parsed) return null;
  const group = input.loopGroups.find(
    (entry) => entry.id === parsed.loopGroupId,
  );
  if (!group) return null;
  const state = input.loopStates[parsed.loopGroupId];
  return {
    loopGroupId: parsed.loopGroupId,
    pass: parsed.pass,
    maxPasses: group.maxPasses,
    passCount: state?.passCount ?? 0,
    activation: state?.activation ?? "unstarted",
    templateVersion: state?.passTemplateVersions[String(parsed.pass)] ?? null,
    authoredContextId: parsed.authoredId,
  };
}

function isLatestRecord(
  record: GraphWorkflowLoopDecisionRecord,
  candidate: {
    pass: number;
    loopControlRevision: number;
    templateVersion: number;
    exitContextId: string;
    exitCaptureIteration: number | null;
  },
): boolean {
  return (
    record.pass === candidate.pass &&
    record.loopControlRevision === candidate.loopControlRevision &&
    record.templateVersion === candidate.templateVersion &&
    record.exitContextId === candidate.exitContextId &&
    record.exitCaptureIteration === candidate.exitCaptureIteration
  );
}

function markerEntry(
  record: GraphWorkflowLoopDecisionRecord,
): LoopLedgerDecisionEntry {
  return {
    pass: record.pass,
    loopControlRevision: record.loopControlRevision,
    templateVersion: record.templateVersion,
    exitContextId: record.exitContextId,
    exitCaptureIteration: record.exitCaptureIteration,
    verdict: record.verdict,
    outcome: record.outcome,
    nextPass: record.nextPass,
    decidedAt: record.decidedAt,
    latest: true,
    markerOnly: true,
  };
}

/**
 * The ledger rows for every loop the execution declares, in definition order.
 *
 * History ordering is the LOG's order, not the pass number's: a pass re-decided
 * after a later pass ran is reported where it actually happened, which is the
 * only ordering an audit of "what did the operator change, and when" can use.
 * Passes the window missed are appended from the markers so a bounded read never
 * silently drops a decision.
 */
export function deriveLoopLedger(
  input: DeriveLoopLedgerInput,
): LoopLedgerEntry[] {
  const orderedIds =
    input.loopGroups && input.loopGroups.length > 0
      ? input.loopGroups.map((group) => group.id)
      : Object.keys(input.loopStates);
  const maxPassesById = new Map(
    (input.loopGroups ?? []).map((group) => [group.id, group.maxPasses]),
  );

  const historyByLoop = new Map<string, LoopLedgerDecisionEntry[]>();
  for (const row of input.events) {
    if (row.event.type !== "graph-workflow-loop-decision") continue;
    const event = row.event;
    const state = input.loopStates[event.loopGroupId];
    const record = state?.decisions[String(event.pass)];
    const entries = historyByLoop.get(event.loopGroupId) ?? [];
    entries.push({
      pass: event.pass,
      loopControlRevision: event.loopControlRevision,
      templateVersion: event.templateVersion,
      exitContextId: event.exitContextId,
      exitCaptureIteration: event.exitCaptureIteration,
      verdict: event.verdict,
      outcome: event.outcome,
      nextPass: event.nextPass,
      decidedAt: event.decidedAt,
      latest: record !== undefined && isLatestRecord(record, event),
      markerOnly: false,
    });
    historyByLoop.set(event.loopGroupId, entries);
  }

  const entries: LoopLedgerEntry[] = [];
  for (const loopGroupId of orderedIds) {
    const state = input.loopStates[loopGroupId];
    if (!state) continue;
    const history = historyByLoop.get(loopGroupId) ?? [];
    const coveredPasses = new Set(
      history.filter((entry) => entry.latest).map((entry) => entry.pass),
    );
    const fromMarkers = Object.values(state.decisions)
      .filter((record) => !coveredPasses.has(record.pass))
      .sort((left, right) => left.pass - right.pass)
      .map(markerEntry);

    entries.push({
      loopGroupId,
      activation: state.activation,
      loopControlRevision: state.loopControlRevision,
      passCount: state.passCount,
      maxPasses: maxPassesById.get(loopGroupId) ?? null,
      concludingExitContextId: state.concludingExitContextId,
      slots: state.slotLedger,
      decisions: [...history, ...fromMarkers],
    });
  }
  return entries;
}
