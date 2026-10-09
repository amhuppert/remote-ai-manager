import { isDeepStrictEqual } from "node:util";
import { planRun, type ObservedContexts } from "./schedule";
import type { FrozenCharter } from "./charter";
import type { ProposedDocument } from "./documents";
import {
  laneCodePrerequisites,
  laneMembers,
  laneSkipped,
  loopOf,
} from "./topology";
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
  /** The workflow as its owner wrote it, without its documents, which the run keeps as revisions. */
  authored?: Record<string, unknown>;
  /** Every document the amended workflow declares, frozen as artifacts. */
  documents?: ProposedDocument[];
  /** The amended workflow's charter, each context's bundle frozen; none removes it. */
  charter?: FrozenCharter;
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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A context's entry as its owner wrote it, or null. */
export function writtenEntry(
  authored: Record<string, unknown> | undefined,
  key: string,
): Record<string, unknown> | null {
  const contexts = authored?.contexts;
  const entry = Array.isArray(contexts)
    ? contexts.find((c) => isRecord(c) && c.key === key)
    : undefined;
  return isRecord(entry) ? entry : null;
}

/** Its place in the graph as written: what it depends on (in any order), its routes and its lane. */
function placeOf(entry: Record<string, unknown>): unknown {
  const dependsOn = Array.isArray(entry.dependsOn) ? entry.dependsOn : [];
  return {
    dependsOn: dependsOn.map((d) => JSON.stringify(plain(d))).sort(),
    when: entry.when ?? null,
    lane: entry.lane ?? null,
    routing: entry.routing ?? null,
  };
}

/**
 * What it was given, as written: compared as written, because resolving it
 * again may fill in another backend or model while its owner changed nothing.
 */
function givenOf(entry: Record<string, unknown>): unknown {
  const {
    key: _key,
    dependsOn: _dependsOn,
    when: _when,
    lane: _lane,
    routing: _routing,
    ...given
  } = entry;
  return given;
}

/** Why a started context cannot take the proposed entry, or null when nothing it started with changes. */
function startedChange(
  key: string,
  was: { written: Record<string, unknown>; compiled: RunDefinitionContext },
  now: { written: Record<string, unknown>; compiled: RunDefinitionContext },
): string | null {
  if (!same(placeOf(was.written), placeOf(now.written)))
    return `"${key}" has started, so its dependencies, routes or lane cannot change`;
  if (!same(givenOf(was.written), givenOf(now.written)))
    return `"${key}" has started, so its request (brief, tasks, criteria, checks, output schema, seats or policy) cannot change`;
  // Where the compiler placed its checks depends on the work beside it.
  const placed = (c: RunDefinitionContext) => ({
    checks: c.request.contract.checks,
    deferredChecks: c.request.contract.deferredChecks,
  });
  if (!same(placed(was.compiled), placed(now.compiled)))
    return `"${key}" has started, and this amendment changes which of its checks it runs itself (work beside it in its worktree decides that); keep that work as it was, or order new work after it`;
  return null;
}

/**
 * The contexts an amendment keeps exactly as they started: every started one,
 * and every member of a started loop's body, which is one unit — a member yet
 * to run this pass is fixed too. Their resolved entries stand as frozen.
 */
export function frozenKeys(facts: RunFacts): Set<string> {
  const started = new Set(facts.invocations.map((i) => i.key));
  const startedLoops = (facts.definition.loops ?? []).filter((loop) =>
    loop.body.some((key) => started.has(key)),
  );
  return new Set([...started, ...startedLoops.flatMap((loop) => loop.body)]);
}

const loopKeyOf = (
  loops: readonly RunLoop[] | undefined,
  key: string,
): string | null => loopOf(loops, key)?.key ?? null;

const ROUTE_DECISION: Partial<Record<string, string>> = {
  active: "taken",
  inactive: "not taken",
  omitted: "dropped, its source having been skipped",
};

