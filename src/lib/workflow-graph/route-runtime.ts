/**
 * The engine's seam onto the pure route projection (D4 R2/R3/R4, decisions D4
 * and D8).
 *
 * `route-projection.ts` decides ROUTES over structural inputs and stays
 * browser-safe; `execution-routes.ts` marshals a running execution into it and
 * `lane-readiness.ts` owns the land gate. This module is the half only the
 * engine can own: it APPLIES what those three report — the terminal `skipped`
 * status, the bounded route-settlement markers, the two typed resumable routing
 * halts — and owns the landing-intent lifecycle those decisions wait on.
 *
 * Route semantics are NOT re-derived here. Everything this module applies comes
 * from the projection; what it adds is durability and the composition with
 * lane/merge state.
 */

import {
  incomingRoutes,
  type RouteCardinalityOutcome,
  type RouteEdgeEvaluation,
  type RouteProjection,
} from "@/lib/workflow-graph/route-projection";
import { projectExecutionRoutes } from "@/lib/workflow-graph/execution-routes";
import {
  collectLandGatedSkips,
  isContextOutputCommittedToLane,
  isRouteSourceLanded,
} from "@/lib/workflow-graph/lane-readiness";
import { skipContext } from "@/lib/workflow-graph/context-transitions";
import type {
  GraphWorkflowCanonicalOwnership,
  GraphWorkflowExecution,
  GraphWorkflowHaltReason,
  GraphWorkflowLandingIntent,
  GraphWorkflowRouteSettlement,
} from "@/lib/workflow-graph/schemas";

// ============================================================
// Landing intents (decision D8)
// ============================================================

/**
 * The token a committer embeds in the commit message so the landing is
 * replayable from the branch alone. The nonce is minted once when the intent
 * is recorded and persisted with it: a reset may restart the attempt counter,
 * but must never reuse an earlier intent's identity.
 */
export function landingIntentToken(
  executionId: string,
  contextId: string,
  attempt: number,
): string {
  return `cc-landing:${executionId}:${contextId}:${attempt}:${crypto.randomUUID()}`;
}

/** The trailer form the committers append; also what reconciliation greps for. */
export function landingIntentTrailer(token: string): string {
  return `Landing-Intent: ${token}`;
}

export interface RecordLandingIntentInput {
  mode: GraphWorkflowLandingIntent["mode"];
  laneId?: string | null;
  worktreePath?: string | null;
  baselineSha?: string | null;
  joinId?: string | null;
  now: string;
}

/**
 * Record a context's landing intent at DISPATCH — the same mutation that
 * assigns its lane — so no landing evidence ever exists only in memory and a
 * restart classifies from durable state instead of guessing.
 */
export function recordLandingIntent(
  draft: GraphWorkflowExecution,
  contextId: string,
  input: RecordLandingIntentInput,
): GraphWorkflowLandingIntent {
  const state = draft.contextStates[contextId];
  if (!state) {
    throw new Error(
      `recordLandingIntent: execution context "${contextId}" has no state (executionId=${draft.id})`,
    );
  }
  const attempt = (state.landingIntent?.attempt ?? 0) + 1;
  const intent: GraphWorkflowLandingIntent = {
    mode: input.mode,
    attempt,
    token: landingIntentToken(draft.id, contextId, attempt),
    laneId: input.laneId ?? null,
    worktreePath: input.worktreePath ?? null,
    baselineSha: input.baselineSha ?? null,
    headSha: null,
    joinId: input.joinId ?? null,
    state: "pending",
    evidence: null,
    recordedAt: input.now,
    settledAt: null,
  };
  state.landingIntent = intent;
  return intent;
}

export interface SettleLandingIntentInput {
  state: "landed" | "failed";
  evidence?: GraphWorkflowLandingIntent["evidence"];
  headSha?: string | null;
  joinId?: string | null;
  now: string;
}

/**
 * Settle a recorded intent with the evidence the landing produced. A no-op when
 * the context was dispatched before intents existed — the committed-to-lane
 * predicate still carries those runs.
 */
