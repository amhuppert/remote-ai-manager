import { z } from "zod";
import {
  conversationTokenUsageSchema,
  type ConversationTokenUsage,
} from "../schemas";

/**
 * The durable per-conversation billing ledger for Cursor (spec: ticket #120).
 *
 * The provider bills a local agent per turn, keyed by a usage UUID that the
 * SDK never surfaces on the run it belongs to: `getUsage()` returns every entry
 * of the agent, and the local run record's `usageRef` stays null. Attribution
 * to a Command Center turn is therefore an inference this module owns and
 * states honestly — an entry is assigned to a turn only when the evidence
 * leaves one candidate, and otherwise stays unattributed while its cost still
 * counts for the conversation.
 *
 * Every figure folded into the conversation total is tracked here as
 * `appliedCents`, per entry and for the agent-level remainder, so a repeated
 * poll, a retry, a restart, or a late-landing cost applies each cent exactly
 * once and a provider figure that moves down never erases what was counted.
 * Cost is the provider's CHARGED amount in float cents; the undiscounted raw
 * cost travels alongside for disclosure and is never what a total sums.
 */

export const CURSOR_BILLING_MAX_ATTRIBUTION_ATTEMPTS = 6;
/** Turn history kept per conversation; settled history beyond it is dropped. */
export const CURSOR_BILLING_MAX_TURNS = 500;
/** Usage entries kept per agent; the oldest are dropped beyond it. */
export const CURSOR_BILLING_MAX_ENTRIES_PER_AGENT = 5_000;

const billingCostSchema = z.object({
  rawCostCents: z.number().nonnegative(),
  chargedCents: z.number().nonnegative(),
});
export type CursorBillingCost = z.infer<typeof billingCostSchema>;

export const cursorBillingTurnSchema = z.object({
  runId: z.string().min(1),
  agentId: z.string().min(1).nullable(),
  startedAt: z.string().min(1),
  outcome: z.enum(["running", "completed", "aborted", "failed"]),
  tokens: conversationTokenUsageSchema.nullable(),
  /**
   * `pending`: no usage entry tied to the turn yet. `attributed`: entries
   * known, cost not yet reported for all of them. `settled`: every entry has
   * its cost. `unresolved`: attribution attempts exhausted; cost stays unknown.
   * `unavailable`: the provider refuses billed usage for this account.
   */
  status: z.enum([
    "pending",
    "attributed",
    "settled",
    "unresolved",
    "unavailable",
  ]),
  usageIds: z.array(z.string().min(1)),
  attempts: z.number().int().nonnegative(),
  updatedAt: z.string().min(1),
});
export type CursorBillingTurn = z.infer<typeof cursorBillingTurnSchema>;

const billingEntrySchema = z.object({
  usage: conversationTokenUsageSchema,
  cost: billingCostSchema.nullable(),
  /** Charged cents of this entry already folded into the conversation total. */
  appliedCents: z.number().nonnegative(),
  turnRunId: z.string().min(1).nullable(),
  firstSeenAt: z.string().min(1),
});
export type CursorBillingEntry = z.infer<typeof billingEntrySchema>;

const billingAgentSchema = z.object({
  /** The provider's latest agent-level cost, as reported. */
  aggregate: billingCostSchema.nullable(),
  /** Everything folded into the conversation total for this agent. */
  appliedCents: z.number().nonnegative(),
  /**
   * The agent-level charge beyond the sum of its entries (events the provider
   * reports without a usage UUID), as far as it has been folded in.
   */
  appliedRemainderCents: z.number().nonnegative(),
  entries: z.record(z.string(), billingEntrySchema),
  observedAt: z.string().nullable(),
});
export type CursorBillingAgent = z.infer<typeof billingAgentSchema>;

export const cursorBillingLedgerSchema = z.object({
  version: z.literal(1),
  availability: z.object({
    state: z.enum(["unknown", "available", "unavailable"]),
    code: z.string().nullable(),
    observedAt: z.string().nullable(),
    /** When the unavailable state was disclosed in the conversation. */
    disclosedAt: z.string().nullable(),
  }),
  agents: z.record(z.string(), billingAgentSchema),
  turns: z.array(cursorBillingTurnSchema),
});
export type CursorBillingLedger = z.infer<typeof cursorBillingLedgerSchema>;

export interface CursorBillingSnapshotInput {
  usage: ConversationTokenUsage;
  cost: CursorBillingCost | null;
  runs: readonly {
    runId: string;
    usage: ConversationTokenUsage;
    cost: CursorBillingCost | null;
  }[];
}

