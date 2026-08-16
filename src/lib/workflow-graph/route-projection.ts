/**
 * The one control-flow projection (D4 R1/R2/R3, decision D1).
 *
 * Guard resolution, skip propagation, active-dependency selection, cardinality
 * outcomes, the must-run set and publish settlement are decided HERE and nowhere
 * else. The scheduler, lane readiness, joins, upstream-input resolution,
 * completion, the final publish, the CLI outline and the graph UI all derive
 * from this module rather than re-implementing route semantics — that single
 * site is what makes "would this context run?" answerable identically in the
 * engine and in a browser tab.
 *
 * The rule is uniform and conjunctive: a context is eligible when EVERY incoming
 * edge is satisfied. An unconditional edge is satisfied when its source settles
 * completed, and is OMITTED when its source is skipped; a conditional edge is
 * satisfied when its guard evaluates true over the completed source's captured
 * output, and resolves FALSE — skipping the target — when it does not, or when
 * its source is skipped. Conditional edges are not a special veto class and a
 * sibling edge's satisfaction never overrides an unsatisfied guard; the
 * asymmetry between "omitted" and "inactive" is the whole reconciliation between
 * single-active-branch fan-ins and the conjunctive rule.
 *
 * What this module deliberately does NOT decide: the land-gate. A satisfied edge
 * says the route is taken, not that the source's work is committed and
 * lane-visible; the scheduler ANDs this projection with that check, which keeps
 * lane and merge state out of a module the browser imports.
 *
 * Pure and browser-safe: structural inputs, no engine or persistence types, and
 * the only value import is the shared schema-subset evaluator every guard is
 * required to go through.
 */

import type { EdgeGuardDeclaration } from "@/lib/workflow-graph/edge-guard-validation";
import type { GraphWorkflowContextStatus } from "@/lib/workflow-graph/definition-schemas";
import {
  lookupRawContextOutput,
  type RawOutputLookupSource,
} from "@/lib/workflow-graph/output-lookup";
import { validateJsonSchemaSubset } from "@/lib/workflows/primitives/output-schema-subset";

// ============================================================
// Inputs
// ============================================================

/**
 * The context statuses this projection reads — the engine enum itself, which
 * now carries the terminal `skipped` status the projection derives.
 */
export type RouteProjectionContextStatus = GraphWorkflowContextStatus;

export type RouteCardinalityPolicy =
  | "independent"
  | "atLeastOne"
  | "exactlyOne";

export interface RouteProjectionContext {
  readonly id: string;
  readonly outputSchema?: Record<string, unknown> | undefined;
  readonly routing?:
    | { readonly cardinality?: RouteCardinalityPolicy }
    | undefined;
}

export interface RouteProjectionEdge {
  readonly id: string;
  readonly sourceContextId: string;
  readonly targetContextId: string;
  readonly when?: EdgeGuardDeclaration | undefined;
}

/**
 * A loop group as the projection needs to see it: which context is the declared
 * (logical) exit, which contexts are inside the body, whether the loop has
 * concluded, and — once it has — which pass instance actually concluded it.
 *
 * Structural rather than the loop schema, so the projection stays free of loop
 * persistence and the settlement transaction supplies its own view.
 */
export interface RouteProjectionLoop {
  readonly id: string;
  readonly exitContextId: string;
  readonly bodyContextIds: readonly string[];
  /**
   * The instance carrying the loop's ACTIVATION edge — the first pass's entry,
   * which is where seed resolution retargeted the incoming boundary edge. It is
   * never cloned, so this stays the first pass's entry for the loop's whole
   * life, and it is what decides whether the loop runs on every path.
   */
  readonly activationContextId: string;
  readonly activation: "unstarted" | "running" | "concluded" | "skipped";
  /** The concluding pass's exit instance; null until the loop concludes. */
  readonly concludingExitContextId: string | null;
}

export interface RouteProjectionInput<
  TOutput extends { value: Record<string, unknown> },
> {
  readonly executionContexts: readonly RouteProjectionContext[];
  readonly edges: readonly RouteProjectionEdge[];
  readonly contextStates: Readonly<
    Record<
      string,
      { readonly status: RouteProjectionContextStatus } | undefined
    >
  >;
  readonly contextOutputs: Readonly<Record<string, TOutput | undefined>>;
  readonly loops?: readonly RouteProjectionLoop[] | undefined;
}