export function settleLandingIntent(
  draft: GraphWorkflowExecution,
  contextId: string,
  input: SettleLandingIntentInput,
): void {
  const intent = draft.contextStates[contextId]?.landingIntent;
  if (!intent) return;
  draft.contextStates[contextId]!.landingIntent = {
    ...intent,
    state: input.state,
    evidence: input.evidence ?? intent.evidence,
    headSha: input.headSha ?? intent.headSha,
    joinId: input.joinId ?? intent.joinId,
    settledAt: input.now,
  };
}

/**
 * The facts a landing branch can still be asked for after a crash — never a
 * verdict. Gathered outside the write queue (git is I/O) and handed to
 * {@link reconcileLandingIntents}, which is the only place they are classified.
 */
export interface LandingBranchEvidence {
  /** The branch's current head, or null when it could not be resolved. */
  readonly headSha: string | null;
  /** The commit carrying `Landing-Intent: <token>`, or null when absent. */
  readonly tokenCommitSha: string | null;
  /**
   * Whether the intent's recorded `baselineSha` is an ancestor of head. Without
   * it the recorded range spans nothing verifiable — a rewritten or replaced
   * branch, not this context's work.
   */
  readonly baselineReachable: boolean;
}

/** What a prober needs to read one context's landing branch. */
export interface LandingProbeTarget {
  readonly contextId: string;
  readonly token: string;
  readonly worktreePath: string;
  readonly baselineSha: string | null;
}

export interface ReconcileLandingIntentsOptions {
  now: string;
  /**
   * Branch facts by context id, for the commit modes. An intent with no entry
   * is left where it is: promotion without mode-specific replay evidence would
   * be exactly the guess decision D8 removes.
   */
  branchEvidence?: ReadonlyMap<string, LandingBranchEvidence>;
}

/**
 * The unlanded commit-mode intents whose branches are worth probing.
 *
 * `fan_in_merge` is excluded on purpose — its evidence is the join's own
 * durable record, which needs no git — and so is a landed intent, which is
 * settled history. A context that has not completed is excluded too: a landing
 * cannot precede the work it lands, and this set is probed on every scheduling
 * pass, so it has to be empty whenever there is nothing to learn.
 */
export function collectLandingProbeTargets(
  execution: GraphWorkflowExecution,
): LandingProbeTarget[] {
  const targets: LandingProbeTarget[] = [];
  for (const state of Object.values(execution.contextStates)) {
    const intent = state.landingIntent;
    if (!intent || intent.state === "landed") continue;
    if (intent.mode === "fan_in_merge") continue;
    if (state.status !== "completed") continue;

    // The lane record wins where there is one: it is where the branch lives
    // NOW, while the intent's copy is where it lived at dispatch.
    const lane =
      intent.laneId !== null
        ? execution.executionLanes[intent.laneId]
        : undefined;
    const worktreePath =
      lane?.worktreePath ?? intent.worktreePath ?? state.worktreePath;
    if (worktreePath === null) continue;

    targets.push({
      contextId: state.contextId,
      token: intent.token,
      worktreePath,
      baselineSha: intent.baselineSha,
    });
  }
  return targets;
}

/**
 * A commit the engine still owes for work that is already finished.
 *
 * The lane variant carries everything the committer needs, so a caller never
 * re-derives a worktree or re-narrows a null: a `lane_commit` repair that could
 * not resolve its branch is not reported at all. A `solo_commit` repair carries
 * only its baseline, because the session worktree is resolved at commit time.
 */
export type LandingCommitRepairTarget =
  | {
      readonly contextId: string;
      readonly mode: "lane_commit";
      readonly laneId: string;
      readonly worktreePath: string;
      readonly branchName: string;
      readonly baselineSha: string | null;
    }
  | {
      readonly contextId: string;
      readonly mode: "solo_commit";
      readonly baselineSha: string | null;
    };

