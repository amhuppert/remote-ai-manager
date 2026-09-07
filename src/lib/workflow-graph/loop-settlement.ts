/**
 * Loop settlement: activation, the logical exit, the slot ledger, and the
 * decision transaction (D4 R9/R16, decisions D7 and D8).
 *
 * A loop group repeats its body by UNROLLING it into immutable per-pass
 * instances. `loop-resolver.ts` owns accept time and pass 1; this module owns
 * everything after: when a loop becomes active (or is never taken), which pass
 * instance concludes it, and the one fenced transaction that reads a landed
 * exit's banked capture and either concludes the loop, materializes the next
 * pass, or halts.
 *
 * Two properties shape the whole module:
 *
 *  - **Post-land.** A pass settles only once its exit instance has COMPLETED and
 *    its landing intent reconciled `landed` (decision D8). Deciding earlier
 *    would evaluate the predicate against work the graph cannot yet see, and
 *    materialize a pass whose entry reads a payload that has not landed.
 *  - **Idempotent on the decision record.** Every applied decision writes a
 *    {@link GraphWorkflowLoopDecisionRecord} carrying its full deduplication key
 *    (loop, pass, control revision, exit-capture identity, template version).
 *    A HALT applies no loop decision: it is re-derived from durable state on
 *    every pass, which lets amended control or a repaired exit take effect on
 *    resume. Ledger reconciliation still records passes that have started.
 *
 * Two budgets gate the decision and they are checked in different places. A
 * loop's own `maxPasses` is per-loop and belongs to {@link decideLoop}, because
 * only the decision knows the verdict that must precede it (R9.3). The
 * per-execution pass backstop is arithmetic `loop-budgets.ts` owns and is spent
 * by every loop group together, so no single loop's decision can weigh it:
 * {@link settleLoops} admits the whole scheduling pass against it in one
 * definition-ordered walk.
 *
 * The structural half rides the prepare/finalize staging seam and, through it,
 * `applyLiveExecutionEdits` — the same core every live edit, expansion and
 * repair goes through, so unrolling inherits the Kahn acyclicity check, the
 * frozen-past invariant and the criterion-must-run lock rather than restating
 * them.
 */

import {
  finalizePreparedEdits,
  prepareLiveExecutionEdits,
  type FinalizePreparedEditsResult,
  type LiveEditDeps,
  type PrepareLiveExecutionEditsResult,
  type PreparedLiveEdits,
} from "@/lib/workflow-graph/runtime-edits";
import { projectExecutionRoutes } from "@/lib/workflow-graph/execution-routes";
import { resolveUpstreamInputs } from "@/lib/workflow-graph/context-outputs";
import { isRouteSourceLanded } from "@/lib/workflow-graph/lane-readiness";
import {
  EXECUTION_TOTAL_PASS_BACKSTOP,
  ensureLoopState,
  holdsLivePassSlot,
  livePassSlotCount,
  reconcilePassSlots,
  reinstatablePass,
  remainingPassSlots,
  resolvedLoopGroups,
} from "@/lib/workflow-graph/loop-budgets";
import {
  SEED_TEMPLATE_VERSION,
  loopInstanceId,
} from "@/lib/workflow-graph/loop-resolver";
import { lookupRawContextOutput } from "@/lib/workflow-graph/output-lookup";
import { routeVerdict } from "@/lib/workflow-graph/route-projection";
import type { GraphWorkflowResolvedLoopGroup } from "@/lib/workflow-graph/definition-schemas";
import type {
  GraphWorkflowExecution,
  GraphWorkflowHaltReason,
  GraphWorkflowLoopDecisionRecord,
  GraphWorkflowLoopState,
} from "@/lib/workflow-graph/schemas";
import { validateJsonSchemaSubset } from "@/lib/workflows/primitives/output-schema-subset";

/**
 * The three halts loop settlement can raise, narrowed out of the halt union so
 * callers read `loopGroupId` and `pass` without re-discriminating. All three are
 * resumable (see `HALT_RESUMABILITY`).
 */
export type LoopHaltReason = Extract<
  GraphWorkflowHaltReason,
  { type: "loop_exit_skipped" | "loop_invariant" | "loop_limit_reached" }
>;

/**
 * A decided-but-not-yet-installed unroll. The structural half cannot run inside
 * the write queue — validation is whole-execution work — so the decision is
 * reported here, staged outside the lock, and re-checked at finalize.
 */
