import type {
  ContextProgress,
  ContractInput,
} from "@/lib/execution-context/schemas";
import {
  activeDependencySourceIds,
  incomingRoutes,
  projectRoutes,
  type RouteEdgeResolution,
  type RouteProjection,
} from "@/lib/workflow-graph/route-projection";
import { validateJsonSchemaSubset } from "@/lib/workflows/primitives/output-schema-subset";
import {
  laneStateOf,
  type LanePublicationOutcome,
  type RouteGuard,
  type RunDefinitionContext,
  type RunFacts,
  type RunHaltClearedBy,
  type RunHaltKind,
  type RunInvocation,
  type RunLoop,
  type RunProgress,
} from "./schemas";
import { laneCodePrerequisites, laneMembers, laneSkipped } from "./topology";

/** What the Run last observed of each started context, keyed by Context id. */
export type ObservedContexts = ReadonlyMap<
  string,
  {
    progress: ContextProgress | null;
    output?: unknown;
    /** An effect of the context is admitted and running: it drains through a pause. */
    active: boolean;
    /** Questions its seats asked the owner that are still open, whatever its progress says. */
    openQuestions: number;
  }
>;

/** A context to start now, in the pass and Context given, with the accepted results it builds on. */
export interface ScheduledStart {
  key: string;
  pass: number;
  contextId: string;
  inputs: ContractInput[];
}

/** Where one defined context stands in its current pass. */
export type KeyState =
  | {
      kind: "waiting";
      pass: number;
      /** Dependencies not yet decided. */
      on: string[];
      /** Its lane, when that lane's worktree is all it still waits for. */
      lane?: string;
      /** Lanes whose code it needs and that have not published yet. */
      publications?: string[];
    }
  | { kind: "skipped" }
  | { kind: "started"; pass: number; contextId: string };

/** Workspace work on a lane that is due now. */
export type LaneAction =
  | { kind: "provision"; lane: string }
  | { kind: "publish"; lane: string; attempt: number };

/** `next`: the pass's exit result missed the exit condition and another pass is due. */
export type LoopState =
  | { kind: "unstarted" }
  | {
      kind: "running" | "next" | "succeeded" | "exhausted" | "unevaluable";
      pass: number;
    };

/** A route, loop or lane that cannot proceed on its own, and what clears it. */
export interface RunHalt {
  kind: RunHaltKind;
  /** Stable while the cause stands, so projecting it again records nothing new. */
  occurrence: string;
  reason: string;
  clearedBy: RunHaltClearedBy;
  /** The lane a lane halt concerns. */
  lane?: string;
}

/**
 * The one reading of a Run's definition against what its Contexts did, shared
 * by scheduling, dependency inputs, the run view and completion.
 */
export interface RunPlan {
  /** Starts that are due, whatever the Run's control says. */
  starts: ScheduledStart[];
  /** Lane provisioning and first publication attempts that are due, likewise. */
  laneActions: LaneAction[];
  keys: ReadonlyMap<string, KeyState>;
  loops: ReadonlyMap<string, LoopState>;
  halts: RunHalt[];
  /** Every defined context succeeded or was skipped, every lane that ran published, and nothing halted. */
  complete: boolean;
  /** A lane's provisioning or publication was requested and has not settled. */
  laneWorkInFlight: boolean;
  /** Each dependency edge, keyed `source->target`, with how its route stands now. */
  routes: ReadonlyMap<
    string,
    { source: string; target: string; resolution: RouteEdgeResolution["kind"] }
  >;
  /**
   * Some started context can still move without the owner, or a start is
   * due, whatever the Run's control says: a pause or fault holds this work,
   * it does not finish it.
   */
  moving: boolean;
}

/** A later loop pass runs in a fresh Context beside the first pass's. */
export function passContextId(baseContextId: string, pass: number): string {
  return pass === 0 ? baseContextId : `${baseContextId}.pass${pass + 1}`;
}

/** Recent passes, the last one included, whose exit results an entry receives; full evidence stays with their Contexts. */
const CARRIED_PASSES = 3;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const quoted = (keys: readonly string[]): string =>
  keys.map((key) => `"${key}"`).join(", ");

