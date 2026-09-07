/**
 * Loop budgets: the slot-ledger lifecycle and the per-execution pass backstop
 * (D4 R10, decision D7).
 *
 * `loop-settlement.ts` owns the decision — which pass concludes a loop, which
 * one unrolls next. This module owns the arithmetic that decision is admitted
 * against, and it is deliberately separate because the two budgets answer to
 * different authorities:
 *
 *  - a loop's `maxPasses` is per-loop, mandatory, and raisable by an audited
 *    repair. Settlement checks it, because only settlement knows the verdict
 *    that precedes it (R9.3).
 *  - the {@link EXECUTION_TOTAL_PASS_BACKSTOP} is per-EXECUTION and raisable by
 *    nobody. It is spent by every loop group together, so no single loop's
 *    settlement can evaluate it in isolation: admission walks every decision of
 *    one scheduling pass, in definition order, against one shared ledger.
 *
 * Both live in the durable slot ledger rather than in a counter, so a restart
 * replays the same arbitration (decision D7) instead of re-deriving a budget
 * from a graph scan that a refused unroll or a released reservation would skew.
 */

import { EXECUTION_TOTAL_PASS_BACKSTOP } from "@/lib/workflow-graph/constants";
import {
  findLoopBodyMembership,
  loopInstanceId,
} from "@/lib/workflow-graph/loop-resolver";
import type { GraphWorkflowResolvedLoopGroup } from "@/lib/workflow-graph/definition-schemas";
import type {
  GraphWorkflowExecution,
  GraphWorkflowLoopState,
} from "@/lib/workflow-graph/schemas";

export { EXECUTION_TOTAL_PASS_BACKSTOP };

/**
 * The loop groups the engine can actually settle: seed resolution replaces every
 * authored group with a resolved one carrying its body template, and only those
 * have passes to admit.
 */
export function resolvedLoopGroups(
  execution: GraphWorkflowExecution,
): readonly GraphWorkflowResolvedLoopGroup[] {
  return (execution.workingDefinition.loopGroups ?? []).filter(
    (group): group is GraphWorkflowResolvedLoopGroup => "template" in group,
  );
}

/**
 * The loop's ledger entry, created dormant on first touch.
 *
 * It lives here rather than in `loop-settlement.ts` because settlement is not
 * its only writer: an accepted loop-control edit bumps `loopControlRevision`
 * through the live-edit core (R11.2/R12), and that core cannot import
 * settlement without a cycle. One factory keeps the dormant shape — and the
 * defaults a reload has to reproduce — in exactly one place.
 */
export function ensureLoopState(
  execution: GraphWorkflowExecution,
  loopGroupId: string,
): GraphWorkflowLoopState {
  const existing = execution.loopStates[loopGroupId];
  if (existing) return existing;
  const created: GraphWorkflowLoopState = {
    loopGroupId,
    activation: "unstarted",
    loopControlRevision: 0,
    passCount: 0,
    slotLedger: [],
    boundaryInputs: null,
    decisions: {},
    passTemplateVersions: {},
    concludingExitContextId: null,
    activatedAt: null,
    settledAt: null,
  };
  execution.loopStates[loopGroupId] = created;
  return created;
}

/**
 * Slots that currently occupy the execution's budget: every grant that has not
 * been released, whether the pass it admits has started yet or not.
 *
 * A `reserved` slot counts exactly as much as a `counted` one — that is the
 * point of reserving before the clone (decision D7). Only `released` returns
 * budget to the pool.
 */
export function livePassSlotCount(execution: GraphWorkflowExecution): number {
  let live = 0;
  for (const state of Object.values(execution.loopStates)) {
    for (const slot of state.slotLedger) {
      if (slot.state !== "released") live += 1;
    }
  }
  return live;
}

/** Whether this loop already holds an unreleased grant for `pass`. */
export function holdsLivePassSlot(
  state: GraphWorkflowLoopState | undefined,
  pass: number,
): boolean {
  return (
    state?.slotLedger.some(
      (slot) => slot.pass === pass && slot.state !== "released",
    ) ?? false
  );
}

/**
 * Reconcile one loop's ledger against durable state. Idempotent and derived, so
 * a resumed engine reaches the same ledger as an uninterrupted one.
 *
 * Two transitions, and both are about what actually happened rather than about
 * what was decided:
 *
 *  - **`reserved` → `counted` at first running.** R10 counts every STARTED pass,
 *    so the conversion is keyed off a pass instance leaving `pending` — not off
 *    the settlement that later reads its output. The distinction only matters
 *    for the third state: a slot that was never counted is one whose pass never
 *    ran, and that is the only kind that may be given back.
 *  - **`reserved` → `released`** for a grant whose pass will never exist: the
 *    unroll was refused or never staged, and the loop then concluded (a
 *    satisfying verdict on the pass that had already decided to unroll) or was
 *    declined. Without this the execution budget would leak a slot per abandoned
 *    reservation — the one way a bounded ledger could still starve later loops.
 *
 * A pass that EXISTS and has not started keeps its reservation HERE, because
 * nothing derivable says it will not run. The one case that knows otherwise is a
 * scheduling batch that never formed, and it releases explicitly through
 * {@link releaseLoopPassSlotsForContexts}.
 */