export interface AppliedBillingSnapshot {
  ledger: CursorBillingLedger;
  /** Charged cents newly folded into the conversation by this snapshot. */
  deltaCents: number;
  /** The part of `deltaCents` attributable to specific turns. */
  deltaCentsByRun: Record<string, number>;
  /** The part of `deltaCents` that belongs to no turn (agent remainder). */
  remainderDeltaCents: number;
  /** The agent's cumulative applied charge after this snapshot. */
  cumulativeAppliedCents: number;
}

export function emptyCursorBillingLedger(): CursorBillingLedger {
  return {
    version: 1,
    availability: {
      state: "unknown",
      code: null,
      observedAt: null,
      disclosedAt: null,
    },
    agents: {},
    turns: [],
  };
}

function emptyAgent(): CursorBillingAgent {
  return {
    aggregate: null,
    appliedCents: 0,
    appliedRemainderCents: 0,
    entries: {},
    observedAt: null,
  };
}

/** Float cents accumulate; six decimals keeps the arithmetic drift-free. */
function roundCents(cents: number): number {
  return Math.round(cents * 1e6) / 1e6;
}

export function centsToUsd(cents: number): number {
  return roundCents(cents) / 100;
}

function sameTokens(
  left: ConversationTokenUsage,
  right: ConversationTokenUsage,
): boolean {
  return (
    left.totalTokens === right.totalTokens &&
    left.inputTokens === right.inputTokens &&
    left.outputTokens === right.outputTokens
  );
}

const SETTLED_STATUSES = new Set<CursorBillingTurn["status"]>([
  "settled",
  "unresolved",
  "unavailable",
]);

function boundTurns(turns: CursorBillingTurn[]): CursorBillingTurn[] {
  if (turns.length <= CURSOR_BILLING_MAX_TURNS) return turns;
  const kept = [...turns];
  for (
    let index = 0;
    index < kept.length && kept.length > CURSOR_BILLING_MAX_TURNS;
  ) {
    const turn = kept[index];
    if (turn !== undefined && SETTLED_STATUSES.has(turn.status)) {
      kept.splice(index, 1);
    } else {
      index += 1;
    }
  }
  return kept.slice(Math.max(0, kept.length - CURSOR_BILLING_MAX_TURNS));
}

function boundEntries(
  entries: Record<string, CursorBillingEntry>,
): Record<string, CursorBillingEntry> {
  const ids = Object.keys(entries);
  if (ids.length <= CURSOR_BILLING_MAX_ENTRIES_PER_AGENT) return entries;
  const ordered = ids.sort((left, right) => {
    const a = entries[left];
    const b = entries[right];
    return (a?.firstSeenAt ?? "").localeCompare(b?.firstSeenAt ?? "");
  });
  const dropped = new Set(
    ordered.slice(0, ordered.length - CURSOR_BILLING_MAX_ENTRIES_PER_AGENT),
  );
  return Object.fromEntries(
    Object.entries(entries).filter(([id]) => !dropped.has(id)),
  );
}

export function recordBillingTurnStart(
  ledger: CursorBillingLedger,
  input: { runId: string; agentId: string | null; startedAt: string },
): CursorBillingLedger {
  const turn: CursorBillingTurn = {
    runId: input.runId,
    agentId: input.agentId,
    startedAt: input.startedAt,
    outcome: "running",
    tokens: null,
    status: "pending",
    usageIds: [],
    attempts: 0,
    updatedAt: input.startedAt,
  };
  return {
    ...ledger,
    turns: boundTurns([
      ...ledger.turns.filter((existing) => existing.runId !== input.runId),
      turn,
    ]),
  };
}

export function recordBillingTurnEnd(
  ledger: CursorBillingLedger,
  input: {
    runId: string;
    agentId: string | null;
    tokens: ConversationTokenUsage | null;
    outcome: CursorBillingTurn["outcome"];
    at: string;
  },
): CursorBillingLedger {
  const existing = ledger.turns.find((turn) => turn.runId === input.runId);
  const turn: CursorBillingTurn = existing
    ? {
        ...existing,
        agentId: input.agentId ?? existing.agentId,
        outcome: input.outcome,
        tokens: input.tokens ?? existing.tokens,
        updatedAt: input.at,
      }
    : {
        runId: input.runId,
        agentId: input.agentId,
        startedAt: input.at,
        outcome: input.outcome,
        tokens: input.tokens,
        status: "pending",
        usageIds: [],
        attempts: 0,
        updatedAt: input.at,
      };
  return {
    ...ledger,
    turns: boundTurns(
      existing
        ? ledger.turns.map((current) =>
            current.runId === input.runId ? turn : current,
          )
        : [...ledger.turns, turn],
    ),
  };
}

