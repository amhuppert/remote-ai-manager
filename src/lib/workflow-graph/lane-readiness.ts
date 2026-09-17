import type {
  GraphWorkflowExecution,
  GraphWorkflowExecutionContextState,
} from "@/lib/workflow-graph/schemas";
import {
  projectExecutionRoutes,
  routeUpstreamContextIds,
} from "@/lib/workflow-graph/execution-routes";
import {
  incomingRoutes,
  activeDependencySourceIds,
  routeVerdict,
  type RouteProjection,
  type RoutePublishSettlement,
} from "@/lib/workflow-graph/route-projection";
import type {
  ContextPlacement,
  ResolvedWorkflowSemanticDefinition,
  WorkflowSemanticDefinition,
} from "@/lib/workflow-graph/definition-schemas";
import {
  SESSION_LANE_ID,
  SESSION_LANE_NAME,
} from "@/lib/workflow-graph/lane-identity";
type ReadinessDefinition =
  | WorkflowSemanticDefinition
  | ResolvedWorkflowSemanticDefinition;

/**
 * Completed session-isolated output is already visible in the session worktree.
 * Worktree output is committed only when its assigned lane ledger records it.
 */
export function isContextOutputCommittedToLane(
  state: GraphWorkflowExecutionContextState,
  execution: GraphWorkflowExecution,
): boolean {
  if (state.status !== "completed") return false;

  if (state.laneId === null) {
    return state.isolation === "session";
  }

  const lane = execution.executionLanes[state.laneId];
  if (!lane) return false;
  return lane.includedContextIds.includes(state.contextId);
}

/** A landed contribution is visible exactly where the lane ledger carries it. */
export function isUpstreamVisibleToDownstream(
  upstreamId: string,
  downstreamId: string,
  execution: GraphWorkflowExecution,
): boolean {
  const downstream = execution.contextStates[downstreamId];
  if (!downstream) return false;
  return isUpstreamVisibleToLane(upstreamId, downstream.laneId, execution);
}

/**
 * The same predicate addressed by LANE rather than by downstream context, for
 * the scheduler: authored placement names the lane a context will run on before
 * that context has been placed on it, so visibility has to be answerable
 * against a lane the downstream has not joined yet.
 */
export function isUpstreamVisibleToLane(
  upstreamId: string,
  targetLaneId: string | null,
  execution: GraphWorkflowExecution,
): boolean {
  const upstream = execution.contextStates[upstreamId];
  if (!upstream) return false;
  if (!isContextOutputCommittedToLane(upstream, execution)) return false;

  const resolvedTargetId =
    targetLaneId ??
    Object.values(execution.executionLanes).find(
      (lane) => lane.kind === "session",
    )?.laneId ??
    SESSION_LANE_ID;
  if (
    execution.executionLanes[resolvedTargetId]?.includedContextIds.includes(
      upstreamId,
    )
  ) {
    return true;
  }
  return (
    upstream.laneId === null &&
    (targetLaneId === null ||
      execution.executionLanes[resolvedTargetId]?.kind === "session")
  );
}

/**
 * Has this context's work actually landed where its dependents will read it?
 *
 * The composition R2.5 requires, and the reason guard truth is never enough to
 * schedule: the projection says a route is taken; this says the source's work
 * is committed and lane-visible. A source whose fan-in merge is pending or
 * failed answers `false`, which BLOCKS its dependents — it never skips them,
 * because an unresolved merge is not evidence that a branch was not taken.
 *
 * Once a context has recorded a landing intent, that intent IS the landing
 * record (decision D8) and only a reconciled `landed` satisfies routing.
 * Neither `pending` nor `failed` does: lifecycle bookkeeping such as a lane's
 * `includedContextIds` or a `merged-success` status records that the commit
 * phase was ENTERED, not that it produced a landing, so deferring to it would
 * route on state no replay can confirm. `reconcileLandingIntents` promotes an
 * intent from the mode-specific evidence — the join's own record, or the branch
 * facts a probe reads back — and route settlement reconciles before it decides,
 * so every skip and settlement marker rides a landed intent.
 *
 * A context dispatched before intents existed has none; {@link
 * isContextOutputCommittedToLane} is the only evidence those runs ever had and
 * stays authoritative for them.
 *
 * A `skipped` source is landed by definition: it holds no lane and owes no
 * commit, so there is nothing for a dependent to wait on (R4).
 */