/**
 * Plans the Run. Pure. Routes are decided by the shared route projection over
 * the defined keys, so a guard is evaluated only on an accepted output and a
 * route nobody can evaluate halts rather than reading as false. A loop is
 * opaque to the projection until it succeeds: its body runs pass by pass, and
 * work after it sees the final pass's results only.
 *
 * Route choices and loop outcomes are derived from the frozen definition and
 * the accepted outputs, both durable before any dependent starts.
 */
export function planRun(facts: RunFacts, observed: ObservedContexts): RunPlan {
  const defined = facts.definition.contexts;
  const byKey = new Map(defined.map((c) => [c.key, c]));
  const loops = facts.definition.loops ?? [];
  const loopOf = new Map<string, RunLoop>();
  for (const loop of loops) for (const key of loop.body) loopOf.set(key, loop);

  const invocations = new Map<string, RunInvocation>(
    facts.invocations.map((i) => [`${i.key}@${i.pass}`, i]),
  );
  const invocationAt = (key: string, pass: number) =>
    invocations.get(`${key}@${pass}`);
  const seenAt = (key: string, pass: number) => {
    const invocation = invocationAt(key, pass);
    return invocation === undefined
      ? undefined
      : observed.get(invocation.contextId);
  };
  const succeededAt = (key: string, pass: number): boolean =>
    seenAt(key, pass)?.progress?.kind === "succeeded";
  const outputAt = (key: string, pass: number): unknown =>
    seenAt(key, pass)?.output ?? null;
  const titleOf = (key: string): string =>
    byKey.get(key)?.request.contract.title ?? key;

  function loopState(loop: RunLoop): LoopState {
    const passes = facts.invocations
      .filter((i) => loopOf.get(i.key)?.key === loop.key)
      .map((i) => i.pass);
    if (passes.length === 0) return { kind: "unstarted" };
    const pass = Math.max(...passes);
    if (!succeededAt(loop.exit, pass)) return { kind: "running", pass };
    const output = outputAt(loop.exit, pass);
    if (!isRecord(output)) return { kind: "unevaluable", pass };
    // Success is checked before exhaustion, so the last allowed pass can succeed.
    if (validateJsonSchemaSubset(loop.until.schema, output).valid)
      return { kind: "succeeded", pass };
    return pass + 1 < loop.maxPasses
      ? { kind: "next", pass }
      : { kind: "exhausted", pass };
  }
  const loopStates = new Map(loops.map((loop) => [loop.key, loopState(loop)]));
  const stateOf = (loop: RunLoop): LoopState =>
    loopStates.get(loop.key) ?? { kind: "unstarted" };

  /** The pass whose work a key currently stands for. */
  function currentPass(key: string): number {
    const loop = loopOf.get(key);
    if (loop === undefined) return 0;
    const state = stateOf(loop);
    return state.kind === "unstarted" ? 0 : state.pass;
  }

  /** Completed, still running, or not started, as the surrounding graph sees it. */
  function status(key: string): "completed" | "running" | undefined {
    const loop = loopOf.get(key);
    if (loop !== undefined) {
      const state = stateOf(loop);
      if (state.kind === "unstarted") return undefined;
      return state.kind === "succeeded" ? "completed" : "running";
    }
    if (invocationAt(key, 0) === undefined) return undefined;
    return succeededAt(key, 0) ? "completed" : "running";
  }
  const resultOf = (key: string): unknown => outputAt(key, currentPass(key));

  const edges = defined.flatMap((target) =>
    target.dependsOn.map((source) => ({
      id: `${source}->${target.key}`,
      sourceContextId: source,
      targetContextId: target.key,
      when: guardOf(target, source),
    })),
  );
  const routed = defined.map((c) => ({
    id: c.key,
    outputSchema: c.request.contract.outputSchema ?? undefined,
    routing: c.routing,
  }));
  const contextStates: Record<string, { status: "completed" | "running" }> = {};
  const contextOutputs: Record<string, { value: Record<string, unknown> }> = {};
  for (const c of defined) {
    const current = status(c.key);
    if (current === undefined) continue;
    contextStates[c.key] = { status: current };
    const output = resultOf(c.key);
    if (current === "completed" && isRecord(output))
      contextOutputs[c.key] = { value: output };
  }
  const project = (uncommittedSourceIds: readonly string[]): RouteProjection =>
    projectRoutes({
      executionContexts: routed,
      edges,
      contextStates,
      contextOutputs,
      uncommittedSourceIds,
    });
  const decided = project([]);
  const violations = decided.cardinality.filter(
    (o) =>
      o.policy !== "independent" &&
      (o.outcome === "under-selection" || o.outcome === "over-selection"),
  );
  // A choice that breaks its cardinality is not committed: every route from
  // that source stays undecided until its definition changes.
  const projection =
    violations.length === 0
      ? decided
      : project(violations.map((outcome) => outcome.sourceContextId));

  const halts: RunHalt[] = [];
  for (const outcome of violations) {
    const source = outcome.sourceContextId;
    const targets = (edgeIds: readonly string[]) =>
      edgeIds.map((id) => id.slice(`${source}->`.length));
    const taken =
      outcome.activatedEdgeIds.length === 0
        ? "none of them"
        : quoted(targets(outcome.activatedEdgeIds));
    halts.push({
      kind: "route_cardinality",
      clearedBy: "amend",
      occurrence: `route:${source}:cardinality`,
      reason: `route: "${source}" must take ${outcome.policy === "exactlyOne" ? "exactly one" : "at least one"} of its guarded routes (${quoted(targets(outcome.conditionalEdgeIds))}), but its result took ${taken}`,
    });
  }
  for (const c of defined) {
    if (status(c.key) !== undefined) continue;
    if (projection.verdictByContextId.get(c.key)?.kind !== "halt") continue;
    const sources = incomingRoutes(projection, c.key)
      .filter((edge) => edge.resolution.kind === "unevaluable")
      .map((edge) => edge.logicalSourceId);
    halts.push({
      kind: "route_unevaluable",
      clearedBy: "amend",
      // Named by its sources too: an amendment can clear one, and another source can halt the same context later.
      occurrence: `route:${c.key}:unevaluable:${[...new Set(sources)].sort().join(",")}`,
      reason: `route: whether "${c.key}" runs cannot be decided, because the result of ${quoted([...new Set(sources)])} cannot be read`,
    });
  }
  for (const loop of loops) {
    const state = stateOf(loop);
    if (state.kind === "exhausted")
      halts.push({
        kind: "loop_exhausted",
        // Raising its maxPasses runs it further.
        clearedBy: "amend",
        occurrence: `loop:${loop.key}:exhausted:${loop.maxPasses}`,
        reason: `loop "${loop.key}": "${loop.exit}" did not meet the exit condition in ${loop.maxPasses} ${loop.maxPasses === 1 ? "pass" : "passes"}`,
      });
    if (state.kind === "unevaluable")
      halts.push({
        kind: "loop_unevaluable",
        // A started loop's exit condition cannot be amended.
        clearedBy: "cancel",
        occurrence: `loop:${loop.key}:unevaluable:${state.pass + 1}`,
        reason: `loop "${loop.key}": the result of "${loop.exit}" in pass ${state.pass + 1} cannot be read, so the exit condition cannot be evaluated`,
      });
  }

  const laneState = (lane: string) => laneStateOf(facts, lane);
  const definedLanes = facts.definition.lanes ?? [];
  const settlementOf = (key: string) =>
    projection.settlementByContextId.get(key);
  const membersOf = (lane: string) => laneMembers(defined, lane);
  const isSkipped = (key: string): boolean => settlementOf(key) === "skipped";
  const skippedLane = (lane: string): boolean =>
    laneSkipped(defined, lane, isSkipped);
  const published = (lane: string): boolean =>
    laneState(lane)?.publication?.outcome.kind === "published";
  const provisioned = (lane: string | undefined): boolean =>
    lane === undefined ||
    laneState(lane)?.provision.outcome.kind === "provisioned";
  const needsCode = (c: RunDefinitionContext, source: string): boolean =>
    !(c.outputOnly ?? []).includes(source);
  /** Lanes whose publication waits for `key`: a member that may still run depends on it through contexts that may still run. */
  const lanesWaitingFor = (key: string): Set<string> => {
    const reached = new Set([key]);
    for (const from of reached)
      for (const c of defined)
        if (!isSkipped(c.key) && c.dependsOn.includes(from)) reached.add(c.key);
    return new Set(
      defined.flatMap((c) =>
        c.lane !== undefined && reached.has(c.key) ? [c.lane] : [],
      ),
    );
  };
  /**
   * Unpublished lanes `c` waits for. A lane context waits for the lanes whose
   * code it needs through its taken routes. A publication changes the session
   * worktree, so a session context waits for every lane that may still publish
   * and does not wait for it: a skipped route can drop the dependency that
   * ordered it after a lane. The compiler refuses a writer any lane waits for.
   */
  const awaitedPublications = (c: RunDefinitionContext): string[] => {
    if (c.lane !== undefined) return codeFromLanes(c);
    const before = lanesWaitingFor(c.key);
    return definedLanes.flatMap((lane) =>
      published(lane.key) || skippedLane(lane.key) || before.has(lane.key)
        ? []
        : [lane.key],
    );
  };
  const codeFromLanes = (c: RunDefinitionContext): string[] => [
    ...new Set(
      activeDependencySourceIds(projection, c.key).flatMap((source) => {
        const lane = byKey.get(source)?.lane;
        return lane !== undefined &&
          lane !== c.lane &&
          needsCode(c, source) &&
          !published(lane)
          ? [lane]
          : [];
      }),
    ),
  ];
  /** Ready to start but for its lane's worktree. */
  const startable = (c: RunDefinitionContext): boolean => {
    const loop = loopOf.get(c.key);
    if (loop !== undefined && loop.entry !== c.key) return false;
    return (
      status(c.key) === undefined &&
      projection.verdictByContextId.get(c.key)?.kind === "eligible" &&
      awaitedPublications(c).length === 0
    );
  };

  for (const lane of definedLanes) {
    const state = laneState(lane.key);
    if (state?.provision.outcome.kind === "refused")
      halts.push({
        kind: "lane_provision",
        clearedBy: "retry_lane",
        lane: lane.key,
        occurrence: `lane:${lane.key}:provision:${state.provision.attempt}`,
        reason: `lane "${lane.key}": its worktree could not be provisioned: ${state.provision.outcome.detail}`,
      });
    const publication = state?.publication;
    if (publication === undefined || publication === null) continue;
    const reason = publicationHaltReason(lane.key, publication.outcome);
    if (reason !== null)
      halts.push({
        kind: "lane_publication",
        clearedBy: "retry_lane",
        lane: lane.key,
        occurrence: `lane:${lane.key}:publication:${publication.attempt}`,
        reason,
      });
  }

  const laneActions: LaneAction[] = [];
  for (const lane of definedLanes) {
    const state = laneState(lane.key);
    const members = membersOf(lane.key);
    if (state === undefined) {
      if (skippedLane(lane.key)) continue;
      // Every lane it needs code from has published, so its base includes that code.
      const ready = [...laneCodePrerequisites(defined, lane.key)].every(
        (from) => published(from) || skippedLane(from),
      );
      if (ready && members.some(startable))
        laneActions.push({ kind: "provision", lane: lane.key });
      continue;
    }
    if (
      state.provision.outcome.kind !== "provisioned" ||
      state.publication !== null
    )
      continue;
    // Sealed: every member is done or skipped, loops included.
    if (
      members.every((c) => {
        const settled = settlementOf(c.key);
        return settled === "completed" || settled === "skipped";
      })
    )
      laneActions.push({ kind: "publish", lane: lane.key, attempt: 1 });
  }

  const routeInputs = (key: string): ContractInput[] =>
    activeDependencySourceIds(projection, key).map((source) => ({
      key: source,
      title: titleOf(source),
      output: resultOf(source),
    }));
  const starts: ScheduledStart[] = [];
  for (const c of defined) {
    if (!startable(c) || !provisioned(c.lane)) continue;
    starts.push({
      key: c.key,
      pass: 0,
      contextId: c.request.contextId,
      inputs: routeInputs(c.key),
    });
  }
  for (const loop of loops) {
    const state = stateOf(loop);
    if (state.kind === "running") {
      for (const member of bodyInOrder(defined, loop)) {
        if (member.key === loop.entry) continue;
        if (invocationAt(member.key, state.pass) !== undefined) continue;
        if (!member.dependsOn.every((dep) => succeededAt(dep, state.pass)))
          continue;
        starts.push({
          key: member.key,
          pass: state.pass,
          contextId: passContextId(member.request.contextId, state.pass),
          inputs: member.dependsOn.map((dep) => ({
            key: dep,
            title: titleOf(dep),
            output: outputAt(dep, state.pass),
          })),
        });
      }
    }
    const entry = byKey.get(loop.entry);
    if (state.kind === "next" && entry !== undefined) {
      const pass = state.pass + 1;
      const carried: ContractInput[] = [];
      for (
        let q = Math.max(0, state.pass - CARRIED_PASSES + 1);
        q <= state.pass;
        q++
      )
        carried.push({
          key: loop.exit,
          title: `${titleOf(loop.exit)} (pass ${q + 1})`,
          output: outputAt(loop.exit, q),
        });
      starts.push({
        key: loop.entry,
        pass,
        contextId: passContextId(entry.request.contextId, pass),
        inputs: [...routeInputs(loop.entry), ...carried],
      });
    }
  }

  const keys = new Map<string, KeyState>();
  for (const c of defined) {
    const pass = currentPass(c.key);
    const invocation = invocationAt(c.key, pass);
    if (invocation !== undefined) {
      keys.set(c.key, {
        kind: "started",
        pass,
        contextId: invocation.contextId,
      });
    } else if (projection.settlementByContextId.get(c.key) === "skipped") {
      keys.set(c.key, { kind: "skipped" });
    } else {
      const loop = loopOf.get(c.key);
      const on =
        loop !== undefined && loop.entry !== c.key
          ? c.dependsOn.filter((dep) => !succeededAt(dep, pass))
          : incomingRoutes(projection, c.key)
              .filter(
                (edge) =>
                  edge.resolution.kind === "unresolved" ||
                  edge.resolution.kind === "unevaluable",
              )
              .map((edge) => edge.logicalSourceId);
      const waiting: Extract<KeyState, { kind: "waiting" }> = {
        kind: "waiting",
        pass,
        on: [...new Set(on)],
      };
      const publications = on.length === 0 ? awaitedPublications(c) : [];
      if (publications.length > 0) waiting.publications = publications;
      else if (on.length === 0 && c.lane !== undefined && !provisioned(c.lane))
        waiting.lane = c.lane;
      keys.set(c.key, waiting);
    }
  }

  const laneWorkInFlight = Object.values(facts.lanes ?? {}).some(
    (state) =>
      state.provision.outcome.kind === "requested" ||
      state.publication?.outcome.kind === "requested",
  );
  const moving =
    starts.length > 0 ||
    laneActions.length > 0 ||
    laneWorkInFlight ||
    facts.invocations.some((invocation) => {
      const progress = observed.get(invocation.contextId)?.progress ?? null;
      // A start its host has not created yet is still on its way.
      if (progress === null) return true;
      const current = progress.kind === "paused" ? progress.next : progress;
      return current === null || current.kind === "running";
    });
  const complete =
    halts.length === 0 &&
    defined.every((c) => {
      const settled = projection.settlementByContextId.get(c.key);
      return settled === "completed" || settled === "skipped";
    }) &&
    definedLanes.every(
      (lane) => laneState(lane.key) === undefined || published(lane.key),
    );
  return {
    starts,
    laneActions,
    keys,
    loops: loopStates,
    halts,
    complete,
    moving,
    laneWorkInFlight,
    routes: new Map(
      projection.edges.map((edge) => [
        edge.edgeId,
        {
          source: edge.logicalSourceId,
          target: edge.targetContextId,
          resolution: edge.resolution.kind,
        },
      ]),
    ),
  };
}