function isAttributionCandidate(
  turn: CursorBillingTurn,
  agentId: string,
): boolean {
  return (
    turn.agentId === agentId &&
    turn.usageIds.length === 0 &&
    (turn.status === "pending" || turn.status === "unavailable")
  );
}

/**
 * Fold one provider snapshot into the ledger.
 *
 * Attribution runs three rules in order, each admitting only an unambiguous
 * assignment: (1) an entry whose token counts equal exactly one candidate
 * turn's counts; (2) the turn this snapshot was fetched for, when it is the
 * only candidate and every unassigned entry is new in this snapshot (a turn
 * with subagents bills several entries); (3) one remaining candidate and one
 * remaining entry. Anything else stays unattributed: its cost still reaches the
 * conversation, but no turn is credited with it.
 */
export function applyBillingSnapshot(
  ledger: CursorBillingLedger,
  input: {
    agentId: string;
    forRunId: string | null;
    snapshot: CursorBillingSnapshotInput;
    at: string;
  },
): AppliedBillingSnapshot {
  const previous = ledger.agents[input.agentId] ?? emptyAgent();
  const entries: Record<string, CursorBillingEntry> = { ...previous.entries };
  const newIds = new Set<string>();
  for (const run of input.snapshot.runs) {
    const known = entries[run.runId];
    if (known === undefined) newIds.add(run.runId);
    entries[run.runId] = {
      usage: run.usage,
      cost: run.cost,
      appliedCents: known?.appliedCents ?? 0,
      turnRunId: known?.turnRunId ?? null,
      firstSeenAt: known?.firstSeenAt ?? input.at,
    };
  }

  const turns = ledger.turns.map((turn) => ({
    ...turn,
    usageIds: [...turn.usageIds],
  }));
  const assign = (usageId: string, turn: CursorBillingTurn): void => {
    const entry = entries[usageId];
    if (entry === undefined) return;
    entries[usageId] = { ...entry, turnRunId: turn.runId };
    turn.usageIds.push(usageId);
  };
  const candidates = () =>
    turns.filter((turn) => isAttributionCandidate(turn, input.agentId));
  const unattributed = () =>
    Object.entries(entries)
      .filter(([, entry]) => entry.turnRunId === null)
      .map(([usageId]) => usageId);

  // Rule 1: exact token match against exactly one candidate.
  for (const usageId of unattributed()) {
    const entry = entries[usageId];
    if (entry === undefined) continue;
    const matches = candidates().filter(
      (turn) => turn.tokens !== null && sameTokens(turn.tokens, entry.usage),
    );
    const match = matches[0];
    if (matches.length === 1 && match !== undefined) assign(usageId, match);
  }
  // Rule 2: the fetched-for turn is the only candidate and every unassigned
  // entry landed with this snapshot.
  {
    const remaining = candidates();
    const target = remaining[0];
    const open = unattributed();
    if (
      remaining.length === 1 &&
      target !== undefined &&
      target.runId === input.forRunId &&
      open.length > 0 &&
      open.every((usageId) => newIds.has(usageId))
    ) {
      for (const usageId of open) assign(usageId, target);
    }
  }
  // Rule 3: one candidate, one entry.
  {
    const remaining = candidates();
    const target = remaining[0];
    const open = unattributed();
    const only = open[0];
    if (
      remaining.length === 1 &&
      target !== undefined &&
      open.length === 1 &&
      only !== undefined
    ) {
      assign(only, target);
    }
  }

  for (const turn of turns) {
    if (turn.agentId !== input.agentId) continue;
    if (turn.usageIds.length > 0) {
      const settled = turn.usageIds.every(
        (usageId) => entries[usageId]?.cost !== null,
      );
      const status = settled ? "settled" : "attributed";
      if (status !== turn.status) turn.updatedAt = input.at;
      turn.status = status;
      continue;
    }
    if (turn.status === "pending" || turn.status === "unavailable") {
      turn.attempts += 1;
      turn.status =
        turn.attempts >= CURSOR_BILLING_MAX_ATTRIBUTION_ATTEMPTS
          ? "unresolved"
          : "pending";
      turn.updatedAt = input.at;
    }
  }

  let deltaCents = 0;
  const deltaCentsByRun: Record<string, number> = {};
  for (const [usageId, entry] of Object.entries(entries)) {
    if (entry.cost === null) continue;
    const delta = roundCents(entry.cost.chargedCents - entry.appliedCents);
    if (delta <= 0) continue;
    entries[usageId] = { ...entry, appliedCents: entry.cost.chargedCents };
    deltaCents = roundCents(deltaCents + delta);
    if (entry.turnRunId !== null) {
      deltaCentsByRun[entry.turnRunId] = roundCents(
        (deltaCentsByRun[entry.turnRunId] ?? 0) + delta,
      );
    }
  }

  let remainderDeltaCents = 0;
  let appliedRemainderCents = previous.appliedRemainderCents;
  const aggregate = input.snapshot.cost;
  if (
    aggregate !== null &&
    input.snapshot.runs.every((run) => run.cost !== null)
  ) {
    const entriesCharged = input.snapshot.runs.reduce(
      (sum, run) => roundCents(sum + (run.cost?.chargedCents ?? 0)),
      0,
    );
    const remainder = Math.max(
      0,
      roundCents(aggregate.chargedCents - entriesCharged),
    );
    const delta = roundCents(remainder - appliedRemainderCents);
    if (delta > 0) {
      appliedRemainderCents = remainder;
      remainderDeltaCents = delta;
      deltaCents = roundCents(deltaCents + delta);
    }
  }

  const agent: CursorBillingAgent = {
    aggregate: aggregate ?? previous.aggregate,
    appliedCents: roundCents(previous.appliedCents + deltaCents),
    appliedRemainderCents,
    entries: boundEntries(entries),
    observedAt: input.at,
  };
  return {
    ledger: {
      ...ledger,
      availability: {
        state: "available",
        code: null,
        observedAt: input.at,
        disclosedAt: ledger.availability.disclosedAt,
      },
      agents: { ...ledger.agents, [input.agentId]: agent },
      turns: boundTurns(turns),
    },
    deltaCents,
    deltaCentsByRun,
    remainderDeltaCents,
    cumulativeAppliedCents: agent.appliedCents,
  };
}