export interface LoopMaterializationRequest {
  readonly loopGroupId: string;
  /** The pass that was decided — the one whose exit produced the verdict. */
  readonly pass: number;
  /** The pass to materialize; always `pass + 1`. */
  readonly nextPass: number;
  readonly loopControlRevision: number;
  readonly templateVersion: number;
  readonly exitContextId: string;
  readonly exitCaptureIteration: number | null;
}

export interface LoopSettlementOutcome {
  readonly ledgerChanged: boolean;
  /** Loops that became active this pass, reserving their pass-1 slot. */
  readonly activatedLoopGroupIds: readonly string[];
  /** Loops whose activation path was not taken (R9.6) — no halt. */
  readonly skippedLoopGroupIds: readonly string[];
  /** Loops whose exit satisfied the until predicate this pass. */
  readonly concludedLoopGroupIds: readonly string[];
  readonly materializations: readonly LoopMaterializationRequest[];
  /**
   * The typed resumable loop halt this pass found, or null.
   *
   * A halt raised by a DECISION — an exit that skipped, an unreadable capture, a
   * loop past its own `maxPasses` — applies no loop decision, for the same
   * reason a routing halt does: settling around a loop the engine cannot decide
   * is the guess R9 forbids. Reconciled ledger changes remain authoritative.
   *
   * A halt raised by the shared BACKSTOP is different in exactly one way: the
   * grants the budget already admitted, in definition order, before it reached
   * the loop it had to refuse, stand. They are what makes the ceiling a boundary
   * of 25 admitted passes rather than 24 (R10.3) — abandoning an affordable grant
   * because a LATER loop could not afford one would halt the execution below the
   * constant, and every resume would re-derive the same refusal from the same
   * ledger, so the pass would never be admitted at all. The refused loop and
   * every loop after it apply nothing and re-decide on resume.
   */
  readonly halt: LoopHaltReason | null;
}

export interface LoopSettlementOptions {
  now: string;
}

/**
 * One loop's decision, before anything is written. Kept separate from
 * application so the whole pass can be decided first, then admitted against the
 * shared budget in definition order.
 *
 * Positional: decision `i` belongs to loop group `i`, so the group is never
 * carried twice and the apply walk cannot drift out of the order the ledger
 * records its grants in.
 */
type LoopDecision =
  | { kind: "idle" }
  | { kind: "activate" }
  | { kind: "skip" }
  | { kind: "conclude"; record: GraphWorkflowLoopDecisionRecord }
  | {
      kind: "materialize";
      request: LoopMaterializationRequest;
      record: GraphWorkflowLoopDecisionRecord;
    }
  | { kind: "halt"; halt: LoopHaltReason };

/**
 * Settle every loop the graph can currently decide, in one mutation.
 *
 * Runs inside `mutateActive` AFTER route settlement, because activation reads
 * the routes and the skips that pass just applied. Loop groups are processed in
 * DEFINITION order and the ledger records the grant order, so a restart replays
 * identical slot arbitration (decision D7).
 *
 * Materializations are reported, not applied: they need the staging seam. Every
 * other decision commits here, in the caller's mutation.
 */
export function settleLoops(
  draft: GraphWorkflowExecution,
  options: LoopSettlementOptions,
): LoopSettlementOutcome {
  const groups = resolvedLoopGroups(draft);
  if (groups.length === 0) return emptyOutcome();

  // Reconcile BEFORE anything reads the budget. Both slot transitions are
  // derived from durable state rather than decided, so they hold whether or not
  // this pass can settle anything — and a halt must never be able to leave a
  // pass that genuinely ran sitting in `reserved`, which is the one state the
  // release path is entitled to give back (R10's started-pass accounting).
  const ledgerChanged = reconcileLedgers(draft, groups);

  const projection = projectExecutionRoutes(draft);
  const decisions = groups.map((group) =>
    decideLoop(draft, group, projection, options),
  );

  const halt = decisions.find(
    (decision): decision is Extract<LoopDecision, { kind: "halt" }> =>
      decision.kind === "halt",
  );
  if (halt) return { ...emptyOutcome(), ledgerChanged, halt: halt.halt };

  const outcome = applyDecisions(draft, groups, decisions, options);
  return { ...outcome, ledgerChanged: ledgerChanged || outcome.ledgerChanged };
}