/** Why a lane's publication stops the run until the owner asks for a new attempt; null while it does not. */
function publicationHaltReason(
  lane: string,
  outcome: LanePublicationOutcome,
): string | null {
  switch (outcome.kind) {
    case "requested":
    case "published":
    case "cancelled":
      return null;
    case "publish_blocked":
      return `lane "${lane}": publication blocked: ${outcome.detail}`;
    case "publication_stale":
      return `lane "${lane}": the session branch moved to ${outcome.head} after the lane was checked against it; a new attempt merges the new head and checks again`;
    case "publication_failed":
    case "refused":
      return `lane "${lane}": publication failed: ${outcome.detail}`;
    case "publication_uncertain":
      return `lane "${lane}": publication may or may not have happened: ${outcome.detail}`;
  }
}

/** A dependency's own guard; a key such as `constructor` must not read an inherited property. */
export function guardOf(
  target: RunDefinitionContext,
  source: string,
): RouteGuard | undefined {
  const when = target.when;
  return when !== undefined && Object.hasOwn(when, source)
    ? when[source]
    : undefined;
}

/** A loop's members in definition order, so starts are deterministic. */
function bodyInOrder(
  defined: readonly RunDefinitionContext[],
  loop: RunLoop,
): RunDefinitionContext[] {
  return defined.filter((c) => loop.body.includes(c.key));
}