/**
 * The provider refused billed usage for the account. Pending turns become
 * `unavailable` so nothing keeps asking for them; a later snapshot (the
 * feature appearing) makes them candidates again.
 */
export function applyBillingUnavailable(
  ledger: CursorBillingLedger,
  input: { agentId: string | null; code: string | null; at: string },
): CursorBillingLedger {
  return {
    ...ledger,
    availability: {
      state: "unavailable",
      code: input.code,
      observedAt: input.at,
      disclosedAt: ledger.availability.disclosedAt,
    },
    turns: ledger.turns.map((turn) =>
      turn.status === "pending" &&
      (input.agentId === null || turn.agentId === input.agentId)
        ? { ...turn, status: "unavailable", updatedAt: input.at }
        : turn,
    ),
  };
}

export function markBillingUnavailabilityDisclosed(
  ledger: CursorBillingLedger,
  at: string,
): CursorBillingLedger {
  return {
    ...ledger,
    availability: { ...ledger.availability, disclosedAt: at },
  };
}

/** Runs whose cost may still land, and are therefore worth another fetch. */
export function billingRunsAwaitingSettlement(
  ledger: CursorBillingLedger,
  agentId: string,
): string[] {
  if (ledger.availability.state === "unavailable") return [];
  return ledger.turns
    .filter(
      (turn) =>
        turn.agentId === agentId &&
        (turn.status === "attributed" ||
          (turn.status === "pending" &&
            turn.attempts < CURSOR_BILLING_MAX_ATTRIBUTION_ATTEMPTS)),
    )
    .map((turn) => turn.runId);
}

export function billingTurn(
  ledger: CursorBillingLedger,
  runId: string,
): CursorBillingTurn | undefined {
  return ledger.turns.find((turn) => turn.runId === runId);
}

/** A settled turn's billed cost, summed over its entries; null until settled. */
export function turnBilledCost(
  ledger: CursorBillingLedger,
  runId: string,
): CursorBillingCost | null {
  const turn = billingTurn(ledger, runId);
  if (turn === undefined || turn.status !== "settled" || turn.agentId === null)
    return null;
  const agent = ledger.agents[turn.agentId];
  if (agent === undefined) return null;
  let rawCostCents = 0;
  let chargedCents = 0;
  for (const usageId of turn.usageIds) {
    const cost = agent.entries[usageId]?.cost;
    if (!cost) return null;
    rawCostCents = roundCents(rawCostCents + cost.rawCostCents);
    chargedCents = roundCents(chargedCents + cost.chargedCents);
  }
  return { rawCostCents, chargedCents };
}