/**
 * The completed contexts whose commit never ran (D4 R9.4).
 *
 * {@link collectLandingProbeTargets} repairs the crash BETWEEN the commit and
 * the mutation that records it — the branch carries the evidence and
 * reconciliation reads it back. This is the earlier window, which no probe can
 * fix: the context completed and the process died before the commit phase, so
 * there is nothing on the branch at all. Since only a landed intent satisfies
 * routing (decision D8), leaving it would block every dependent — and every
 * loop settling on it — on a commit that will never come. The resumed engine
 * owes the commit, and re-running it is safe precisely because the committers
 * are idempotent against a branch that already carries the work.
 *
 * Deliberately narrow:
 *
 *  - `pending` only. A `failed` intent already recorded a halt, and retrying it
 *    unasked would re-halt the resume the operator just performed.
 *  - Historical `fan_in_merge` evidence is excluded: it cannot be repaired by
 *    the current lane or solo committers.
 *  - A landing cannot precede the work it lands, so an unfinished context is
 *    never repaired.
 *
 * The LANE record wins over the intent's dispatch-time copy for the branch and
 * worktree, exactly as the probe set resolves them: the intent records where the
 * lane lived at dispatch, the lane records where it lives now.
 */
export function collectLandingCommitRepairs(
  execution: GraphWorkflowExecution,
): LandingCommitRepairTarget[] {
  const repairs: LandingCommitRepairTarget[] = [];
  for (const state of Object.values(execution.contextStates)) {
    const intent = state.landingIntent;
    if (!intent || intent.state !== "pending") continue;
    if (intent.mode === "fan_in_merge") continue;
    if (state.status !== "completed") continue;

    if (intent.mode === "solo_commit") {
      repairs.push({
        contextId: state.contextId,
        mode: "solo_commit",
        baselineSha: intent.baselineSha,
      });
      continue;
    }

    const lane =
      intent.laneId !== null
        ? execution.executionLanes[intent.laneId]
        : undefined;
    const laneId = intent.laneId;
    const worktreePath =
      lane?.worktreePath ?? intent.worktreePath ?? state.worktreePath;
    const branchName = lane?.branchName ?? state.branchName;
    if (laneId === null || worktreePath === null || branchName === null)
      continue;
    repairs.push({
      contextId: state.contextId,
      mode: "lane_commit",
      laneId,
      worktreePath,
      branchName,
      baselineSha: intent.baselineSha,
    });
  }
  return repairs;
}

/** How an intent should read after reconciliation, or null to leave it alone. */
type LandingClassification = Pick<
  SettleLandingIntentInput,
  "state" | "evidence" | "headSha" | "joinId"
>;

/**
 * Bring unsettled intents back in line with the durable landing evidence, at
 * resume and on every settlement pass.
 *
 * A crash between the commit and the intent's settlement leaves an intent
 * `pending` over work that is already committed; a fan-in merge that failed
 * leaves one `failed` over work that lands as soon as the retry succeeds. Both
 * directions are decided here from state that outlived the crash, so a `failed`
 * intent is re-examined every pass rather than latched — a successful merge
 * retry moves the merge status and nothing else, and dependents that stayed
 * blocked on a stale refusal would never be released.
 *
 * Evidence is mode-specific (decision D8). `fan_in_merge` reconciles against
 * the join record; `lane_commit` and `solo_commit` need the branch facts in
 * `options.branchEvidence`, because lifecycle bookkeeping such as a lane's
 * `includedContextIds` records that the commit phase was ENTERED, not that it
 * produced a landing.
 *
 * Returns the context ids whose intents actually moved. An intent whose
 * classification matches its current state is left untouched, so the
 * per-pass call neither churns the blob nor re-reports a decided landing.
 */