/**
 * The contexts to start and the lane steps to request now. Nothing new starts
 * while the run is paused, cancelled or faulted. Pure.
 */
export function decideNext(
  facts: RunFacts,
  observed: ObservedContexts,
): Pick<RunPlan, "starts" | "laneActions"> {
  const { paused, cancelled, fault } = facts.control;
  if (paused || cancelled || fault !== null)
    return { starts: [], laneActions: [] };
  const { starts, laneActions } = planRun(facts, observed);
  return { starts, laneActions };
}

/** A Context that will do nothing more. */
export function isTerminal(progress: ContextProgress | null): boolean {
  return progress?.kind === "succeeded" || progress?.kind === "cancelled";
}

/** Why each started context needs its owner, in start order; a paused context by where it stands. */
function ownerReasons(facts: RunFacts, observed: ObservedContexts): string[] {
  return facts.invocations.flatMap((invocation) => {
    const observedProgress =
      observed.get(invocation.contextId)?.progress ?? null;
    const progress =
      observedProgress?.kind === "paused"
        ? observedProgress.next
        : observedProgress;
    const label =
      invocation.pass === 0
        ? invocation.key
        : `${invocation.key} (pass ${invocation.pass + 1})`;
    if (progress === null) return [];
    const questions =
      (observed.get(invocation.contextId)?.openQuestions ?? 0) > 0
        ? [`${label}: question`]
        : [];
    if (progress.kind === "halted")
      return [...questions, `${label}: halted (${progress.halt})`];
    if (
      progress.kind === "waiting" &&
      progress.obligation.kind === "await_approval"
    )
      return [...questions, `${label}: approval`];
    return questions;
  });
}