// ============================================================
// Outputs
// ============================================================

/** Whether a context has reached a terminal routing state. */
export type RouteContextSettlement = "unsettled" | "completed" | "skipped";

/**
 * `unresolved` — the source has not settled (or an unconcluded loop is holding
 * its exit's external edges), so the target must wait.
 * `active` — satisfied; the edge is a real prerequisite carrying real data.
 * `inactive` — a guard resolved false; the target skips.
 * `omitted` — an unconditional edge whose source skipped; the edge drops out of
 * the conjunction instead of vetoing the target.
 * `unevaluable` — a completed conditional source whose output cannot be read.
 * Never evaluated as false: R2 requires a typed resumable invariant halt whose
 * sanctioned remedy is a quiescent live edit of the unstarted target's edges.
 */
export type RouteEdgeResolution =
  | { readonly kind: "unresolved" }
  | { readonly kind: "active" }
  | { readonly kind: "inactive" }
  | { readonly kind: "omitted" }
  | {
      readonly kind: "unevaluable";
      readonly reason: "pending" | "orphaned" | "none";
    };

/**
 * An edge as every consumer must read it (decision D1).
 *
 * `logicalSourceId` is the authored source — for a loop's external edges, the
 * declared exit context — and is what topology and rendering use.
 * `effectiveSourceId` is the context instance whose landed work and capture
 * actually satisfy the edge: the concluding pass's exit instance for a concluded
 * loop, the logical source for every ordinary edge, and null while unresolved.
 * Landing, lane visibility and injected data MUST follow the effective id;
 * reading the raw authored source would wait on a declared exit that never runs.
 */
export interface ResolvedRouteEdge {
  readonly edgeId: string;
  readonly logicalSourceId: string;
  readonly effectiveSourceId: string | null;
  readonly targetContextId: string;
  readonly guard: "none" | "schema" | "else";
  readonly resolution: RouteEdgeResolution;
}

/** One edge's contribution to a skip, as persisted in the skip reason. */
export interface RouteEdgeEvaluation {
  readonly edgeId: string;
  readonly verdict: "active" | "inactive" | "omitted";
}

/**
 * `waiting` — at least one incoming route has not resolved. A fan-in always
 * waits for every route before deciding, so a skip records the complete verdict
 * set rather than a partial one.
 * `halt` — a guard that cannot be evaluated; the engine raises the typed
 * resumable invariant halt rather than routing on a guess.
 */
export type RouteContextVerdict =
  | { readonly kind: "waiting" }
  | { readonly kind: "eligible" }
  | {
      readonly kind: "skip";
      readonly edgeEvaluations: readonly RouteEdgeEvaluation[];
    }
  | {
      readonly kind: "halt";
      readonly reason: "guard-unevaluable";
      readonly edgeIds: readonly string[];
    };

export interface RouteCardinalityOutcome {
  readonly sourceContextId: string;
  readonly policy: RouteCardinalityPolicy;
  readonly conditionalEdgeIds: readonly string[];
  readonly activatedEdgeIds: readonly string[];
  readonly outcome:
    | "unresolved"
    | "satisfied"
    | "under-selection"
    | "over-selection";
}

/**
 * What the final publish is still waiting for. A skipped context is settled with
 * nothing: it holds no lane, contributes no merge input, and owes no output, so
 * it neither blocks the publish nor appears among its inputs.
 */
export interface RoutePublishSettlement {
  readonly settled: boolean;
  readonly outstandingContextIds: readonly string[];
  readonly contributingContextIds: readonly string[];
  readonly skippedContextIds: readonly string[];
  /**
   * The subset of `outstandingContextIds` that are LOGICAL loop exits rather
   * than execution contexts — an unsettled loop's outstanding work, named
   * separately so a consumer that must explain the wait (the completion
   * invariant's halt) can distinguish "a context has not finished" from "a loop
   * has not reached its exit condition" without recomputing either.
   */
  readonly outstandingLoopExitContextIds: readonly string[];
}

