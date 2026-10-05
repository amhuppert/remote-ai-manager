import { isDeepStrictEqual } from "node:util";
import type { SeatAssignment } from "@/lib/conversation-core/schemas";
import { planRun, type ObservedContexts } from "./schedule";
import {
  laneStateOf,
  type RunDefinitionContext,
  type RunFacts,
  type RunLane,
  type RunLoop,
} from "./schemas";

/** A compiled workflow definition proposed to replace a Run's current one. */
export interface ProposedDefinition {
  title: string;
  contexts: RunDefinitionContext[];
  loops?: RunLoop[];
  lanes?: RunLane[];
  /** The workflow as its owner wrote it. */
  authored?: Record<string, unknown>;
}

export type AmendmentResult =
  | { ok: true; title: string; definition: RunFacts["definition"] }
  | { ok: false; issues: string[] };

/** Values as JSON keeps them: an absent optional field and an undefined one compare equal. */
const plain = (value: unknown): unknown =>
  value === undefined ? null : JSON.parse(JSON.stringify(value));
const same = (a: unknown, b: unknown): boolean =>
  isDeepStrictEqual(plain(a), plain(b));

const quoted = (keys: readonly string[]): string =>
  keys.map((key) => `"${key}"`).join(", ");

/** A seat as authored: resolving it again may pick another backend or model for the same request. */
function authoredSeat(seat: SeatAssignment): Omit<SeatAssignment, "backend" | "modelSelection"> {
  const { backend: _backend, modelSelection: _model, ...authored } = seat;
  return authored;
}

/** Why a started context cannot take the proposed entry, or null when nothing it started with changes. */
function startedChange(
  key: string,
  was: RunDefinitionContext,
  now: RunDefinitionContext,
): string | null {
  const structure = (c: RunDefinitionContext) => ({
    dependsOn: [...c.dependsOn].sort(),
    when: c.when ?? null,
    outputOnly: [...(c.outputOnly ?? [])].sort(),
    lane: c.lane ?? null,
    routing: c.routing ?? null,
  });
  if (!same(structure(was), structure(now)))
    return `"${key}" has started, so its dependencies, routes or lane cannot change`;
  // The checks it selected, wherever the compiler placed them; where it placed them comes next.
  const request = (c: RunDefinitionContext, placed: boolean) => {
    const { contract } = c.request;
    return {
      ...c.request,
      contract: {
        ...contract,
        implementer: authoredSeat(contract.implementer),
        reviewers: contract.reviewers.map((reviewer) => ({
          ...authoredSeat(reviewer),
          authority: reviewer.authority,
        })),
        checks: placed ? contract.checks : [...contract.checks, ...contract.deferredChecks].sort(),
        deferredChecks: placed ? contract.deferredChecks : [],
      },
    };
  };
  if (!same(request(was, false), request(now, false)))
    return `"${key}" has started, so its request (brief, tasks, criteria, checks, output schema, seats or policy) cannot change`;
  if (!same(request(was, true), request(now, true)))
    return `"${key}" has started, and this amendment changes which of its checks it runs itself (work beside it in its worktree decides that); keep that work as it was, or order new work after it`;
  return null;
}

const loopOf = (loops: readonly RunLoop[] | undefined, key: string): string | null =>
  (loops ?? []).find((loop) => loop.body.includes(key))?.key ?? null;

const ROUTE_DECISION: Partial<Record<string, string>> = {
  active: "taken",
  inactive: "not taken",
  omitted: "dropped, its source having been skipped",
};

/** Lanes whose code a lane's contexts need: the lanes its worktree must start from. */
function prerequisitesOf(
  contexts: readonly RunDefinitionContext[],
  lane: string,
): Set<string> {
  const laneOf = new Map(contexts.map((c) => [c.key, c.lane]));
  return new Set(
    contexts
      .filter((c) => c.lane === lane)
      .flatMap((c) =>
        c.dependsOn.flatMap((source) => {
          const from = laneOf.get(source);
          return from !== undefined &&
            from !== lane &&
            !(c.outputOnly ?? []).includes(source)
            ? [from]
            : [];
        }),
      ),
  );
}

const membersOf = (contexts: readonly RunDefinitionContext[], lane: string) =>
  contexts
    .filter((c) => c.lane === lane)
    .map((c) => c.key)
    .sort();

/**
 * Checks a proposed definition against what the Run already did, and builds
 * the next revision. Pure. The proposal must already pass the compiler; this
 * adds the rules only started work imposes (design §7.6): started contexts and
 * loop bodies, decided routes and skips, and lanes with a worktree keep what
 * they started with. A started context keeps its frozen entry.
 */