/**
 * Apply this scheduling pass's decisions in DEFINITION order, admitting each
 * one's pass slots against the single budget every loop group shares (R10.3,
 * decision D7).
 *
 * Admission and application are one walk because the ledger records the grant
 * order: the earlier-declared loop is considered first, and a restart replays
 * that same arbitration off the durable ledger. A decision that already holds a
 * live grant for the pass it wants costs nothing — a reservation whose unroll
 * never installed is re-used, never re-bought.
 *
 * The refusal is a PREFIX boundary. Everything admitted before it is applied and
 * durable; the refused loop and every loop declared after it apply nothing and
 * re-decide on resume. That is what makes 25 the number of passes the execution
 * may start: dropping an affordable grant because a later loop could not afford
 * one would halt at 24 forever, since every resume re-derives the identical
 * arbitration from the identical ledger.
 */
function applyDecisions(
  draft: GraphWorkflowExecution,
  groups: readonly GraphWorkflowResolvedLoopGroup[],
  decisions: readonly LoopDecision[],
  options: LoopSettlementOptions,
): LoopSettlementOutcome {
  const activatedLoopGroupIds: string[] = [];
  const skippedLoopGroupIds: string[] = [];
  const concludedLoopGroupIds: string[] = [];
  const materializations: LoopMaterializationRequest[] = [];
  let ledgerChanged = false;
  let remaining = remainingPassSlots(draft);
  let halt: LoopHaltReason | null = null;

  for (let index = 0; index < groups.length; index += 1) {
    const group = groups[index];
    const decision = decisions[index];
    if (!group || !decision) continue;

    let refused: SlotRequest | null = null;
    for (const request of slotRequests(draft, group, decision)) {
      if (remaining === 0) {
        refused = request;
        break;
      }
      // The slot is admitted HERE — in this pass's definition-order walk and
      // before the clone (decision D7) — even though an unroll installs in a
      // later mutation through the staging seam. Deferring the grant to that
      // mutation would hand a lower grant order to any loop declared AFTER this
      // one that merely activated in the same scheduling pass, which is the
      // arbitration reversal the ledger exists to prevent.
      const granted = grantSlot(
        draft,
        ensureLoopState(draft, group.id),
        request.pass,
        options.now,
      );
      ledgerChanged ||= granted;
      remaining -= 1;
    }
    if (refused) {
      halt = executionBackstopHalt(draft, group, refused);
      break;
    }

    switch (decision.kind) {
      case "idle":
      case "halt":
        break;
      case "activate": {
        const state = ensureLoopState(draft, group.id);
        state.activation = "running";
        state.activatedAt = options.now;
        state.boundaryInputs = resolveUpstreamInputs(
          draft,
          loopInstanceId(group.id, 1, group.entryContextId),
        );
        // Pass 1 was materialized by seed resolution; activation only admits it.
        state.passCount = Math.max(state.passCount, 1);
        // Seed resolution snapshots the template and clones pass 1 from it in
        // one call, so pass 1 always ran the FIRST version — including when a
        // quiescent template edit bumped the group before the loop activated.
        // That pass keeps the content it was materialized with (R11.2's
        // non-retroactive rule); the edit reaches pass 2 onwards.
        state.passTemplateVersions["1"] ??= SEED_TEMPLATE_VERSION;
        activatedLoopGroupIds.push(group.id);
        break;
      }
      case "skip": {
        const state = ensureLoopState(draft, group.id);
        state.activation = "skipped";
        state.settledAt = options.now;
        skippedLoopGroupIds.push(group.id);
        break;
      }
      case "conclude": {
        const state = ensureLoopState(draft, group.id);
        state.activation = "concluded";
        state.concludingExitContextId = decision.record.exitContextId;
        state.settledAt = options.now;
        state.decisions[String(decision.record.pass)] = decision.record;
        concludedLoopGroupIds.push(group.id);
        break;
      }
      case "materialize": {
        // `passCount` deliberately does NOT move with the grant: it counts
        // passes that exist, so a reservation whose unroll was refused leaves
        // the loop re-deciding the same pass and re-using this durable
        // reservation, rather than waiting forever on an exit instance that was
        // never created.
        materializations.push(decision.request);
        break;
      }
    }
  }

  // Ledger bookkeeping last, so a conclusion applied in THIS mutation already
  // releases the reservation of an unroll it will never install.
  const reconciled = reconcileLedgers(draft, groups);
  ledgerChanged ||= reconciled;

  return {
    ledgerChanged,
    activatedLoopGroupIds,
    skippedLoopGroupIds,
    concludedLoopGroupIds,
    materializations,
    halt,
  };
}