export function isRouteSourceLanded(
  execution: GraphWorkflowExecution,
  contextId: string,
): boolean {
  const group = execution.workingDefinition.loopGroups?.find(
    (candidate) => candidate.exitContextId === contextId,
  );
  const loop = group ? execution.loopStates[group.id] : undefined;
  if (loop?.activation === "skipped") return true;
  const effectiveContextId =
    loop?.activation === "concluded" ? loop.concludingExitContextId : contextId;
  const state = effectiveContextId
    ? execution.contextStates[effectiveContextId]
    : undefined;
  if (!state) return false;
  if (state.status === "skipped") return true;
  const intent = state.landingIntent;
  if (intent) return intent.state === "landed";
  return isContextOutputCommittedToLane(state, execution);
}

/**
 * The projection's skip verdicts that have actually SETTLED under the land gate
 * (R2.5) — the one predicate both the settlement pass and publish quiescence
 * read, so what the engine applies and what the publish exempts cannot drift.
 *
 * A projection skip is a ROUTING decision made over captured outputs alone; the
 * projection deliberately carries no lane or merge state. A skip becomes real
 * only once every incoming edge's effective source has landed, because a source
 * whose fan-in merge is pending or failed BLOCKS its dependents rather than
 * activating or skipping them — the merge may yet succeed and take the branch.
 *
 * Transitive by construction: a recursive fan-in skip settles on the settled
 * skips upstream of it, so a chain of declined branches is exempt only as far
 * back as the landing evidence reaches. The fixpoint terminates because every
 * round either adds a candidate or stops.
 */
export function collectLandGatedSkips(
  execution: GraphWorkflowExecution,
  projection: RouteProjection,
): Set<string> {
  const settled = new Set<string>();
  const candidates = projection.publish.skippedContextIds;
  if (candidates.length === 0) return settled;

  let changed = true;
  while (changed) {
    changed = false;
    for (const contextId of candidates) {
      if (settled.has(contextId)) continue;
      const landed = incomingRoutes(projection, contextId).every((edge) => {
        const sourceId = edge.effectiveSourceId ?? edge.logicalSourceId;
        return (
          settled.has(sourceId) || isRouteSourceLanded(execution, sourceId)
        );
      });
      if (!landed) continue;
      settled.add(contextId);
      changed = true;
    }
  }
  return settled;
}

/**
 * The publish settlement completion and final publish read: the projection's,
 * with every not-yet-land-gated skip demoted back to outstanding.
 *
 * The projection decides what is outstanding — including the logical exit of a
 * loop that has neither concluded nor been declined. This adds the one thing the
 * projection deliberately cannot see: lane and merge state. Exempting a declined
 * context before its source lands would let the run converge — complete, or
 * publish — around a branch whose fate is still open (R2.5). R4.1's exemptions
 * apply to a skip that has settled, which includes the window before the
 * settlement pass persists the status but not the window before the evidence
 * exists.
 *
 * Returns the projection's own settlement unchanged when nothing is skipped,
 * which is every unconditional graph (the dormant-by-default floor, R14.1).
 */
export function landGatedPublishSettlement(
  execution: GraphWorkflowExecution,
  projection: RouteProjection = projectExecutionRoutes(execution),
): RoutePublishSettlement {
  const publish = projection.publish;
  if (publish.skippedContextIds.length === 0) return publish;

  const settledSkips = collectLandGatedSkips(execution, projection);
  if (settledSkips.size === publish.skippedContextIds.length) return publish;

  const definitionOrder = new Map(
    execution.workingDefinition.executionContexts.map((context, index) => [
      context.id,
      index,
    ]),
  );
  // A logical loop exit has no position in the definition order, so it sorts
  // last rather than to the front — it is not an execution context at all.
  const position = (contextId: string): number =>
    definitionOrder.get(contextId) ?? Number.MAX_SAFE_INTEGER;
  const outstandingContextIds = [
    ...publish.outstandingContextIds,
    ...publish.skippedContextIds.filter((id) => !settledSkips.has(id)),
  ].sort((a, b) => position(a) - position(b));

  return {
    settled: false,
    outstandingContextIds,
    contributingContextIds: publish.contributingContextIds,
    skippedContextIds: publish.skippedContextIds.filter((id) =>
      settledSkips.has(id),
    ),
    outstandingLoopExitContextIds: publish.outstandingLoopExitContextIds,
  };
}