/**
 * Run progress from control and the observed contexts. Pure. The run succeeds
 * once every defined context succeeded or was skipped by a route; it needs its
 * owner only when something waits on them and no other context can still move.
 */
export function deriveRunProgress(
  facts: RunFacts,
  observed: ObservedContexts,
  /** Workspace is running one of the Run's lane steps now; it drains through a pause. */
  laneStepRunning = false,
): RunProgress {
  const plan = planRun(facts, observed);
  const started = facts.invocations.map(
    (invocation) => observed.get(invocation.contextId)?.progress ?? null,
  );
  const active = facts.invocations.some(
    (invocation) => observed.get(invocation.contextId)?.active === true,
  );
  // Cancellation revokes the permit, so a start no Context took up never will.
  if (facts.control.cancelled)
    return started.every((p) => p === null || isTerminal(p)) &&
      !plan.laneWorkInFlight
      ? { kind: "cancelled" }
      : { kind: "stopping" };
  // Success outranks pause: work that drained during a pause and finished the run is done.
  if (plan.complete) return { kind: "succeeded" };
  if (facts.control.fault !== null)
    return {
      kind: "needs_owner",
      reasons: [`run: ${facts.control.fault.detail}`],
    };
  // The Run's permit stops new effects; the ones already admitted drain.
  if (facts.control.paused)
    return { kind: "paused", draining: active || laneStepRunning };
  const reasons = [
    ...ownerReasons(facts, observed),
    ...plan.halts.map((halt) => halt.reason),
  ];
  if (reasons.length > 0 && !plan.moving)
    return { kind: "needs_owner", reasons };
  return { kind: "running" };
}

/**
 * Whether the run's route and loop halts are all that stands: nothing can
 * move, no other context waits on the owner, and the Run is not faulted.
 * Pure.
 */
export function onlyHaltsRemain(
  facts: RunFacts,
  observed: ObservedContexts,
  plan: RunPlan,
): boolean {
  return (
    plan.halts.length > 0 &&
    !plan.moving &&
    facts.control.fault === null &&
    ownerReasons(facts, observed).length === 0
  );
}