const memberKeysOf = (
  contexts: readonly RunDefinitionContext[],
  lane: string,
) =>
  laneMembers(contexts, lane)
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

  if (current.authored === undefined || proposed.authored === undefined)
    return {
      ok: false,
      issues: [
        "the run was launched before its definition could be read back, so it cannot be amended",
      ],
    };
  const started = new Set(facts.invocations.map((i) => i.key));
  const startedLoops = (current.loops ?? []).filter((loop) =>
    loop.body.some((key) => started.has(key)),
  );
  const frozen = frozenKeys(facts);
  for (const key of frozen) {
    const was = currentByKey.get(key);
    if (was === undefined) continue;
    const now = proposedByKey.get(key);
    const wasWritten = writtenEntry(current.authored, key);
    const nowWritten = writtenEntry(proposed.authored, key);
    if (now === undefined || nowWritten === null) {
      issues.push(
        `"${key}" has started, so it stays in the run; cancel the run to stop it`,
      );
      continue;
    }
    const change =
      wasWritten === null
        ? `"${key}" has started, and the run holds no written definition of it to compare with`
        : startedChange(
            key,
            { written: wasWritten, compiled: was },
            { written: nowWritten, compiled: now },
          );
    if (change !== null) issues.push(change);
    // Joining or leaving a loop would run it again, or end it, after its result was used.
    if (loopKeyOf(current.loops, key) !== loopKeyOf(proposed.loops, key))
      issues.push(`"${key}" has started, so the loop it runs in cannot change`);
  }

  const proposedLoops = new Map(
    (proposed.loops ?? []).map((loop) => [loop.key, loop]),
  );
  for (const loop of startedLoops) {
    const amended = proposedLoops.get(loop.key);
    if (amended === undefined) {
      issues.push(`loop "${loop.key}" has started, so it stays in the run`);
      continue;
    }
    const { maxPasses: was, ...shape } = loop;
    const { maxPasses: now, ...amendedShape } = amended;
    if (!same(shape, amendedShape))
      issues.push(
        `loop "${loop.key}" has started, so only its maxPasses can change`,
      );
    else if (now < was)
      issues.push(
        `loop "${loop.key}" has started, so its maxPasses can only rise from ${was}`,
      );
  }

  const proposedLanes = proposed.lanes ?? [];
  for (const lane of current.lanes ?? []) {
    if (laneStateOf(facts, lane.key) === undefined) continue;
    if (
      !same(
        memberKeysOf(current.contexts, lane.key),
        memberKeysOf(proposed.contexts, lane.key),
      )
    )
      issues.push(
        `lane "${lane.key}" has been provisioned, or asked to be, so which contexts work in it cannot change`,
      );
    const amended = proposedLanes.find((l) => l.key === lane.key);
    const placement = (l: RunLane | undefined) =>
      l === undefined
        ? null
        : {
            laneId: l.laneId,
            worktreePath: l.worktreePath,
            branch: l.branch,
            target: l.target,
          };
    if (amended !== undefined && !same(placement(lane), placement(amended)))
      issues.push(
        `lane "${lane.key}" has been provisioned, or asked to be, so its worktree and branch cannot change`,
      );
    if (!same(lane.checks, amended?.checks ?? []))
      issues.push(
        `lane "${lane.key}" has been provisioned, or asked to be, so its publication checks cannot change`,
      );
    const had = laneCodePrerequisites(current.contexts, lane.key);
    const gained = [
      ...laneCodePrerequisites(proposed.contexts, lane.key),
    ].filter((from) => !had.has(from));
    if (gained.length > 0)
      issues.push(
        `lane "${lane.key}" was provisioned, or asked to be, without the code of lane ${quoted(gained)}, so its contexts cannot come to need it`,
      );
  }

  if (issues.length > 0) return { ok: false, issues };
  // The compiler kept every lane the run named where it was, and a provisioned lane's checks are unchanged.
  const lanes = proposedLanes;
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
    if (now === undefined ? !dropped : now.resolution === route.resolution)
      continue;
    issues.push(
      `the route from "${route.source}" to "${route.target}" was ${decided}, and this amendment would change that`,
    );
  }
  for (const [key, state] of plan.keys) {
    if (state.kind !== "skipped" || !proposedByKey.has(key)) continue;
    if (next.keys.get(key)?.kind !== "skipped")
      issues.push(
        `"${key}" was skipped by a route that already ran, so it stays skipped; add a new context for that work instead`,
      );
  }
  // A skipped lane contributed no code, and lanes and the session went on without it: it stays skipped.
  for (const lane of current.lanes ?? []) {
    if (laneStateOf(facts, lane.key) !== undefined) continue;
    const isSkipped = (key: string) => plan.keys.get(key)?.kind === "skipped";
    if (
      memberKeysOf(current.contexts, lane.key).length === 0 ||
      !laneSkipped(current.contexts, lane.key, isSkipped)
    )
      continue;
    if (
      memberKeysOf(proposed.contexts, lane.key).some(
        (key) => next.keys.get(key)?.kind !== "skipped",
      )
    )
      issues.push(
        `lane "${lane.key}" was skipped, as every context in it was; put new work in a new lane`,
      );
  }
  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, title: proposed.title, definition };
}