export function amendDefinition(
  facts: RunFacts,
  observed: ObservedContexts,
  proposed: ProposedDefinition,
): AmendmentResult {
  const issues: string[] = [];
  const plan = planRun(facts, observed);
  const current = facts.definition;
  const currentByKey = new Map(current.contexts.map((c) => [c.key, c]));
  const proposedByKey = new Map(proposed.contexts.map((c) => [c.key, c]));

  const started = new Set(facts.invocations.map((i) => i.key));
  const startedLoops = (current.loops ?? []).filter((loop) =>
    loop.body.some((key) => started.has(key)),
  );
  // A started loop's body is one unit: a member yet to run this pass is fixed too.
  const frozen = new Set([...started, ...startedLoops.flatMap((loop) => loop.body)]);
  for (const key of frozen) {
    const was = currentByKey.get(key);
    if (was === undefined) continue;
    const now = proposedByKey.get(key);
    if (now === undefined) {
      issues.push(`"${key}" has started, so it stays in the run; cancel the run to stop it`);
      continue;
    }
    const change = startedChange(key, was, now);
    if (change !== null) issues.push(change);
    // Joining or leaving a loop would run it again, or end it, after its result was used.
    if (loopOf(current.loops, key) !== loopOf(proposed.loops, key))
      issues.push(`"${key}" has started, so the loop it runs in cannot change`);
  }

  const proposedLoops = new Map((proposed.loops ?? []).map((loop) => [loop.key, loop]));
  for (const loop of startedLoops) {
    const amended = proposedLoops.get(loop.key);
    if (amended === undefined) {
      issues.push(`loop "${loop.key}" has started, so it stays in the run`);
      continue;
    }
    const { maxPasses: was, ...shape } = loop;
    const { maxPasses: now, ...amendedShape } = amended;
    if (!same(shape, amendedShape))
      issues.push(`loop "${loop.key}" has started, so only its maxPasses can change`);
    else if (now < was)
      issues.push(`loop "${loop.key}" has started, so its maxPasses can only rise from ${was}`);
  }

  const proposedLanes = proposed.lanes ?? [];
  for (const lane of current.lanes ?? []) {
    if (laneStateOf(facts, lane.key) === undefined) continue;
    if (!same(membersOf(current.contexts, lane.key), membersOf(proposed.contexts, lane.key)))
      issues.push(`lane "${lane.key}" has been provisioned, or asked to be, so which contexts work in it cannot change`);
    const amended = proposedLanes.find((l) => l.key === lane.key);
    if (!same(lane.checks, amended?.checks ?? []))
      issues.push(`lane "${lane.key}" has been provisioned, or asked to be, so its publication checks cannot change`);
    const had = prerequisitesOf(current.contexts, lane.key);
    const gained = [...prerequisitesOf(proposed.contexts, lane.key)].filter((from) => !had.has(from));
    if (gained.length > 0)
      issues.push(
        `lane "${lane.key}" was provisioned, or asked to be, without the code of lane ${quoted(gained)}, so its contexts cannot come to need it`,
      );
  }


  if (issues.length > 0) return { ok: false, issues };
  const lanes = proposedLanes.map((lane) =>
    laneStateOf(facts, lane.key) === undefined
      ? lane
      : ((current.lanes ?? []).find((l) => l.key === lane.key) ?? lane),
  );
  const definition: RunFacts["definition"] = {
    revision: current.revision + 1,
    contexts: proposed.contexts.map((c) =>
      frozen.has(c.key) ? (currentByKey.get(c.key) ?? c) : c,
    ),
    ...(proposed.loops !== undefined ? { loops: proposed.loops } : {}),
    ...(lanes.length > 0 ? { lanes } : {}),
    ...(proposed.authored !== undefined ? { authored: proposed.authored } : {}),
  };

  // Routes already decided stay decided: the amended definition, read against
  // what already happened, must take, leave or drop each kept edge as before
  // and skip what was skipped. An edge still undecided, such as a halted
  // source's, may change: that is how a route halt clears.
  const next = planRun({ ...facts, definition }, observed);
  for (const [edgeId, route] of plan.routes) {
    const decided = ROUTE_DECISION[route.resolution];
    if (decided === undefined) continue;
    const now = next.routes.get(edgeId);
    // A route not taken decides its target's skip, even while the target still waits on other work.
    const dropped =
      now === undefined &&
      route.resolution === "inactive" &&
      proposedByKey.has(route.target) &&
      next.keys.get(route.target)?.kind !== "skipped";
    if (now === undefined ? !dropped : now.resolution === route.resolution) continue;
    issues.push(`the route from "${route.source}" to "${route.target}" was ${decided}, and this amendment would change that`);
  }
  for (const [key, state] of plan.keys) {
    if (state.kind !== "skipped" || !proposedByKey.has(key)) continue;
    if (next.keys.get(key)?.kind !== "skipped")
      issues.push(`"${key}" was skipped by a route that already ran, so it stays skipped; add a new context for that work instead`);
  }
  // A skipped lane contributed no code, and lanes and the session went on without it: it stays skipped.
  for (const lane of current.lanes ?? []) {
    if (laneStateOf(facts, lane.key) !== undefined) continue;
    const members = membersOf(current.contexts, lane.key);
    if (members.length === 0 || !members.every((key) => plan.keys.get(key)?.kind === "skipped")) continue;
    if (membersOf(proposed.contexts, lane.key).some((key) => next.keys.get(key)?.kind !== "skipped"))
      issues.push(`lane "${lane.key}" was skipped, as every context in it was; put new work in a new lane`);
  }
  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, title: proposed.title, definition };
}