export function reconcileLandingIntents(
  draft: GraphWorkflowExecution,
  options: ReconcileLandingIntentsOptions,
): string[] {
  const reconciled: string[] = [];
  for (const state of Object.values(draft.contextStates)) {
    const intent = state.landingIntent;
    // `landed` is terminal: the evidence that produced it cannot be withdrawn
    // by a later pass, and re-deciding it would let a lane rewrite unland
    // work whose dependents have already consumed it.
    if (!intent || intent.state === "landed") continue;

    const classification = classifyLanding(
      draft,
      state.contextId,
      intent,
      options.branchEvidence?.get(state.contextId),
    );
    if (!classification || classification.state === intent.state) continue;

    settleLandingIntent(draft, state.contextId, {
      ...classification,
      now: options.now,
    });
    reconciled.push(state.contextId);
  }
  return reconciled;
}

function classifyLanding(
  draft: GraphWorkflowExecution,
  contextId: string,
  intent: GraphWorkflowLandingIntent,
  evidence: LandingBranchEvidence | undefined,
): LandingClassification | null {
  const state = draft.contextStates[contextId];
  if (!state) return null;

  // A fan-in landing is decided by the JOIN's own durable record, which is
  // where the merge outcome actually lives; the context's merge status is a
  // projection of it and can lag a crash.
  const join =
    intent.mode === "fan_in_merge" && state.joinId !== null
      ? draft.joins[state.joinId]
      : undefined;
  const joinFields = join ? { joinId: join.joinId } : {};

  if (join?.status === "failed") {
    return { state: "failed", evidence: "join-merge", ...joinFields };
  }
  if (
    state.mergeStatus === "merged-failed" ||
    state.mergeStatus === "conflicts"
  ) {
    return {
      state: "failed",
      evidence: intent.mode === "fan_in_merge" ? "join-merge" : "commit",
      ...joinFields,
    };
  }

  // A landing cannot precede the work it lands.
  if (state.status !== "completed") return null;

  if (intent.mode === "fan_in_merge") {
    // A merge landing is claimed only on positive evidence that the merge ran:
    // the join's own succeeded record, or the merged-success a retry leaves
    // behind. The absence of a failure is not a landing, and a refusal already
    // recorded is withdrawn by nothing less.
    if (!isContextOutputCommittedToLane(state, draft)) return null;
    const merged =
      join?.status === "succeeded" || state.mergeStatus === "merged-success";
    return merged
      ? { state: "landed", evidence: "join-merge", ...joinFields }
      : null;
  }

  // For the commit modes the BRANCH is the evidence (decision D8), and it
  // outranks the lifecycle bookkeeping: a crash between the commit and the
  // mutation that records it leaves the trailer on the branch and the lane's
  // `includedContextIds` empty, which is precisely the case the token exists
  // to replay.
  return classifyCommitLanding(
    intent,
    evidence,
    sharesLaneWithSiblings(state.reservedOwnership),
  );
}

/**
 * Whether this context's HEAD moves may belong to someone else.
 *
 * Range-based adoption reads "HEAD moved past my baseline" as "I committed
 * that". On a lane one context holds alone the inference is sound. Under an
 * ownership envelope it is not: siblings land into the same branch, so a moved
 * HEAD is at least as likely to be theirs — and an enveloped context cannot
 * have authored a commit anyway, since the envelope denies it `.git`. A
 * read-only member commits nothing by definition, so every move it sees is a
 * sibling's.
 */
function sharesLaneWithSiblings(
  ownership: GraphWorkflowCanonicalOwnership | null | undefined,
): boolean {
  return ownership?.mode === "owned" || ownership?.mode === "readOnly";
}

/**
 * The replay a `lane_commit` or `solo_commit` landing has to survive: either
 * the deterministic token is on the branch, or the recorded baseline → head
 * range accounts for the landing on its own.
 */