/** Deterministic fork candidates whose confirmed contents carry every input. */
export function lanesCarryingContributions(
  contextIds: readonly string[],
  execution: GraphWorkflowExecution,
): string[] {
  return Object.keys(execution.executionLanes)
    .filter((laneId) =>
      contextIds.every((contextId) =>
        isUpstreamVisibleToLane(contextId, laneId, execution),
      ),
    )
    .sort();
}

export type ContextSchedulability =
  | {
      kind: "schedulable";
      targetLaneId: string | null;
      requiresFork: boolean;
      /**
       * The lane whose committed head a newly minted lane branches from, or
       * null for the session branch. Meaningful only with `requiresFork`.
       */
      forkFromLaneId: string | null;
    }
  | { kind: "wait-for-join"; sourceLaneIds: string[] }
  | { kind: "wait-for-lane"; laneId: string }
  | { kind: "wait-for-capacity" }
  | { kind: "dependency-blocked"; unmetUpstreamIds: string[] };

export interface ClassifySchedulabilityInput {
  contextId: string;
  definition: ReadinessDefinition;
  execution: GraphWorkflowExecution;
  options?: ClassifySchedulabilityOptions;
}

interface ClassifySchedulabilityOptions {
  /**
   * Remaining concurrency budget for new contexts. When 0, the classifier
   * returns wait-for-capacity even if dependencies are otherwise ready.
   * When omitted, capacity is treated as unbounded.
   */
  capacityRemaining?: number;
  /**
   * Whether the downstream is permitted to target the session worktree.
   * Defaults to `false` (session-lane participation is opt-in per the
   * accepted orchestration design). When omitted or `false`, dependency-ready
   * contexts that would otherwise land on the session lane are routed to a
   * forked worktree lane instead.
   */
  sessionLaneEnabled?: boolean;
}

/**
 * The placement a context was authored with — the sole lane authority (R2).
 *
 * Throws rather than falling back to the context id when the definition does
 * not carry the context: a lane name is spliced into a branch and a worktree
 * path, and inventing one from an id is exactly the lexical fallback the
 * ownership machinery forbids. Every caller classifies ids drawn from the same
 * definition, so an absent context is a data-integrity failure, not an input.
 */
function placementOf(
  definition: ReadinessDefinition,
  contextId: string,
): ContextPlacement {
  const placement = definition.executionContexts.find(
    (context) => context.id === contextId,
  )?.placement;
  if (placement === undefined) {
    throw new Error(
      `Context "${contextId}" is not present in the definition, so it has no authored lane placement`,
    );
  }
  return placement;
}

/**
 * The runtime lane id for an authored lane name, or null when no lane record
 * exists for it yet (the caller must mint one).
 */
function resolveAuthoredLaneId(
  laneName: string,
  execution: GraphWorkflowExecution,
): string | null {
  const laneId = laneName === SESSION_LANE_NAME ? SESSION_LANE_ID : laneName;
  return execution.executionLanes[laneId] ? laneId : null;
}

/**
 * The upstream lanes whose work has NOT reached `targetLaneId` — the sources a
 * join into that target still has to merge.
 *
 * Read off the visibility predicate rather than off lane reachability alone, so
 * an upstream that is already present in the target's branch history — because
 * it ran on that lane, or because the lane forked from a branch that carried it
 * — is not counted as a missing source and does not plan a join over work that
 * is already there (R3.2).
 */