function reconcileLedgers(
  draft: GraphWorkflowExecution,
  groups: readonly GraphWorkflowResolvedLoopGroup[],
): boolean {
  let changed = false;
  for (const group of groups) {
    const state = draft.loopStates[group.id];
    if (!state) continue;
    const reconciled = reconcilePassSlots(draft, group, state);
    changed ||= reconciled;
  }
  return changed;
}

/**
 * One pass slot a loop needs granted before its decision may be applied, carrying
 * what the halt reports if the budget cannot reach it.
 */
interface SlotRequest {
  /** The pass the slot admits. */
  readonly pass: number;
  /** The pass the halt names — for an unroll, the pass that decided it. */
  readonly haltPass: number;
  readonly haltContextId: string;
  /** Null when no verdict stands behind the request (activation, re-admission). */
  readonly verdict: "unsatisfied" | null;
  /** How the halt describes what the loop could not do. */
  readonly action: string;
}

/**
 * The slots this loop needs from the shared budget, in the order it needs them.
 *
 * Two kinds, and a loop can want both only in the pathological case where a
 * released pass is also the one being decided:
 *
 *  - **re-admission** of a pass whose instances exist but whose grant was
 *    released (a scheduling batch that never formed — decision D7). The retry
 *    has to be re-admitted rather than assumed, or the execution could exceed
 *    the backstop by a pass per failed batch.
 *  - the **decision's own** pass: activation admits pass 1, an unroll admits the
 *    next one. A pass already holding a live grant asks for nothing.
 */
function slotRequests(
  draft: GraphWorkflowExecution,
  group: GraphWorkflowResolvedLoopGroup,
  decision: LoopDecision,
): SlotRequest[] {
  const requests: SlotRequest[] = [];
  const state = draft.loopStates[group.id];

  const reinstate = reinstatablePass(draft, group);
  if (reinstate !== null) {
    requests.push({
      pass: reinstate,
      haltPass: reinstate,
      haltContextId: loopInstanceId(group.id, reinstate, group.entryContextId),
      verdict: null,
      action: `re-admit pass ${reinstate}`,
    });
  }

  if (decision.kind === "activate" && !holdsLivePassSlot(state, 1)) {
    requests.push({
      pass: 1,
      haltPass: 1,
      haltContextId: loopInstanceId(group.id, 1, group.entryContextId),
      verdict: null,
      action: "start",
    });
  }

  if (
    decision.kind === "materialize" &&
    !holdsLivePassSlot(state, decision.request.nextPass)
  ) {
    requests.push({
      pass: decision.request.nextPass,
      haltPass: decision.request.pass,
      haltContextId: decision.request.exitContextId,
      verdict: "unsatisfied",
      action: `unroll pass ${decision.request.nextPass}`,
    });
  }

  return requests;
}

function executionBackstopHalt(
  draft: GraphWorkflowExecution,
  group: GraphWorkflowResolvedLoopGroup,
  request: SlotRequest,
): LoopHaltReason {
  const state = draft.loopStates[group.id];
  // Counted AFTER the grants this walk already made, so the halt reports the
  // budget as it actually stands: full.
  const live = livePassSlotCount(draft);
  return {
    type: "loop_limit_reached",
    scope: "execution",
    loopGroupId: group.id,
    pass: request.haltPass,
    maxPasses: group.maxPasses,
    verdict: request.verdict,
    passCount: state?.passCount ?? 0,
    totalPassCount: live,
    contextId: request.haltContextId,
    message:
      `Loop "${group.id}" cannot ${request.action}: this execution's ` +
      `${EXECUTION_TOTAL_PASS_BACKSTOP}-pass backstop has no slot left for it ` +
      `(${live} of ${EXECUTION_TOTAL_PASS_BACKSTOP} admitted). The backstop ` +
      `bounds every loop group together and is a hard constant — no operator, ` +
      `live edit or plan repair can raise it. Amend the exit predicates so the ` +
      `running loops conclude, or continue the remaining work in a new ` +
      `execution, then resume.`,
    // The plan-repair supervisor fills this in when it has spoken (R12).
    summary: null,
  };
}