function classifyCommitLanding(
  intent: GraphWorkflowLandingIntent,
  evidence: LandingBranchEvidence | undefined,
  laneIsShared: boolean,
): LandingClassification | null {
  if (!evidence) return null;

  if (evidence.tokenCommitSha !== null) {
    return {
      state: "landed",
      evidence: "commit",
      headSha: evidence.headSha ?? evidence.tokenCommitSha,
    };
  }

  // No token, and the branch is shared: nothing here names THIS context, so the
  // intent stays pending and the resumed engine re-runs its landing. That is
  // safe to do unconditionally because the pathspec landing is idempotent —
  // work already on the branch produces an identical tree and no second commit.
  if (laneIsShared) return null;

  // No token: the implementer authored the commit itself, or there was nothing
  // to commit. Both are claims about the recorded range, so an unrecorded or
  // unreachable baseline decides nothing.
  if (intent.baselineSha === null || evidence.headSha === null) return null;
  if (!evidence.baselineReachable) return null;

  return evidence.headSha === intent.baselineSha
    ? { state: "landed", evidence: "no-changes", headSha: evidence.headSha }
    : { state: "landed", evidence: "adopted-head", headSha: evidence.headSha };
}

// ============================================================
// Route settlement
// ============================================================

/**
 * The two halts routing can raise, narrowed out of the halt union so callers
 * can read the offending `contextId` without re-discriminating.
 */
export type RoutingHaltReason = Extract<
  GraphWorkflowHaltReason,
  { type: "routing_cardinality" | "routing_invariant" }
>;

export interface RouteSettlementOutcome {
  /** Contexts this pass transitioned to the terminal `skipped` status. */
  readonly skippedContextIds: readonly string[];
  /** Sources whose bounded settlement marker this pass wrote. */
  readonly settledSourceContextIds: readonly string[];
  /** Landing intents this pass reconciled against durable evidence. */
  readonly reconciledContextIds: readonly string[];
  /**
   * The typed resumable routing halt this pass found, or null. A halt applies
   * NOTHING: routing on a graph the engine cannot resolve is exactly the guess
   * R2.4/R3.1 forbid.
   */
  readonly halt: RoutingHaltReason | null;
}

/**
 * Settle every route the graph can currently decide, in one mutation.
 *
 * Order matters and is the whole contract:
 *  1. reconcile landing intents, so the land-gate reads current evidence;
 *  2. project the routes and derive the land-gated skip set once;
 *  3. look for a routing halt and, if there is one, apply nothing;
 *  4. apply the land-gated skips;
 *  5. write the bounded per-source settlement markers, on the same gate.
 *
 * Called inside `mutateActive` by the scheduler, so the skip transition, the
 * settlement marker and the route-resolved event all commit together. The
 * caller supplies `branchEvidence` gathered outside the write queue, which is
 * what lets step 1 promote a commit-mode intent here rather than only at
 * restart — without it an unproven landing simply blocks (decision D8).
 */
export function settleRoutes(
  draft: GraphWorkflowExecution,
  options: ReconcileLandingIntentsOptions,
): RouteSettlementOutcome {
  const reconciledContextIds = reconcileLandingIntents(draft, options);
  const projection = projectExecutionRoutes(draft);

  // One land-gated skip set for the whole pass: the halts, the skips it
  // applies and the markers it writes all read it, and publish quiescence
  // reads the same predicate, so no consumer can settle ahead of the evidence.
  const settledSkipIds = collectLandGatedSkips(draft, projection);
  const sourceSettled = (contextId: string): boolean =>
    settledSkipIds.has(contextId) || isRouteSourceLanded(draft, contextId);

  const halt = findRoutingHalt(draft, projection, sourceSettled);
  if (halt) {
    return {
      skippedContextIds: [],
      settledSourceContextIds: [],
      reconciledContextIds,
      halt,
    };
  }

  const skippedContextIds = applySkips(
    draft,
    projection,
    settledSkipIds,
    options,
  );
  const settledSourceContextIds = writeRouteSettlements(
    draft,
    projection,
    sourceSettled,
    options,
  );

  return {
    skippedContextIds,
    settledSourceContextIds,
    reconciledContextIds,
    halt: null,
  };
}