function unreachedSourceLaneIds(
  upstreamIds: readonly string[],
  targetLaneId: string,
  execution: GraphWorkflowExecution,
): string[] {
  const missing: string[] = [];
  for (const upstreamId of upstreamIds) {
    const laneId = execution.contextStates[upstreamId]?.laneId ?? null;
    if (laneId === null || laneId === targetLaneId) continue;
    if (missing.includes(laneId)) continue;
    if (isUpstreamVisibleToLane(upstreamId, targetLaneId, execution)) continue;
    missing.push(laneId);
  }
  return missing;
}

/**
 * Decide whether a single context can be scheduled now and, if so, what lane
 * target the scheduler should use. Pure: no I/O, no mutation of execution
 * state.
 *
 * The classifier separates dependency-readiness (every upstream has landed and
 * is visible from the authored lane) from schedulability (the lane admits the
 * context, any required join has succeeded, and concurrency capacity allows
 * it). The lane is never inferred from where the upstream happened to land:
 * authored placement is the only lane authority (R2), and an upstream's lane is
 * at most a fork base.
 *
 * `targetLaneId` is the existing lane to consume — `SESSION_LANE_ID` for the
 * session worktree — or `null` when the authored lane has no record yet. With
 * `requiresFork`, the caller must provision the authored lane from
 * `forkFromLaneId`'s committed head (or the session branch when null).
 *
 * Admission here is LEXICAL, over declared owned prefixes. The canonical,
 * symlink-resolved re-check happens in the reservation reducer
 * (`lane-admission.ts`), which is the only place that can compare frozen sets
 * atomically against co-candidates and a concurrent scheduler.
 */