export interface RouteProjection {
  /** Every edge, in definition order. */
  readonly edges: readonly ResolvedRouteEdge[];
  readonly settlementByContextId: ReadonlyMap<string, RouteContextSettlement>;
  readonly verdictByContextId: ReadonlyMap<string, RouteContextVerdict>;
  readonly cardinality: readonly RouteCardinalityOutcome[];
  /**
   * Contexts that run on every path through the graph: no direct conditional
   * guard, and either an entry context or reached by an unconditional edge from
   * another must-run context. Inductive on purpose — a direct-guard-only test
   * would call an unconditionally-reached descendant of a guarded branch
   * must-run, which is exactly the coverage a skip can silently take away.
   */
  readonly mustRunContextIds: ReadonlySet<string>;
  readonly publish: RoutePublishSettlement;
}

// ============================================================
// Projection
// ============================================================

export function projectRoutes<
  TOutput extends { value: Record<string, unknown> },
>(input: RouteProjectionInput<TOutput>): RouteProjection {
  const contextIds = input.executionContexts.map((context) => context.id);
  const contextById = new Map(
    input.executionContexts.map((context) => [context.id, context]),
  );
  const outputSource: RawOutputLookupSource<TOutput> = {
    executionContexts: input.executionContexts,
    contextOutputs: input.contextOutputs,
  };
  const loopByExitId = new Map(
    (input.loops ?? []).map((loop) => [loop.exitContextId, loop]),
  );

  const incoming = groupBy(input.edges, (edge) => edge.targetContextId);
  const outgoing = groupBy(input.edges, (edge) => edge.sourceContextId);

  // A loop's DECLARED exit is addressed by external edges but is not an
  // execution context — the body lives in per-pass instances instead — so the
  // walk has to visit it explicitly. Without this its outgoing edges are never
  // resolved and downstream waits on a node that is never going to run.
  const loopExitIds = new Set(loopByExitId.keys());
  const walkIds = [
    ...contextIds,
    ...[...loopExitIds].filter((id) => !contextById.has(id)),
  ];

  const settlement = new Map<string, RouteContextSettlement>();
  const verdicts = new Map<string, RouteContextVerdict>();
  const resolutionByEdgeId = new Map<string, ResolvedRouteEdge>();

  const dependencyOrder = orderTopologically(walkIds, input.edges);

  for (const contextId of dependencyOrder) {
    // Incoming edges were resolved when their sources were visited, so the
    // verdict — and the skip it may derive — is final before anything reads this
    // context as a source.
    const verdict = decideVerdict(contextId);
    verdicts.set(contextId, verdict);
    settlement.set(contextId, settleContext(contextId, verdict));

    // Outgoing edges resolve as one SET rather than one at a time: else
    // resolution and cardinality are both defined over a single source's edge
    // set, which is what makes them independent of declaration order (R1.3/R3).
    for (const resolved of resolveOutgoingEdges(
      outgoing.get(contextId) ?? [],
      contextId,
    )) {
      resolutionByEdgeId.set(resolved.edgeId, resolved);
    }
  }

  // An edge whose source is not a known context is never reached by the walk
  // above; it resolves against an unsettled source, which is what it is.
  const edges = input.edges.map(
    (edge) => resolutionByEdgeId.get(edge.id) ?? unresolvedEdge(edge),
  );

  return {
    edges,
    settlementByContextId: settlement,
    verdictByContextId: verdicts,
    cardinality: computeCardinality(),
    mustRunContextIds: computeMustRun(),
    publish: settlePublish(),
  };

  // ----------------------------------------------------------
  // Edge resolution
  // ----------------------------------------------------------

  /**
   * Resolves one source's whole outgoing edge set at once: an `else` edge is
   * defined by what its siblings did, so it cannot be decided edge-by-edge —
   * and doing it as a set is what makes the result independent of declaration
   * order (R1.3), first-match-wins having been ruled out by design.
   */
  function resolveOutgoingEdges(
    edges: readonly RouteProjectionEdge[],
    sourceContextId: string,
  ): ResolvedRouteEdge[] {
    const loop = loopByExitId.get(sourceContextId);

    const resolved = edges.map((edge) => {
      const view = resolveSourceView(edge, loop);
      return {
        edge,
        view,
        resolution: resolveEdge(edge, view),
      };
    });

    // The else edge activates exactly when no conditional sibling from the same
    // source activated. Siblings that could not be decided leave it undecided
    // too — an else fired on an incomplete sibling picture would be a fallback
    // taken while a real branch was still in play.
    const conditionalSiblings = resolved.filter(
      (entry) => guardKind(entry.edge) === "schema",
    );

    return resolved.map((entry) => {
      if (guardKind(entry.edge) !== "else") {
        return toResolvedEdge(entry.edge, entry.view, entry.resolution);
      }
      if (entry.resolution.kind !== "active") {
        // A skipped or unsettled source already decided the else edge the same
        // way it decided every other conditional edge from that source.
        return toResolvedEdge(entry.edge, entry.view, entry.resolution);
      }
      const unevaluable = conditionalSiblings.find(
        (sibling) => sibling.resolution.kind === "unevaluable",
      );
      if (unevaluable) {
        return toResolvedEdge(entry.edge, entry.view, unevaluable.resolution);
      }
      if (
        conditionalSiblings.some(
          (sibling) => sibling.resolution.kind === "unresolved",
        )
      ) {
        return toResolvedEdge(entry.edge, entry.view, { kind: "unresolved" });
      }
      const anyActivated = conditionalSiblings.some(
        (sibling) => sibling.resolution.kind === "active",
      );
      return toResolvedEdge(entry.edge, entry.view, {
        kind: anyActivated ? "inactive" : "active",
      });
    });
  }

  /**
   * Which context instance an edge actually reads, and whether that instance has
   * settled. For every ordinary edge this is the authored source. For a loop's
   * EXTERNAL outgoing edges it is the concluding pass's exit instance, and an
   * unconcluded loop holds them unresolved so downstream work cannot become
   * eligible in the landed-but-unsettled window.
   */
  function resolveSourceView(
    edge: RouteProjectionEdge,
    loop: RouteProjectionLoop | undefined,
  ): { effectiveSourceId: string | null; settlement: RouteContextSettlement } {
    const external =
      loop !== undefined && !loop.bodyContextIds.includes(edge.targetContextId);
    if (!external) {
      return {
        effectiveSourceId: edge.sourceContextId,
        settlement: settlementOf(edge.sourceContextId),
      };
    }
    if (loop.activation === "skipped") {
      return { effectiveSourceId: null, settlement: "skipped" };
    }
    if (
      loop.activation !== "concluded" ||
      loop.concludingExitContextId === null
    ) {
      return { effectiveSourceId: null, settlement: "unsettled" };
    }
    return {
      effectiveSourceId: loop.concludingExitContextId,
      settlement: settlementOf(loop.concludingExitContextId),
    };
  }

  function resolveEdge(
    edge: RouteProjectionEdge,
    view: {
      effectiveSourceId: string | null;
      settlement: RouteContextSettlement;
    },
  ): RouteEdgeResolution {
    const kind = guardKind(edge);
    if (view.settlement === "unsettled") return { kind: "unresolved" };
    if (view.settlement === "skipped") {
      // The asymmetry R2 turns on: an unconditional edge drops out of the
      // conjunction, a guard over a source that never produced anything is false.
      return kind === "none" ? { kind: "omitted" } : { kind: "inactive" };
    }
    if (kind === "none") return { kind: "active" };
    // An else edge from a completed source is decided by its siblings; reporting
    // it active here is the "source is available" step, not the verdict.
    if (kind === "else") return { kind: "active" };

    const guard = edge.when;
    if (guard === undefined || !("schema" in guard)) return { kind: "active" };
    if (view.effectiveSourceId === null) return { kind: "unresolved" };

    const lookup = lookupRawContextOutput(outputSource, view.effectiveSourceId);
    if (lookup.kind !== "captured") {
      return { kind: "unevaluable", reason: lookup.kind };
    }
    // The single-source evaluator, never a second one: the guard the author
    // linted in the editor is the guard the engine routes on.
    return validateJsonSchemaSubset(guard.schema, lookup.value).valid
      ? { kind: "active" }
      : { kind: "inactive" };
  }

  // ----------------------------------------------------------
  // Context verdicts
  // ----------------------------------------------------------

  function decideVerdict(contextId: string): RouteContextVerdict {
    const edges = (incoming.get(contextId) ?? []).map(
      (edge) => resolutionByEdgeId.get(edge.id) ?? unresolvedEdge(edge),
    );
    if (edges.length === 0) return { kind: "eligible" };

    const unevaluable = edges.filter(
      (edge) => edge.resolution.kind === "unevaluable",
    );
    if (unevaluable.length > 0) {
      return {
        kind: "halt",
        reason: "guard-unevaluable",
        edgeIds: unevaluable.map((edge) => edge.edgeId),
      };
    }

    if (edges.some((edge) => edge.resolution.kind === "unresolved")) {
      return { kind: "waiting" };
    }

    // Narrowed rather than cast: the two undecided kinds were returned above, so
    // a kind added later shows up here as an unhandled case instead of being
    // silently relabelled into a skip reason.
    const evaluations: RouteEdgeEvaluation[] = [];
    for (const edge of edges) {
      const { kind } = edge.resolution;
      if (kind === "active" || kind === "inactive" || kind === "omitted") {
        evaluations.push({ edgeId: edge.edgeId, verdict: kind });
      }
    }
    const skipped =
      evaluations.some((entry) => entry.verdict === "inactive") ||
      evaluations.every((entry) => entry.verdict === "omitted");

    return skipped
      ? { kind: "skip", edgeEvaluations: evaluations }
      : { kind: "eligible" };
  }

  function settleContext(
    contextId: string,
    verdict: RouteContextVerdict,
  ): RouteContextSettlement {
    const status = input.contextStates[contextId]?.status;
    if (status === "completed") return "completed";
    if (status === "skipped") return "skipped";
    // A derived skip propagates only where the engine could actually apply it:
    // a context that has already started is never skipped, so deriving downstream
    // skips off its route verdict would strand work the engine intends to run.
    const skippable =
      status === undefined || status === "pending" || status === "ready";
    return skippable && verdict.kind === "skip" ? "skipped" : "unsettled";
  }

  /**
   * Falls back to the persisted status for a context the walk has not reached —
   * a concluding loop-pass exit instance is referenced by an edge whose declared
   * source sits elsewhere in the order, and a terminal persisted status is
   * authoritative wherever it is read from.
   */
  function settlementOf(contextId: string): RouteContextSettlement {
    const derived = settlement.get(contextId);
    if (derived !== undefined) return derived;
    const status = input.contextStates[contextId]?.status;
    if (status === "completed") return "completed";
    if (status === "skipped") return "skipped";
    return "unsettled";
  }

  // ----------------------------------------------------------
  // Derived views
  // ----------------------------------------------------------

  function computeCardinality(): RouteCardinalityOutcome[] {
    const outcomes: RouteCardinalityOutcome[] = [];
    for (const contextId of contextIds) {
      const conditional = (outgoing.get(contextId) ?? []).filter(
        (edge) => guardKind(edge) !== "none",
      );
      if (conditional.length === 0) continue;

      const resolutions = conditional.map(
        (edge) =>
          resolutionByEdgeId.get(edge.id)?.resolution ?? { kind: "unresolved" },
      );
      const policy =
        contextById.get(contextId)?.routing?.cardinality ?? "independent";
      const conditionalEdgeIds = conditional.map((edge) => edge.id);
      const activatedEdgeIds = conditional
        .filter((_, index) => resolutions[index]?.kind === "active")
        .map((edge) => edge.id);

      const undecided = resolutions.some(
        (resolution) =>
          resolution.kind === "unresolved" || resolution.kind === "unevaluable",
      );
      outcomes.push({
        sourceContextId: contextId,
        policy,
        conditionalEdgeIds,
        activatedEdgeIds,
        outcome: undecided
          ? "unresolved"
          : classifySelection(policy, activatedEdgeIds.length),
      });
    }
    return outcomes;
  }

  /**
   * The inductive must-run set, run to a fixpoint so a loop can bridge it.
   *
   * A loop's declared exit has no incoming edge in the scheduled graph — the
   * body's internal edges were minted into pass instances — so the ordinary
   * "no incoming edges means entry context" rule would call every loop exit
   * unconditional and drag its whole downstream into the must-run set even when
   * the loop sits behind a guard. The exit is must-run exactly when the loop's
   * ACTIVATION is: accept-time reconvergence guarantees the exit runs on every
   * pass the loop takes.
   */
  function computeMustRun(): ReadonlySet<string> {
    const mustRun = new Set<string>();
    const loops = input.loops ?? [];
    let grew = true;
    while (grew) {
      grew = false;
      for (const contextId of dependencyOrder) {
        if (mustRun.has(contextId) || loopExitIds.has(contextId)) continue;
        const edges = incoming.get(contextId) ?? [];
        if (edges.some((edge) => guardKind(edge) !== "none")) continue;
        const entry = edges.length === 0;
        if (entry || edges.some((edge) => mustRun.has(edge.sourceContextId))) {
          mustRun.add(contextId);
          grew = true;
        }
      }
      for (const loop of loops) {
        if (mustRun.has(loop.exitContextId)) continue;
        if (!mustRun.has(loop.activationContextId)) continue;
        mustRun.add(loop.exitContextId);
        grew = true;
      }
    }
    return mustRun;
  }

  /**
   * An UNSETTLED loop is outstanding work even when every pass instance it has
   * materialized so far is completed: settlement has not yet decided whether the
   * loop concludes or unrolls again, and the contexts that next pass would
   * create do not exist to be counted. Without this, a loop at the tail of a
   * graph — nothing downstream holding the run open — reports the whole
   * execution finished in the window between one pass landing and the next being
   * materialized.
   *
   * The LOGICAL exit is what goes outstanding, because that is the node whose
   * external edges the loop is holding. It is deliberately not an execution
   * context, so nothing but the loop concluding can satisfy it, and it never
   * appears among the publish's contributors.
   */
  function settlePublish(): RoutePublishSettlement {
    const outstandingContextIds: string[] = [];
    const contributingContextIds: string[] = [];
    const skippedContextIds: string[] = [];
    for (const contextId of contextIds) {
      const state = settlementOf(contextId);
      if (state === "completed") contributingContextIds.push(contextId);
      else if (state === "skipped") skippedContextIds.push(contextId);
      else outstandingContextIds.push(contextId);
    }

    const outstandingLoopExitContextIds = (input.loops ?? [])
      .filter(
        (loop) =>
          !contextById.has(loop.exitContextId) &&
          loop.activation !== "concluded" &&
          loop.activation !== "skipped",
      )
      .map((loop) => loop.exitContextId);

    return {
      settled:
        outstandingContextIds.length === 0 &&
        outstandingLoopExitContextIds.length === 0,
      // The logical exits go LAST: they are not execution contexts, so the
      // definition order the rest carries has no position for them.
      outstandingContextIds: [
        ...outstandingContextIds,
        ...outstandingLoopExitContextIds,
      ],
      contributingContextIds,
      skippedContextIds,
      outstandingLoopExitContextIds,
    };
  }
}