/**
 * The first decidable routing halt, in definition order so a resume re-derives
 * the same one. Both variants are gated on the source having landed: while a
 * merge is unresolved the graph has not finished producing the evidence the
 * halt would describe.
 */
function findRoutingHalt(
  draft: GraphWorkflowExecution,
  projection: RouteProjection,
  sourceSettled: (contextId: string) => boolean,
): RoutingHaltReason | null {
  for (const context of draft.workingDefinition.executionContexts) {
    const status = draft.contextStates[context.id]?.status;
    // A settled target is history: its routes were decided when it ran, and
    // re-halting on them would strand a finished execution.
    if (status === "completed" || status === "skipped") continue;
    const verdict = projection.verdictByContextId.get(context.id);
    if (verdict?.kind !== "halt") continue;

    const sourceContextIds: string[] = [];
    let landed = true;
    for (const edge of incomingRoutes(projection, context.id)) {
      if (edge.resolution.kind !== "unevaluable") continue;
      const sourceId = edge.effectiveSourceId ?? edge.logicalSourceId;
      // Deferred, not dismissed: an unlanded source is still producing the
      // evidence this halt would describe. Other contexts are still considered
      // in this pass, so one waiting fan-in cannot mask a decidable halt.
      if (!sourceSettled(sourceId)) landed = false;
      if (!sourceContextIds.includes(sourceId)) sourceContextIds.push(sourceId);
    }
    if (!landed) continue;

    return {
      type: "routing_invariant",
      contextId: context.id,
      reason: "guard-unevaluable",
      edgeIds: [...verdict.edgeIds],
      sourceContextIds,
      message:
        `Context "${context.id}" cannot be routed: ${verdict.edgeIds.length} incoming ` +
        `conditional edge(s) (${verdict.edgeIds.join(", ")}) have a completed source ` +
        `whose captured output cannot be read, so the guard has no value to evaluate. ` +
        `The sanctioned remedy is a quiescent live edit of this context's incoming ` +
        `edges — amend or remove the guard — followed by resume; the completed source ` +
        `is never edited and the guard is never evaluated as false.`,
    };
  }

  for (const outcome of projection.cardinality) {
    if (
      outcome.outcome !== "under-selection" &&
      outcome.outcome !== "over-selection"
    ) {
      continue;
    }
    if (outcome.policy === "independent") continue;
    if (!sourceSettled(outcome.sourceContextId)) continue;
    return cardinalityHalt(outcome);
  }

  return null;
}

function cardinalityHalt(outcome: RouteCardinalityOutcome): RoutingHaltReason {
  const policy = outcome.policy === "exactlyOne" ? "exactlyOne" : "atLeastOne";
  const selected =
    outcome.activatedEdgeIds.length === 0
      ? "no outgoing branch"
      : `${outcome.activatedEdgeIds.length} outgoing branches (${outcome.activatedEdgeIds.join(", ")})`;
  return {
    type: "routing_cardinality",
    contextId: outcome.sourceContextId,
    policy,
    outcome:
      outcome.outcome === "over-selection"
        ? "over-selection"
        : "under-selection",
    conditionalEdgeIds: [...outcome.conditionalEdgeIds],
    activatedEdgeIds: [...outcome.activatedEdgeIds],
    message:
      `Context "${outcome.sourceContextId}" declares routing cardinality "${policy}" ` +
      `but its captured output activated ${selected} out of ` +
      `${outcome.conditionalEdgeIds.length} conditional edge(s) ` +
      `(${outcome.conditionalEdgeIds.join(", ")}). Amend the guard set or the ` +
      `cardinality policy with a quiescent live edit, then resume.`,
  };
}

/**
 * Apply the land-gated skip verdicts to the contexts that can carry them.
 *
 * `settledSkipIds` is the routing half — the projection's skip verdict, gated
 * on every incoming edge's source having settled and, when it settled
 * completed, LANDED (R2.5): a completed-but-unmerged source blocks the target
 * rather than skipping it. What is left here is the status gate from the
 * transition legality table (`pending`/`ready` only): a started context holds a
 * lane and work on disk that a route verdict may not discard.
 */