export function reconcilePassSlots(
  execution: GraphWorkflowExecution,
  group: GraphWorkflowResolvedLoopGroup,
  state: GraphWorkflowLoopState,
): boolean {
  let changed = false;
  for (const slot of state.slotLedger) {
    if (slot.state !== "reserved") continue;
    if (hasPassStarted(execution, group, slot.pass)) {
      slot.state = "counted";
      changed = true;
      continue;
    }
    const settled =
      state.activation === "concluded" || state.activation === "skipped";
    if (settled && slot.pass > state.passCount) {
      slot.state = "released";
      changed = true;
    }
  }
  return changed;
}

/** True once any instance of this pass has left `pending` — R10's "started". */
function hasPassStarted(
  execution: GraphWorkflowExecution,
  group: GraphWorkflowResolvedLoopGroup,
  pass: number,
): boolean {
  for (const template of group.template.contexts) {
    const status =
      execution.contextStates[loopInstanceId(group.id, pass, template.id)]
        ?.status;
    // `skipped` is not a start: the instance exists but never ran.
    if (status !== undefined && status !== "pending" && status !== "skipped") {
      return true;
    }
  }
  return false;
}

/**
 * Give back the pass slots of a scheduling batch that never formed — the
 * provisioning-failure compensation decision D7 requires.
 *
 * The scheduler reserves lanes, provisions worktrees outside the write queue,
 * and compensates a failure by disposing what it created and clearing the
 * reservation stamps. A loop pass caught in that batch is in exactly the state
 * the ledger cannot derive anything about: its instances EXIST, so the ordinary
 * reconciliation keeps their grant, yet no lane will ever run them under it.
 * Keeping the reservation would charge the shared backstop for a pass that has
 * not happened and cannot happen without a retry; releasing it hands the budget
 * back, and the retry is re-admitted through the same definition-ordered walk
 * every other grant goes through (a released slot is reusable, by this loop or
 * by another).
 *
 * Only a `reserved` slot whose pass has not STARTED is given back: a batch that
 * failed while some other instance of the pass was already running is not the
 * batch that ran it, and R10 counts that pass either way.
 *
 * Returns what it released, for the caller's log.
 */
export function releaseLoopPassSlotsForContexts(
  execution: GraphWorkflowExecution,
  contextIds: readonly string[],
): Array<{ loopGroupId: string; pass: number }> {
  const groups = resolvedLoopGroups(execution);
  if (groups.length === 0) return [];

  const released: Array<{ loopGroupId: string; pass: number }> = [];
  for (const contextId of contextIds) {
    const membership = findLoopBodyMembership(contextId, groups);
    if (!membership || membership.pass === null) continue;
    const group = groups.find((entry) => entry.id === membership.loopGroupId);
    const state = execution.loopStates[membership.loopGroupId];
    if (!group || !state) continue;
    if (hasPassStarted(execution, group, membership.pass)) continue;
    for (const slot of state.slotLedger) {
      if (slot.pass !== membership.pass) continue;
      if (slot.state !== "reserved") continue;
      slot.state = "released";
      released.push({ loopGroupId: group.id, pass: slot.pass });
    }
  }
  return released;
}

/**
 * The pass this running loop needs a slot back for, or null.
 *
 * A pass whose instances exist but whose grant was released has to be
 * re-admitted before it may run again — otherwise a retry after a provisioning
 * failure would run on budget the ledger already gave away, and the execution
 * could exceed the backstop by one pass per failed batch. Re-admission is a
 * REQUEST, not a right: it goes through the same ordered walk as any other, so a
 * loop that comes back to a full budget halts instead of running unadmitted.
 */
export function reinstatablePass(
  execution: GraphWorkflowExecution,
  group: GraphWorkflowResolvedLoopGroup,
): number | null {
  const state = execution.loopStates[group.id];
  if (!state || state.activation !== "running") return null;
  const pass = state.passCount;
  if (pass < 1 || holdsLivePassSlot(state, pass)) return null;
  // Only a pass that EXISTS is owed a slot. A released grant for a pass that was
  // never installed is simply budget returned; the loop re-decides it and buys a
  // fresh grant if it still wants one.
  const entryInstance =
    execution.contextStates[
      loopInstanceId(group.id, pass, group.entryContextId)
    ];
  return entryInstance ? pass : null;
}

/**
 * How many further passes this execution may admit before the backstop refuses.
 * Never negative — a ledger that somehow exceeded the ceiling still admits
 * nothing rather than wrapping into a fresh budget.
 */
export function remainingPassSlots(execution: GraphWorkflowExecution): number {
  return Math.max(
    0,
    EXECUTION_TOTAL_PASS_BACKSTOP - livePassSlotCount(execution),
  );
}