function emptyOutcome(): LoopSettlementOutcome {
  return {
    ledgerChanged: false,
    activatedLoopGroupIds: [],
    skippedLoopGroupIds: [],
    concludedLoopGroupIds: [],
    materializations: [],
    halt: null,
  };
}

/**
 * One loop's decision. Pure: it reads the draft and returns what should happen,
 * so the caller can abandon the whole pass on a halt.
 */
function decideLoop(
  draft: GraphWorkflowExecution,
  group: GraphWorkflowResolvedLoopGroup,
  projection: ReturnType<typeof projectExecutionRoutes>,
  options: LoopSettlementOptions,
): LoopDecision {
  const state = draft.loopStates[group.id];
  const activation = state?.activation ?? "unstarted";
  if (activation === "concluded" || activation === "skipped") {
    return { kind: "idle" };
  }

  if (activation === "unstarted") {
    return decideActivation(draft, group, projection);
  }

  const pass = state?.passCount ?? 1;
  const exitContextId = loopInstanceId(group.id, pass, group.exitContextId);
  const exitState = draft.contextStates[exitContextId];

  // An ACTIVE loop whose exit was skipped has no verdict to settle on and no
  // safe default — refused at accept time by the reconvergence rule, so
  // reaching this means a live edit opened the branch (R9.6).
  if (exitState?.status === "skipped") {
    return {
      kind: "halt",
      halt: {
        type: "loop_exit_skipped",
        loopGroupId: group.id,
        pass,
        contextId: exitContextId,
        message:
          `Loop "${group.id}" pass ${pass} cannot be settled: its exit context ` +
          `"${exitContextId}" resolved skipped, so the until predicate has no ` +
          `verdict to read. Restore a route to the exit with a quiescent live ` +
          `edit — every branch inside a loop body must reconverge at the exit — ` +
          `then resume.`,
      },
    };
  }

  // Post-land (decision D8): the exit's work must be committed and lane-visible
  // before its capture is evidence of anything.
  if (exitState?.status !== "completed") return { kind: "idle" };
  if (!isRouteSourceLanded(draft, exitContextId)) return { kind: "idle" };

  const lookup = lookupRawContextOutput(
    {
      executionContexts: draft.workingDefinition.executionContexts,
      contextOutputs: draft.contextOutputs,
    },
    exitContextId,
  );
  if (lookup.kind !== "captured") {
    return {
      kind: "halt",
      halt: {
        type: "loop_invariant",
        loopGroupId: group.id,
        pass,
        contextId: exitContextId,
        reason: "exit-output-unevaluable",
        message:
          `Loop "${group.id}" pass ${pass} cannot be settled: its exit context ` +
          `"${exitContextId}" landed but its captured output is ${lookup.kind}, ` +
          `so the until predicate has no value to evaluate. Unrolling another ` +
          `pass on an unreadable exit would be a guess; restore the capture or ` +
          `amend the exit's output contract while quiescent, then resume.`,
      },
    };
  }

  const captureIteration =
    draft.contextOutputs[exitContextId]?.iteration ?? null;
  const already = state?.decisions[String(pass)];
  if (
    already &&
    already.loopControlRevision === (state?.loopControlRevision ?? 0) &&
    already.templateVersion === group.templateVersion &&
    already.exitCaptureIteration === captureIteration
  ) {
    // Already decided under this exact key. Re-deciding would unroll a second
    // copy of a pass the ledger has already admitted.
    return { kind: "idle" };
  }

  // The SAME evaluator every edge guard goes through: a loop predicate is a
  // guard over its exit's output, and a second one would be a second set of
  // rules.
  const satisfied = validateJsonSchemaSubset(
    group.until.schema,
    lookup.value,
  ).valid;

  const record: GraphWorkflowLoopDecisionRecord = {
    loopGroupId: group.id,
    pass,
    loopControlRevision: state?.loopControlRevision ?? 0,
    templateVersion: group.templateVersion,
    exitContextId,
    exitCaptureIteration: captureIteration,
    verdict: satisfied ? "satisfied" : "unsatisfied",
    outcome: satisfied ? "concluded" : "materialized",
    nextPass: satisfied ? null : pass + 1,
    decidedAt: options.now,
  };

  // Evaluation PRECEDES the limit check (R9.3): a satisfying verdict on the
  // final allowed pass completes the loop normally.
  if (satisfied) return { kind: "conclude", record };

  if (pass >= group.maxPasses) {
    return {
      kind: "halt",
      halt: {
        type: "loop_limit_reached",
        scope: "loop",
        loopGroupId: group.id,
        pass,
        maxPasses: group.maxPasses,
        // The exhaustion halt carries the verdict it exhausted on and the passes
        // that ran (R10.1): the halt itself records nothing durable, so this is
        // the only place an operator reads what the final pass actually decided.
        // Always `unsatisfied` here — a satisfying verdict on the final allowed
        // pass concludes above, before the limit is consulted (R9.3).
        verdict: "unsatisfied",
        passCount: state?.passCount ?? pass,
        totalPassCount: livePassSlotCount(draft),
        contextId: exitContextId,
        message:
          `Loop "${group.id}" reached its budget of ${group.maxPasses} pass(es) ` +
          `without satisfying its until predicate. There is no ` +
          `completion-on-exhaustion mode: raise the pass cap or amend the exit ` +
          `predicate while the execution is quiescent, then resume. Completed ` +
          `passes are never re-run.`,
        // The plan-repair supervisor fills this in when it has spoken (R12).
        summary: null,
      },
    };
  }

  return {
    kind: "materialize",
    record,
    request: {
      loopGroupId: group.id,
      pass,
      nextPass: pass + 1,
      loopControlRevision: record.loopControlRevision,
      templateVersion: record.templateVersion,
      exitContextId,
      exitCaptureIteration: captureIteration,
    },
  };
}