export function classifyContextSchedulability(
  input: ClassifySchedulabilityInput,
): ContextSchedulability {
  const { contextId, definition, execution, options } = input;
  // Default off: session-lane participation is opt-in per the accepted
  // orchestration design. The default rollout keeps every parallel chain on
  // its own worktree lane and merges into the session branch only at final
  // publish. Callers that have validated dirty-worktree + concurrent-job
  // preconditions can opt in by passing `sessionLaneEnabled: true`.
  const sessionLaneEnabled = options?.sessionLaneEnabled ?? false;
  const capacityRemaining = options?.capacityRemaining;
  const placement = placementOf(definition, contextId);

  // Projection-resolved rather than raw edges (decision D1): the lanes this
  // context must see are the lanes of the ACTIVE incoming edges' EFFECTIVE
  // sources. A skipped branch holds no lane and contributes no merge input, so
  // waiting on it would strand the downstream on a join that can never be
  // planned.
  const upstreamIds = routeUpstreamContextIds(execution, contextId, definition);

  // Phase 1: every upstream must have landed somewhere. Where it landed
  // relative to this context's lane is a routing question (phase 3), not a
  // dependency one — an upstream on an unmerged lane is joinable, not unmet.
  const unmetUpstreamIds = upstreamIds.filter(
    (upstreamId) => !isRouteSourceLanded(execution, upstreamId),
  );
  if (unmetUpstreamIds.length > 0) {
    return { kind: "dependency-blocked", unmetUpstreamIds };
  }

  if (capacityRemaining !== undefined && capacityRemaining <= 0) {
    return { kind: "wait-for-capacity" };
  }

  // The authored session lane is a sentinel for read-only contexts, not a
  // persisted execution lane. Its only delivery channel is structured output,
  // so it neither needs repository ancestry nor participates in the legacy
  // session-worktree safety rules that could redirect it into a fork. This
  // branch deliberately precedes execution-lane lookup: a final-publish row for
  // the physical session lane must never capture a reader onto __session__.
  if (placement.lane === SESSION_LANE_NAME && placement.mode === "readOnly") {
    return {
      kind: "schedulable",
      targetLaneId: null,
      requiresFork: false,
      forkFromLaneId: null,
    };
  }

  // Phase 2: the authored lane already exists — run there.
  const targetLaneId = resolveAuthoredLaneId(placement.lane, execution);
  if (targetLaneId !== null) {
    const missingSources = unreachedSourceLaneIds(
      upstreamIds,
      targetLaneId,
      execution,
    );
    if (missingSources.length > 0) {
      return { kind: "wait-for-join", sourceLaneIds: missingSources };
    }
    if (
      !laneAdmits({ targetLaneId, contextId, placement, definition, execution })
    ) {
      return { kind: "wait-for-lane", laneId: targetLaneId };
    }
    return {
      kind: "schedulable",
      targetLaneId,
      requiresFork: false,
      forkFromLaneId: null,
    };
  }

  // The session lane is the session worktree itself: never provisioned, never
  // forked. Until a lane record is materialized for it (final publish does
  // that), a context authored there runs with no lane at all, and the caller's
  // opt-in is what says the session worktree is safe to occupy.
  if (placement.lane === SESSION_LANE_NAME) {
    const unpublished = upstreamIds.filter(
      (upstreamId) =>
        execution.contextStates[upstreamId]?.laneId !== null &&
        !isUpstreamVisibleToLane(upstreamId, null, execution),
    );
    if (unpublished.length > 0) {
      return {
        kind: "wait-for-join",
        sourceLaneIds: [
          ...new Set(
            unpublished.map(
              (upstreamId) => execution.contextStates[upstreamId]!.laneId!,
            ),
          ),
        ],
      };
    }
    if (!sessionLaneEnabled || hasUnpublishedUnrelatedWorktreeWork(execution)) {
      return { kind: "wait-for-lane", laneId: SESSION_LANE_ID };
    }
    return {
      kind: "schedulable",
      targetLaneId: null,
      requiresFork: false,
      forkFromLaneId: null,
    };
  }

  // Phase 3: the authored group lane has to be minted. It forks from the branch
  // that already carries this context's upstream work, so the fork itself
  // delivers the visibility a join would otherwise have to.
  const workTreeSourceLaneIds = collectSourceLaneIds(
    upstreamIds,
    execution,
  ).filter((laneId): laneId is string => laneId !== null);

  if (workTreeSourceLaneIds.length >= 2) {
    // Several unmerged sources: no single branch carries all of the upstream
    // work, so there is nothing to fork from until a join converges them.
    const commonTargets = lanesCarryingContributions(upstreamIds, execution);
    if (commonTargets.length === 0) {
      return { kind: "wait-for-join", sourceLaneIds: workTreeSourceLaneIds };
    }
    return {
      kind: "schedulable",
      targetLaneId: null,
      requiresFork: true,
      forkFromLaneId: commonTargets[0]!,
    };
  }

  if (workTreeSourceLaneIds.length === 1) {
    return {
      kind: "schedulable",
      targetLaneId: null,
      requiresFork: true,
      forkFromLaneId: workTreeSourceLaneIds[0]!,
    };
  }

  // No worktree source lanes — every upstream (if any) landed in session, so
  // the authored lane forks from the session branch.
  return {
    kind: "schedulable",
    targetLaneId: null,
    requiresFork: true,
    forkFromLaneId: null,
  };
}

/**
 * Does `targetLaneId` admit this context alongside whoever is running on it?
 *
 * The lexical half of the admission rule (R5): read-only members collide with
 * nobody, a full-access member on either side takes the lane exclusively, and
 * two owning members are admissible exactly when their declared prefixes are
 * pairwise disjoint. Occupancy is `running` only — a `ready` member holds no
 * turn, and a reserved-but-not-started one is accounted for by the reservation
 * record the scheduler keeps, not by status.
 */
function laneAdmits(input: {
  targetLaneId: string;
  contextId: string;
  placement: ContextPlacement;
  definition: ReadinessDefinition;
  execution: GraphWorkflowExecution;
}): boolean {
  const { targetLaneId, contextId, placement, definition, execution } = input;
  if (placement.mode === "readOnly") return true;

  for (const state of Object.values(execution.contextStates)) {
    if (state.contextId === contextId) continue;
    if (state.laneId !== targetLaneId) continue;
    if (state.status !== "running") continue;
    const occupant = definition.executionContexts.find(
      (context) => context.id === state.contextId,
    )?.placement;
    // A running occupant the definition no longer carries (a live edit removed
    // it mid-turn) still holds the worktree, and nothing describes what it
    // writes — the fail-closed reading is that it holds the lane exclusively.
    if (occupant === undefined) return false;
    if (occupant.mode === "readOnly") continue;
    if (occupant.mode === "full" || placement.mode === "full") return false;
    for (const ownedPath of placement.ownedPaths) {
      for (const occupied of occupant.ownedPaths) {
        if (declaredPrefixesOverlap(ownedPath, occupied)) return false;
      }
    }
  }
  return true;
}