function applySkips(
  draft: GraphWorkflowExecution,
  projection: RouteProjection,
  settledSkipIds: ReadonlySet<string>,
  options: { now: string },
): string[] {
  const skipped: string[] = [];
  for (const context of draft.workingDefinition.executionContexts) {
    const state = draft.contextStates[context.id];
    if (!state) continue;
    if (state.status !== "pending" && state.status !== "ready") continue;
    if (!settledSkipIds.has(context.id)) continue;

    const verdict = projection.verdictByContextId.get(context.id);
    if (verdict?.kind !== "skip") continue;

    skipContext(
      draft,
      context.id,
      {
        edgeEvaluations: verdict.edgeEvaluations.map(
          (evaluation: RouteEdgeEvaluation) => ({ ...evaluation }),
        ),
        at: options.now,
      },
      { reason: "route.settlement.branch_not_taken" },
    );
    skipped.push(context.id);
  }
  return skipped;
}

/**
 * Write the bounded current settlement marker for every source whose routes are
 * decided, exactly once per `(source, effectiveSource, captureIteration, routeControlRevision)`.
 *
 * Only sources carrying a conditional outgoing edge get a marker: an
 * unconditional graph makes no routing decision worth recording, and writing
 * one anyway would break the dormant-by-default floor (R14.1).
 *
 * A marker is a durable claim that the source's outgoing routes are decided,
 * so it rides the same land gate the skips do — writing one for a source whose
 * landing is unproven would publish a decision the evidence does not support.
 */
function writeRouteSettlements(
  draft: GraphWorkflowExecution,
  projection: RouteProjection,
  sourceSettled: (contextId: string) => boolean,
  options: { now: string },
): string[] {
  const settled: string[] = [];
  for (const sourceContextId of projection.settlementByContextId.keys()) {
    const outgoing = projection.edges.filter(
      (edge) => edge.logicalSourceId === sourceContextId,
    );
    if (!outgoing.some((edge) => edge.guard !== "none")) continue;

    const effectiveSourceContextId = outgoing[0]?.effectiveSourceId ?? null;
    if (!sourceSettled(effectiveSourceContextId ?? sourceContextId)) continue;
    if (
      outgoing.some(
        (edge) =>
          edge.resolution.kind === "unresolved" ||
          edge.resolution.kind === "unevaluable",
      )
    )
      continue;

    const record: GraphWorkflowRouteSettlement = {
      sourceContextId,
      effectiveSourceContextId,
      captureIteration: effectiveSourceContextId
        ? (draft.contextOutputs[effectiveSourceContextId]?.iteration ?? null)
        : null,
      routeControlRevision: draft.routeControlRevisions[sourceContextId] ?? 0,
      edgeEvaluations: outgoing.flatMap((edge) => {
        const verdict = edge.resolution.kind;
        return verdict === "active" ||
          verdict === "inactive" ||
          verdict === "omitted"
          ? [{ edgeId: edge.edgeId, verdict }]
          : [];
      }),
      activatedEdgeIds: outgoing
        .filter((edge) => edge.resolution.kind === "active")
        .map((edge) => edge.edgeId),
      inactiveEdgeIds: outgoing
        .filter((edge) => edge.resolution.kind === "inactive")
        .map((edge) => edge.edgeId),
      omittedEdgeIds: outgoing
        .filter((edge) => edge.resolution.kind === "omitted")
        .map((edge) => edge.edgeId),
      settledAt: options.now,
    };

    const existing = draft.routeSettlements[sourceContextId];
    if (
      existing &&
      existing.effectiveSourceContextId === record.effectiveSourceContextId &&
      existing.captureIteration === record.captureIteration &&
      existing.routeControlRevision === record.routeControlRevision
    ) {
      continue;
    }
    draft.routeSettlements[sourceContextId] = record;
    settled.push(sourceContextId);
  }
  return settled;
}