// ============================================================
// Accessors
// ============================================================

/**
 * The must-run set of a TOPOLOGY, for consumers that hold no runtime state: the
 * spec compiler (which refuses a scope before an execution exists) and the
 * live-edit frontier (which asks the question of the post-batch graph). Must-run
 * membership is decided by guards and edges alone — never by what has run — so
 * this is the same computation, called with no states rather than a second one.
 */
export function projectMustRunContextIds(topology: {
  readonly executionContexts: readonly RouteProjectionContext[];
  readonly edges: readonly RouteProjectionEdge[];
  readonly loops?: readonly RouteProjectionLoop[] | undefined;
}): ReadonlySet<string> {
  return projectRoutes({
    executionContexts: topology.executionContexts,
    edges: topology.edges,
    contextStates: {},
    contextOutputs: {},
    loops: topology.loops,
  }).mustRunContextIds;
}

export function resolvedRouteEdge(
  projection: RouteProjection,
  edgeId: string,
): ResolvedRouteEdge | undefined {
  return projection.edges.find((edge) => edge.edgeId === edgeId);
}

export function routeVerdict(
  projection: RouteProjection,
  contextId: string,
): RouteContextVerdict {
  return projection.verdictByContextId.get(contextId) ?? { kind: "waiting" };
}

export function incomingRoutes(
  projection: RouteProjection,
  contextId: string,
): ResolvedRouteEdge[] {
  return projection.edges.filter((edge) => edge.targetContextId === contextId);
}