/**
 * Prefix coverage at segment boundaries, so `src/lib` does not swallow the
 * sibling `src/libraries`. Mirrors the authoring-time check in
 * `placement-validation.ts`, which is the same rule read off the same strings.
 */
function declaredPrefixesOverlap(left: string, right: string): boolean {
  return (
    left === right ||
    left.startsWith(`${right}/`) ||
    right.startsWith(`${left}/`)
  );
}

function collectSourceLaneIds(
  upstreamIds: string[],
  execution: GraphWorkflowExecution,
): Array<string | null> {
  const seen = new Set<string | null>();
  const ordered: Array<string | null> = [];
  for (const upstreamId of upstreamIds) {
    const upstream = execution.contextStates[upstreamId];
    if (!upstream) continue;
    const key = upstream.laneId;
    if (seen.has(key)) continue;
    seen.add(key);
    ordered.push(key);
  }
  return ordered;
}

/**
 * Returns true when a worktree context exists whose output has not been
 * published to the session worktree. In the lane-aware model, publication
 * means the session lane carries that contribution.
 */
function hasUnpublishedUnrelatedWorktreeWork(
  execution: GraphWorkflowExecution,
): boolean {
  for (const state of Object.values(execution.contextStates)) {
    if (state.isolation !== "worktree") continue;
    if (isUpstreamVisibleToLane(state.contextId, null, execution)) continue;
    return true;
  }
  return false;
}

/**
 * The contexts the scheduler may start right now.
 *
 * Two independent gates, composed (D4 R2.5). The ROUTE gate is the projection's
 * verdict: every incoming edge satisfied, where a guard decides a conditional
 * edge and a skipped source's unconditional edge drops out of the conjunction.
 * The LAND gate is unchanged and still necessary — a satisfied route says the
 * branch was taken, not that the source's work is committed and visible from
 * the downstream's lane — so a source whose fan-in merge is pending or failed
 * blocks its dependents here rather than releasing them.
 *
 * Prerequisites come from `activeDependencySourceIds`, i.e. the EFFECTIVE
 * sources of the ACTIVE incoming edges (decision D1). Reading
 * `edge.sourceContextId` directly would wait on branches the routing already
 * declined and, once loops land, on a declared exit that never runs.
 *
 * The LAND gate stops at "has it landed". WHERE it landed relative to this
 * context's lane is `classifyContextSchedulability`'s call, and deliberately
 * not repeated here: an upstream on a lane the target has not merged yet is
 * joinable, not blocked, and the classifier's `wait-for-join` verdict is what
 * plans that merge. Filtering the context out of eligibility would leave nobody
 * to plan it (R3.2).
 */
export function getEligibleContextIds(
  definition: ReadinessDefinition,
  execution: GraphWorkflowExecution,
): string[] {
  const projection = projectExecutionRoutes(execution, definition);

  return definition.executionContexts
    .map((context) => context.id)
    .filter((contextId) => {
      const state = execution.contextStates[contextId];
      if (!state) return false;
      if (state.status !== "pending" && state.status !== "ready") return false;
      // Owner-discriminated reservation (Design 3.1): a context a scheduler has
      // reserved (and is provisioning worktrees for out of the lock) is not
      // eligible for a concurrent same-epoch scheduler to re-classify and
      // double-provision. The owning pass clears the stamp at finalize.
      if (state.reservedByBatchId != null) return false;

      if (routeVerdict(projection, contextId).kind !== "eligible") return false;

      return activeDependencySourceIds(projection, contextId).every(
        (upstreamId) => isRouteSourceLanded(execution, upstreamId),
      );
    });
}