/**
 * Whether the loop's external activation path resolved, and which way.
 *
 * Read off the PASS-1 ENTRY instance, which is where seed resolution retargeted
 * the incoming boundary edge: the loop is taken exactly when that instance's
 * routes are satisfied, and untaken exactly when they decline it. A loop whose
 * entry has already started or completed reads as active too — the restart
 * case, where the ledger is being rebuilt behind work that already ran.
 */
function decideActivation(
  draft: GraphWorkflowExecution,
  group: GraphWorkflowResolvedLoopGroup,
  projection: ReturnType<typeof projectExecutionRoutes>,
): LoopDecision {
  const entryContextId = loopInstanceId(group.id, 1, group.entryContextId);
  const entryStatus = draft.contextStates[entryContextId]?.status;

  // An untaken loop skips entirely with its body and raises no halt (R9.6).
  // The body instances are skipped by ordinary route settlement; the ledger
  // only records that the loop itself was never taken, which is what makes the
  // logical exit read as a skipped source to everything downstream.
  if (entryStatus === "skipped") return { kind: "skip" };

  if (entryStatus !== undefined && entryStatus !== "pending") {
    return { kind: "activate" };
  }
  return routeVerdict(projection, entryContextId).kind === "eligible"
    ? { kind: "activate" }
    : { kind: "idle" };
}

/**
 * Reserve one pass slot durably (decision D7). `grantOrder` is 1-based across
 * the whole ledger and is what makes the arbitration replayable: a restart
 * reading the ledger sees the same passes admitted in the same order.
 *
 * Idempotent while the grant is live, and the existing grant wins — a
 * materialization that was refused and re-decided keeps the order it was
 * originally admitted under.
 *
 * A RELEASED grant is re-admitted rather than kept, and takes a fresh order and
 * stamp: it was given back to the shared budget and re-arbitrated against the
 * budget as it stands now, which is exactly what "released slots are reusable"
 * has to mean for the ledger to keep replaying one order.
 */
function grantSlot(
  draft: GraphWorkflowExecution,
  state: GraphWorkflowLoopState,
  pass: number,
  now: string,
): boolean {
  const existing = state.slotLedger.find((slot) => slot.pass === pass);
  if (existing && existing.state !== "released") return false;
  if (existing) {
    existing.state = "reserved";
    existing.grantOrder = nextGrantOrder(draft);
    existing.grantedAt = now;
    return true;
  }
  state.slotLedger.push({
    pass,
    state: "reserved",
    grantOrder: nextGrantOrder(draft),
    grantedAt: now,
  });
  return true;
}