export function outgoingRoutes(
  projection: RouteProjection,
  contextId: string,
): ResolvedRouteEdge[] {
  return projection.edges.filter((edge) => edge.logicalSourceId === contextId);
}

/**
 * The contexts a target actually depends on — the EFFECTIVE sources of its
 * active incoming edges, deduplicated in definition order.
 *
 * This is what the scheduler's prerequisite map, lane visibility, join source
 * planning and upstream-input injection consume. Omitted edges are absent by
 * construction, so a consumer cannot accidentally wait on a skipped branch.
 */
export function activeDependencySourceIds(
  projection: RouteProjection,
  contextId: string,
): string[] {
  const sourceIds: string[] = [];
  for (const edge of incomingRoutes(projection, contextId)) {
    if (edge.resolution.kind !== "active") continue;
    if (edge.effectiveSourceId === null) continue;
    if (!sourceIds.includes(edge.effectiveSourceId)) {
      sourceIds.push(edge.effectiveSourceId);
    }
  }
  return sourceIds;
}

// ============================================================
// Internals
// ============================================================

function guardKind(edge: RouteProjectionEdge): "none" | "schema" | "else" {
  if (edge.when === undefined) return "none";
  return "else" in edge.when ? "else" : "schema";
}

function toResolvedEdge(
  edge: RouteProjectionEdge,
  view: { effectiveSourceId: string | null },
  resolution: RouteEdgeResolution,
): ResolvedRouteEdge {
  return {
    edgeId: edge.id,
    logicalSourceId: edge.sourceContextId,
    effectiveSourceId: view.effectiveSourceId,
    targetContextId: edge.targetContextId,
    guard: guardKind(edge),
    resolution,
  };
}