/**
 * The next grant order across EVERY loop, so the arbitration is a property of
 * the execution rather than of one group. Derived from the highest grant already
 * recorded rather than from a count, so a released slot cannot make a later
 * grant collide with an earlier one.
 */
function nextGrantOrder(draft: GraphWorkflowExecution): number {
  let highest = 0;
  for (const state of Object.values(draft.loopStates)) {
    for (const slot of state.slotLedger) {
      highest = Math.max(highest, slot.grantOrder);
    }
  }
  return highest + 1;
}

/**
 * Stage the next pass's unroll OUTSIDE the write queue.
 *
 * The whole batch is derived by the single `materialize-loop-pass` op from the
 * group's versioned template, so this function carries no id minting and no
 * clone policy of its own — exactly one place owns both.
 */
export function prepareLoopPassMaterialization(
  execution: GraphWorkflowExecution,
  request: LoopMaterializationRequest,
  deps: LiveEditDeps,
): PrepareLiveExecutionEditsResult {
  return prepareLiveExecutionEdits(
    execution,
    {
      operations: [
        {
          type: "materialize-loop-pass",
          loopGroupId: request.loopGroupId,
          pass: request.nextPass,
        },
      ],
    },
    deps,
    { engineLoopSettlement: true },
  );
}

export type FinalizeLoopPassMaterializationResult =
  | {
      ok: true;
      install: "spliced" | "merged";
      execution: GraphWorkflowExecution;
    }
  | Exclude<FinalizePreparedEditsResult, { ok: true }>
  | { ok: false; outcome: "superseded" };

/**
 * Install the staged unroll and record its ledger entry in ONE mutation.
 *
 * The reservation, the clone and the decision record commit together: a graph
 * carrying pass K+1 with no record of why it exists would be re-decided on the
 * next pass and unrolled again.
 *
 * `superseded` means the ledger already admitted this pass while the batch was
 * staged — a retried reducer, or a settlement that ran twice. Nothing installs
 * and the caller simply drops the request; the next pass re-decides from
 * current state.
 */
export function finalizeLoopPassMaterialization(
  draft: GraphWorkflowExecution,
  prepared: PreparedLiveEdits,
  request: LoopMaterializationRequest,
  options: LoopSettlementOptions,
): FinalizeLoopPassMaterializationResult {
  const current = draft.loopStates[request.loopGroupId];
  if (!current || current.activation !== "running") {
    return { ok: false, outcome: "superseded" };
  }
  if (current.passCount >= request.nextPass) {
    return { ok: false, outcome: "superseded" };
  }

  const installed = finalizePreparedEdits(draft, prepared);
  if (!installed.ok) return installed;

  // The splice path hands back the deeply frozen prepared state, so the ledger
  // write rebuilds the one loop entry it touches rather than mutating in place.
  // O(one loop group) either way — nothing else is copied.
  const execution: GraphWorkflowExecution = {
    ...installed.execution,
    loopStates: { ...installed.execution.loopStates },
  };
  const state: GraphWorkflowLoopState = {
    ...current,
    slotLedger: [...current.slotLedger],
    decisions: { ...current.decisions },
    passTemplateVersions: { ...current.passTemplateVersions },
  };
  execution.loopStates[request.loopGroupId] = state;

  state.decisions[String(request.pass)] = {
    loopGroupId: request.loopGroupId,
    pass: request.pass,
    loopControlRevision: request.loopControlRevision,
    templateVersion: request.templateVersion,
    exitContextId: request.exitContextId,
    exitCaptureIteration: request.exitCaptureIteration,
    verdict: "unsatisfied",
    outcome: "materialized",
    nextPass: request.nextPass,
    decidedAt: options.now,
  };
  // The reservation was admitted in the settlement pass that decided this
  // unroll; re-granting is a no-op that only covers a ledger rebuilt behind an
  // already-staged batch. `passCount` moves HERE, because the pass now exists.
  grantSlot(execution, state, request.nextPass, options.now);
  state.passCount = Math.max(state.passCount, request.nextPass);
  // The version this pass CLONED (R11.2). `request.templateVersion` is what the
  // op derived the batch from: a template edit demands quiescence and the
  // engine cannot settle while paused or halted, so no edit can slip between
  // the decision that recorded it and the prepare that cloned under it.
  state.passTemplateVersions[String(request.nextPass)] =
    request.templateVersion;

  return { ok: true, install: installed.install, execution };
}