function unresolvedEdge(edge: RouteProjectionEdge): ResolvedRouteEdge {
  return toResolvedEdge(
    edge,
    { effectiveSourceId: edge.sourceContextId },
    { kind: "unresolved" },
  );
}

function classifySelection(
  policy: RouteCardinalityPolicy,
  activated: number,
): RouteCardinalityOutcome["outcome"] {
  if (policy === "independent") return "satisfied";
  if (activated === 0) return "under-selection";
  if (policy === "exactlyOne" && activated > 1) return "over-selection";
  return "satisfied";
}

function groupBy<T>(
  items: readonly T[],
  key: (item: T) => string,
): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const item of items) {
    const bucket = grouped.get(key(item));
    if (bucket) bucket.push(item);
    else grouped.set(key(item), [item]);
  }
  return grouped;
}

/**
 * Contexts in dependency order, so a source's settlement — including a skip
 * derived one step earlier — is already known when its targets are decided.
 * That single ordered pass is what makes skip propagation recursive without a
 * fixpoint loop.
 *
 * The scheduled graph is Kahn-validated acyclic at every accept path, so a
 * residue here can only come from a malformed input; those contexts are appended
 * in definition order and simply resolve against unsettled sources.
 */
function orderTopologically(
  contextIds: readonly string[],
  edges: readonly RouteProjectionEdge[],
): string[] {
  const known = new Set(contextIds);
  const remainingDeps = new Map<string, number>(
    contextIds.map((contextId) => [contextId, 0]),
  );
  const dependents = new Map<string, string[]>();
  for (const edge of edges) {
    if (!known.has(edge.sourceContextId) || !known.has(edge.targetContextId)) {
      continue;
    }
    remainingDeps.set(
      edge.targetContextId,
      (remainingDeps.get(edge.targetContextId) ?? 0) + 1,
    );
    const bucket = dependents.get(edge.sourceContextId);
    if (bucket) bucket.push(edge.targetContextId);
    else dependents.set(edge.sourceContextId, [edge.targetContextId]);
  }

  const ordered: string[] = [];
  const queue = contextIds.filter((id) => remainingDeps.get(id) === 0);
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const contextId = queue[cursor];
    if (contextId === undefined) continue;
    ordered.push(contextId);
    for (const dependent of dependents.get(contextId) ?? []) {
      const remaining = (remainingDeps.get(dependent) ?? 0) - 1;
      remainingDeps.set(dependent, remaining);
      if (remaining === 0) queue.push(dependent);
    }
  }

  if (ordered.length === contextIds.length) return ordered;
  const placed = new Set(ordered);
  return [...ordered, ...contextIds.filter((id) => !placed.has(id))];
}
