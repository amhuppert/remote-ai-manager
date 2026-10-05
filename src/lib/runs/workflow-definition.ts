import { z } from "zod";
import { checkGuardCompatibility } from "@/lib/workflow-graph/edge-guard-validation";
import {
  projectMustRunContextIds,
  projectRouteExclusion,
} from "@/lib/workflow-graph/route-projection";
import { validateOutputSchemaDeclaration } from "@/lib/workflows/primitives/output-schema-subset";
import { validationCommandNameSchema } from "@/lib/validation/schemas";
import { bindingScopesOverlap } from "@/lib/workspace/admission";
import {
  workspaceScopeSchema,
  type WorkspaceScope,
} from "@/lib/workspace/schemas";
import type { RunLaunchInput } from "./host";
import {
  agentLaunchRequestSchema,
  resolveContextStart,
  type LaunchPlacement,
  type ResolvedSeat,
} from "./launch";
import {
  routeCardinalitySchema,
  routeGuardSchema,
  runLoopSchema,
  type RouteGuard,
  type RunLane,
  type RunLoop,
} from "./schemas";

const keySchema = z
  .string()
  .regex(
    /^[a-z0-9][a-z0-9_-]{0,47}$/,
    "Use 1-48 lowercase letters, digits, - or _, starting with a letter or digit",
  );

/**
 * A lane key: also part of a branch name and a directory, so it neither ends in
 * `-` nor grows long.
 */
const laneKeySchema = z
  .string()
  .regex(
    /^[a-z0-9](?:[a-z0-9_-]{0,30}[a-z0-9_])?$/,
    "Use 1-32 lowercase letters, digits, - or _, starting with a letter or digit and not ending with -",
  );

/**
 * A dependency, always taken, or taken only when its guard matches the
 * source's accepted output. An output-only dependency needs the accepted
 * output, not the source's code, so it never waits for a publication.
 */
const dependencySchema = z.union([
  z.string().min(1),
  z
    .object({
      key: z.string().min(1),
      when: routeGuardSchema.optional(),
      outputOnly: z.literal(true).optional(),
    })
    .strict(),
]);

/** A lane's publication checks, run on the lane merged with the session head before it publishes. */
const workflowLaneRequestSchema = z
  .object({
    key: laneKeySchema,
    checks: z.array(validationCommandNameSchema).optional(),
  })
  .strict();

export const workflowContextRequestSchema = agentLaunchRequestSchema
  .extend({
    key: keySchema,
    dependsOn: z.array(dependencySchema).optional(),
    routing: z
      .object({ cardinality: routeCardinalitySchema })
      .strict()
      .optional(),
    scope: workspaceScopeSchema.optional(),
    /** Work in an isolated lane instead of the session worktree. */
    lane: laneKeySchema.optional(),
  })
  .strict();
export type WorkflowContextRequest = z.infer<
  typeof workflowContextRequestSchema
>;

export const workflowLoopRequestSchema = runLoopSchema
  .extend({ key: keySchema })
  .strict();

/** One problem with a definition, located by its path in the request. */
interface DefinitionIssue {
  path: Array<string | number>;
  message: string;
}

interface WorkflowAnalysis {
  issues: DefinitionIssue[];
  /** Each context's dependencies as keys, deduplicated, by position. */
  dependsOn: string[][];
  /** Each context's guarded dependencies, by position. */
  when: Array<Record<string, RouteGuard>>;
  /** The selected checks each context leaves to later work, by position. */
  deferred: Array<Set<string>>;
}

/** One known dependency as authored: its key, where it is written, its guard, and whether it needs code. */
interface Dependency {
  key: string;
  position: number;
  when: RouteGuard | undefined;
  outputOnly: boolean;
}

function describeScope(scope: WorkspaceScope): string {
  return scope.mode === "owned"
    ? `writes ${scope.paths.join(", ")}`
    : "writes the whole workspace";
}

/** Why two contexts that could run together may not, and the remedy that applies. */
function overlapMessage(
  earlier: WorkflowContextRequest,
  later: WorkflowContextRequest,
): string {
  const reader = [earlier, later].find((c) => scopeOf(c).mode === "readOnly");
  if (reader !== undefined) {
    const other = reader === earlier ? later : earlier;
    return `"${reader.key}" is read-only and reads the whole workspace, so it cannot run beside "${other.key}", which writes: order them with dependsOn.`;
  }
  return `"${earlier.key}" (${describeScope(scopeOf(earlier))}) and "${later.key}" (${describeScope(scopeOf(later))}) can run at the same time and would change the same files. Give them disjoint owned scopes, or order them with dependsOn.`;
}

const scopeOf = (context: WorkflowContextRequest): WorkspaceScope =>
  context.scope ?? { mode: "full" };

function readDependencies(contexts: readonly WorkflowContextRequest[]): {
  issues: DefinitionIssue[];
  dependencies: Dependency[][];
} {
  const issues: DefinitionIssue[] = [];
  const firstIndex = new Map<string, number>();
  contexts.forEach((context, index) => {
    const first = firstIndex.get(context.key);
    if (first === undefined) firstIndex.set(context.key, index);
    else
      issues.push({
        path: ["contexts", index, "key"],
        message: `Key "${context.key}" is already used by contexts[${first}]`,
      });
  });
  const dependencies = contexts.map((context, index) => {
    const known: Dependency[] = [];
    (context.dependsOn ?? []).forEach((entry, position) => {
      const key = typeof entry === "string" ? entry : entry.key;
      const when = typeof entry === "string" ? undefined : entry.when;
      const outputOnly = typeof entry !== "string" && entry.outputOnly === true;
      const path = ["contexts", index, "dependsOn", position];
      const earlier = known.find((d) => d.key === key);
      if (key === context.key)
        issues.push({ path, message: "A context cannot depend on itself" });
      else if (!firstIndex.has(key))
        issues.push({
          path,
          message: `"${key}" names no context in this workflow`,
        });
      else if (earlier === undefined)
        known.push({ key, position, when, outputOnly });
      else if (earlier.when !== undefined || when !== undefined || earlier.outputOnly !== outputOnly)
        issues.push({
          path,
          message: `"${key}" is already listed; list a guarded or output-only dependency once`,
        });
    });
    return known;
  });
  return { issues, dependencies };
}

const keysOf = (dependencies: readonly Dependency[][]): string[][] =>
  dependencies.map((list) => list.map((d) => d.key));

/** Why a subset document cannot be used, located inside it. */
const describeSchemaIssue = (issue: { path: string; message: string }) =>
  issue.path === "$" ? issue.message : `${issue.path}: ${issue.message}`;

/**
 * Route rules: a guard is evaluated over its source's accepted output, so the
 * source must declare an outputSchema in the supported subset, and the guard
 * must be in the subset and able to match what the source produces. A source
 * has at most one else route, an else needs a guarded sibling to fall back
 * from, and routing applies only to a source with guarded routes.
 */
function checkRoutes(
  contexts: readonly WorkflowContextRequest[],
  dependencies: readonly Dependency[][],
): DefinitionIssue[] {
  const issues: DefinitionIssue[] = [];
  const indexOf = new Map(contexts.map((c, index) => [c.key, index]));
  const unusableSources = new Set<string>();
  const elseRoutes = new Map<string, { target: string; path: DefinitionIssue["path"] }>();
  const guarded = new Set<string>();
  contexts.forEach((target, index) => {
    for (const dependency of dependencies[index] ?? []) {
      const guard = dependency.when;
      if (guard === undefined) continue;
      const source = dependency.key;
      const sourceIndex = indexOf.get(source) ?? -1;
      const path = ["contexts", index, "dependsOn", dependency.position, "when"];
      const sourceSchema = contexts[sourceIndex]?.outputSchema;
      if (sourceSchema === undefined) {
        issues.push({
          path,
          message: `"${source}" declares no outputSchema, so a route from it has no result to evaluate`,
        });
        unusableSources.add(source);
        continue;
      }
      const declared = validateOutputSchemaDeclaration(sourceSchema);
      if (declared.length > 0) {
        if (!unusableSources.has(source))
          issues.push({
            path: ["contexts", sourceIndex, "outputSchema"],
            message: `Routes from "${source}" evaluate this outputSchema, which the route evaluator cannot enforce: ${declared.map(describeSchemaIssue).join("; ")}`,
          });
        unusableSources.add(source);
        continue;
      }
      if ("else" in guard) {
        const first = elseRoutes.get(source);
        if (first !== undefined)
          issues.push({
            path,
            message: `"${source}" already has an else route (to "${first.target}"); a second else is ambiguous`,
          });
        else elseRoutes.set(source, { target: target.key, path });
        continue;
      }
      guarded.add(source);
      const unsupported = validateOutputSchemaDeclaration(guard.schema);
      for (const issue of unsupported)
        issues.push({ path: [...path, "schema"], message: describeSchemaIssue(issue) });
      if (unsupported.length > 0) continue;
      for (const issue of checkGuardCompatibility(guard.schema, sourceSchema))
        issues.push({
          path: [...path, "schema"],
          message: `Can never match what "${source}" produces: ${describeSchemaIssue(issue)}`,
        });
    }
  });
  // A source already refused for its schema is not judged again on routes the refusal hid.
  for (const [source, route] of elseRoutes) {
    if (guarded.has(source) || unusableSources.has(source)) continue;
    issues.push({
      path: route.path,
      message: `An else route is taken when no guarded route from "${source}" matched, but "${source}" has no guarded route`,
    });
  }
  contexts.forEach((context, index) => {
    if (context.routing === undefined || guarded.has(context.key)) return;
    if (unusableSources.has(context.key)) return;
    issues.push({
      path: ["contexts", index, "routing"],
      message: `routing counts the guarded routes from "${context.key}", and nothing depends on it with a schema guard`,
    });
  });
  return issues;
}

/**
 * Loop rules: a loop is one region of the graph with a single entry and exit,
 * so a pass runs its whole body and the exit's result decides alone. Only the
 * entry depends on work outside, only the exit is depended on from outside,
 * every member is reached from the entry and leads to the exit, the body has
 * no routes, and the exit condition is a subset document that can match the
 * exit's outputSchema. Loops do not nest or overlap.
 */
function checkLoops(
  loops: readonly RunLoop[],
  contexts: readonly WorkflowContextRequest[],
  dependencies: readonly Dependency[][],
): DefinitionIssue[] {
  const issues: DefinitionIssue[] = [];
  const indexOf = new Map(contexts.map((c, index) => [c.key, index]));
  const loopOf = new Map<string, string>();
  const loopKeys = new Set<string>();
  loops.forEach((loop, l) => {
    const base = ["loops", l];
    let sound = true;
    if (loopKeys.has(loop.key))
      issues.push({ path: [...base, "key"], message: `Loop key "${loop.key}" is already used` });
    loopKeys.add(loop.key);
    const members = new Set<string>();
    loop.body.forEach((member, b) => {
      const owner = loopOf.get(member);
      if (!indexOf.has(member)) {
        issues.push({ path: [...base, "body", b], message: `"${member}" names no context in this workflow` });
        sound = false;
      } else if (members.has(member)) {
        issues.push({ path: [...base, "body", b], message: `"${member}" is already in this loop` });
      } else if (owner !== undefined) {
        issues.push({
          path: [...base, "body", b],
          message: `"${member}" is already in loop "${owner}"; loops do not nest or overlap`,
        });
        sound = false;
      } else {
        members.add(member);
        loopOf.set(member, loop.key);
      }
    });
    for (const end of ["entry", "exit"] as const) {
      if (loop.body.includes(loop[end])) continue;
      issues.push({ path: [...base, end], message: `The ${end} "${loop[end]}" must be in the loop's body` });
      sound = false;
    }
    if (!sound) return;

    contexts.forEach((context, index) => {
      const inside = members.has(context.key);
      for (const dependency of dependencies[index] ?? []) {
        const path = ["contexts", index, "dependsOn", dependency.position];
        const fromInside = members.has(dependency.key);
        if (inside && context.key !== loop.entry && !fromInside)
          issues.push({
            path,
            message: `"${context.key}" is inside loop "${loop.key}", so only its entry "${loop.entry}" can depend on work outside the loop`,
          });
        else if (!inside && fromInside && dependency.key !== loop.exit)
          issues.push({
            path,
            message: `"${dependency.key}" is inside loop "${loop.key}"; work outside the loop can depend only on its exit "${loop.exit}", which carries the final pass's result`,
          });
        else if (inside && context.key !== loop.entry && dependency.when !== undefined)
          issues.push({
            path: [...path, "when"],
            message: `Routes inside loop "${loop.key}" are not supported: route into its entry "${loop.entry}" or out of its exit "${loop.exit}"`,
          });
      }
    });

    const depsOf = (key: string): string[] =>
      (dependencies[indexOf.get(key) ?? -1] ?? []).map((d) => d.key);
    const reached = new Set([loop.entry]);
    for (let grew = true; grew; ) {
      grew = false;
      for (const member of members) {
        if (reached.has(member) || !depsOf(member).some((d) => reached.has(d))) continue;
        reached.add(member);
        grew = true;
      }
    }
    const leads = new Set([loop.exit]);
    for (const key of leads)
      for (const dependency of depsOf(key))
        if (members.has(dependency)) leads.add(dependency);
    loop.body.forEach((member, b) => {
      if (!reached.has(member))
        issues.push({ path: [...base, "body", b], message: `"${member}" is not reached from the loop's entry "${loop.entry}"` });
      else if (!leads.has(member))
        issues.push({
          path: [...base, "body", b],
          message: `"${member}" does not lead to the loop's exit "${loop.exit}"; the exit decides each pass after the whole body ran`,
        });
    });

    const exitIndex = indexOf.get(loop.exit) ?? -1;
    const exitSchema = contexts[exitIndex]?.outputSchema;
    if (exitSchema === undefined) {
      issues.push({
        path: [...base, "exit"],
        message: `The exit "${loop.exit}" declares no outputSchema, so the exit condition has no result to evaluate`,
      });
      return;
    }
    const declared = validateOutputSchemaDeclaration(exitSchema);
    if (declared.length > 0) {
      issues.push({
        path: ["contexts", exitIndex, "outputSchema"],
        message: `Loop "${loop.key}" evaluates this outputSchema, which the exit condition cannot enforce: ${declared.map(describeSchemaIssue).join("; ")}`,
      });
      return;
    }
    const unsupported = validateOutputSchemaDeclaration(loop.until.schema);
    const unmatched =
      unsupported.length > 0 ? [] : checkGuardCompatibility(loop.until.schema, exitSchema);
    for (const issue of unsupported)
      issues.push({ path: [...base, "until", "schema"], message: describeSchemaIssue(issue) });
    for (const issue of unmatched)
      issues.push({
        path: [...base, "until", "schema"],
        message: `Can never match what "${loop.exit}" produces: ${describeSchemaIssue(issue)}`,
      });
  });
  return issues;
}

/** The workspace a context works in: its lane, or null for the session worktree. */
const workspaceOf = (context: WorkflowContextRequest): string | null =>
  context.lane ?? null;

/**
 * Lane rules. A lane starts from the session branch's committed head, so it
 * cannot see a session context's code, which is never committed; a lane that
 * needs code from another lane starts only once that lane has published, so
 * lanes needing each other's code would wait forever; a loop's passes run in
 * one workspace; a declared lane is one some context works in.
 */
function checkLanes(
  request: {
    contexts: readonly WorkflowContextRequest[];
    loops?: readonly RunLoop[] | undefined;
    lanes?: ReadonlyArray<{ key: string }> | undefined;
  },
  dependencies: readonly Dependency[][],
): DefinitionIssue[] {
  const { contexts } = request;
  const issues: DefinitionIssue[] = [];
  const indexOf = new Map(contexts.map((c, index) => [c.key, index]));
  const workspaceOfKey = (key: string): string | null => {
    const context = contexts[indexOf.get(key) ?? -1];
    return context === undefined ? null : workspaceOf(context);
  };
  const describe = (workspace: string | null) =>
    workspace === null ? "the session worktree" : `lane "${workspace}"`;

  (request.loops ?? []).forEach((loop, l) => {
    const home = workspaceOfKey(loop.entry);
    loop.body.forEach((member, b) => {
      if (!indexOf.has(member) || workspaceOfKey(member) === home) return;
      issues.push({
        path: ["loops", l, "body", b],
        message: `"${member}" works in ${describe(workspaceOfKey(member))}, but loop "${loop.key}" runs in ${describe(home)}; every pass of a loop works in one workspace`,
      });
    });
  });

  const used = new Set(contexts.flatMap((c) => (c.lane === undefined ? [] : [c.lane])));
  const declared = new Set<string>();
  (request.lanes ?? []).forEach((lane, index) => {
    if (declared.has(lane.key))
      issues.push({ path: ["lanes", index, "key"], message: `Lane "${lane.key}" is already declared` });
    else if (!used.has(lane.key))
      issues.push({ path: ["lanes", index, "key"], message: `No context works in lane "${lane.key}"` });
    declared.add(lane.key);
  });

  for (const context of contexts) {
    const lane = workspaceOf(context);
    if (lane === null) continue;
    for (const dependency of dependencies[contexts.indexOf(context)] ?? []) {
      if (dependency.outputOnly || workspaceOfKey(dependency.key) !== null) continue;
      issues.push({
        path: ["contexts", contexts.indexOf(context), "dependsOn", dependency.position],
        message: `"${dependency.key}" works in the session worktree, whose results are never committed, so lane "${lane}" cannot see its code. Mark the dependency outputOnly if "${context.key}" needs only its result, or place "${dependency.key}" in a lane.`,
      });
    }
  }
  issues.push(...checkWaits(contexts, dependencies));
  return issues;
}

/** One step something waits on before it can go: a context finishing, a lane starting, a lane publishing. */
type WaitNode = `context:${string}` | `starts:${string}` | `publishes:${string}`;

/**
 * Wait barriers: a lane's contexts start only once the lane starts, which
 * waits for every lane whose code they need to publish; a lane publishes only
 * once all its contexts finished; a context waits for what it depends on to
 * finish, and for the lane of a dependency it needs code from to publish. A
 * cycle among these never starts, so it is refused with the dependency that
 * closes it. Separately, a session context that writes leaves results the
 * session never commits, so any lane that publishes while they are there is
 * blocked: such a context must wait for every lane to publish.
 */
function checkWaits(
  contexts: readonly WorkflowContextRequest[],
  dependencies: readonly Dependency[][],
): DefinitionIssue[] {
  const issues: DefinitionIssue[] = [];
  const laneOfKey = new Map(contexts.map((c) => [c.key, workspaceOf(c)]));
  const edges = new Map<WaitNode, Array<{ to: WaitNode; at?: DefinitionIssue["path"] }>>();
  const wait = (from: WaitNode, to: WaitNode, at?: DefinitionIssue["path"]) => {
    const list = edges.get(from) ?? [];
    list.push(at === undefined ? { to } : { to, at });
    edges.set(from, list);
  };
  contexts.forEach((context, index) => {
    const self: WaitNode = `context:${context.key}`;
    const lane = workspaceOf(context);
    if (lane !== null) {
      wait(`starts:${lane}`, self);
      wait(self, `publishes:${lane}`);
    }
    for (const dependency of dependencies[index] ?? []) {
      const at = ["contexts", index, "dependsOn", dependency.position];
      const from = laneOfKey.get(dependency.key) ?? null;
      wait(`context:${dependency.key}`, self, at);
      if (dependency.outputOnly || from === lane || from === null) continue;
      wait(`publishes:${from}`, self, at);
      if (lane !== null) wait(`publishes:${from}`, `starts:${lane}`, at);
    }
  });

  const describe = (node: WaitNode): string => {
    const [kind, name] = node.split(/:(.*)/s) as [string, string];
    return kind === "context" ? `"${name}"` : `lane "${name}" ${kind}`;
  };
  const state = new Map<WaitNode, "visiting" | "done">();
  const trail: Array<{ node: WaitNode; at?: DefinitionIssue["path"] }> = [];
  const visit = (node: WaitNode): boolean => {
    state.set(node, "visiting");
    for (const edge of edges.get(node) ?? []) {
      const step = edge.at === undefined ? { node: edge.to } : { node: edge.to, at: edge.at };
      if (state.get(edge.to) === "visiting") {
        // The steps since the cycle's first node; the search's root is not on the trail.
        const start = trail.findIndex((earlier) => earlier.node === edge.to);
        const cycle = [...trail.slice(start + 1), step];
        const located = [...cycle].reverse().find((earlier) => earlier.at !== undefined);
        issues.push({
          path: located?.at ?? ["contexts"],
          message: `These wait for each other and never start: ${[edge.to, ...cycle.map((earlier) => earlier.node)].map(describe).join(" → ")}. Mark a dependency outputOnly, or move the contexts into one lane.`,
        });
        return true;
      }
      trail.push(step);
      if (state.get(edge.to) === undefined && visit(edge.to)) return true;
      trail.pop();
    }
    state.set(node, "done");
    return false;
  };
  for (const context of contexts) {
    const node: WaitNode = `context:${context.key}`;
    if (state.get(node) === undefined && visit(node)) return issues;
  }

  const lanes = [...new Set(contexts.flatMap((c) => (c.lane === undefined ? [] : [c.lane])))];
  const after = (from: WaitNode): Set<WaitNode> => {
    const reached = new Set<WaitNode>([from]);
    for (const node of reached)
      for (const edge of edges.get(node) ?? []) reached.add(edge.to);
    return reached;
  };
  const afterPublication = new Map(lanes.map((lane) => [lane, after(`publishes:${lane}`)]));
  contexts.forEach((context, index) => {
    if (context.lane !== undefined || scopeOf(context).mode === "readOnly") return;
    const blocked = lanes.find(
      (lane) => !(afterPublication.get(lane)?.has(`context:${context.key}`) ?? false),
    );
    if (blocked === undefined) return;
    issues.push({
      path: ["contexts", index],
      message: `"${context.key}" writes in the session worktree, whose results are never committed, and lane "${blocked}" could publish while they are there, which publication refuses. Make "${context.key}" depend on the work in lane "${blocked}", place it in a lane, or make it read-only.`,
    });
  });
  return issues;
}

/** The definition as the route owner reads it: keys and guarded dependency edges. */
function routeTopology(
  contexts: readonly WorkflowContextRequest[],
  dependencies: readonly Dependency[][],
) {
  return {
    executionContexts: contexts.map((context) => ({
      id: context.key,
      routing: context.routing,
    })),
    edges: contexts.flatMap((target, index) =>
      (dependencies[index] ?? []).map((dependency) => ({
        id: `${dependency.key}->${target.key}`,
        sourceContextId: dependency.key,
        targetContextId: target.key,
        when: dependency.when,
      })),
    ),
  };
}

function findCycle(
  contexts: readonly WorkflowContextRequest[],
  dependsOn: readonly string[][],
): DefinitionIssue | null {
  const indexOf = new Map(contexts.map((c, index) => [c.key, index]));
  const state = new Map<string, "visiting" | "done">();
  const stack: string[] = [];
  function visit(key: string): DefinitionIssue | null {
    state.set(key, "visiting");
    stack.push(key);
    const index = indexOf.get(key) ?? -1;
    for (const dependency of dependsOn[index] ?? []) {
      if (state.get(dependency) === "visiting") {
        const loop = [...stack.slice(stack.indexOf(dependency)), dependency];
        return {
          path: ["contexts", index, "dependsOn"],
          message: `Dependency cycle: ${loop.join(" → ")}`,
        };
      }
      if (state.get(dependency) === undefined) {
        const found = visit(dependency);
        if (found !== null) return found;
      }
    }
    stack.pop();
    state.set(key, "done");
    return null;
  }
  for (const context of contexts) {
    if (state.get(context.key) !== undefined) continue;
    const found = visit(context.key);
    if (found !== null) return found;
  }
  return null;
}

/** Every key each context depends on, directly or through another. */
function ancestorsOf(
  contexts: readonly WorkflowContextRequest[],
  dependsOn: readonly string[][],
): Map<string, Set<string>> {
  const indexOf = new Map(contexts.map((c, index) => [c.key, index]));
  const memo = new Map<string, Set<string>>();
  function ancestors(key: string): Set<string> {
    const known = memo.get(key);
    if (known !== undefined) return known;
    const all = new Set<string>();
    for (const dependency of dependsOn[indexOf.get(key) ?? -1] ?? []) {
      all.add(dependency);
      for (const further of ancestors(dependency)) all.add(further);
    }
    memo.set(key, all);
    return all;
  }
  for (const context of contexts) ancestors(context.key);
  return memo;
}

/**
 * The topology rules, independent of seats and placement. Pure. Contexts share
 * the session workspace, so this refuses what would otherwise surface as a
 * silent wait or an unsound check: contexts that could run together with
 * overlapping bindings (design §6.2, Workspace's own relation), and a
 * whole-tree check of a context other writers could change underneath it with
 * nothing to run it on the assembled tree (§7.4). A check is an integration
 * check for a context when a writer other than it can run alongside it; a
 * later context that runs whenever it runs and selects the same check covers
 * it, and that context's own check is judged the same way, so coverage chains
 * end at a check no writer can run alongside. Branches a route never takes
 * together do not run alongside each other; a context a route can skip covers
 * nothing. Routes and loops are checked by checkRoutes and checkLoops.
 */
function analyzeWorkflow(request: {
  contexts: readonly WorkflowContextRequest[];
  loops?: readonly RunLoop[] | undefined;
  lanes?: ReadonlyArray<{ key: string; checks?: string[] | undefined }> | undefined;
}): WorkflowAnalysis {
  const { contexts } = request;
  const read = readDependencies(contexts);
  const dependsOn = keysOf(read.dependencies);
  const when = read.dependencies.map((list) =>
    Object.fromEntries(
      list.flatMap((d) => (d.when === undefined ? [] : [[d.key, d.when] as const])),
    ),
  );
  const none = { dependsOn, when, deferred: [] };
  if (read.issues.length > 0) return { issues: read.issues, ...none };
  const cycle = findCycle(contexts, dependsOn);
  if (cycle !== null) return { issues: [cycle], ...none };

  const issues: DefinitionIssue[] = [
    ...checkRoutes(contexts, read.dependencies),
    ...checkLoops(request.loops ?? [], contexts, read.dependencies),
    ...checkLanes(request, read.dependencies),
  ];
  const workspaceByKey = new Map(contexts.map((c) => [c.key, workspaceOf(c)]));
  const sameWorkspace = (a: string, b: string): boolean =>
    workspaceByKey.get(a) === workspaceByKey.get(b);
  const laneChecks = new Map(
    (request.lanes ?? []).map((lane) => [lane.key, lane.checks ?? []]),
  );
  const ancestors = ancestorsOf(contexts, dependsOn);
  const runsBefore = (earlier: string, later: string): boolean =>
    ancestors.get(later)?.has(earlier) ?? false;
  const topology = routeTopology(contexts, read.dependencies);
  const exclusive = projectRouteExclusion(topology);
  // Only work in one workspace can change files under another's feet.
  const concurrent = (a: string, b: string): boolean =>
    a !== b &&
    sameWorkspace(a, b) &&
    !runsBefore(a, b) &&
    !runsBefore(b, a) &&
    !exclusive(a, b);

  contexts.forEach((later, laterIndex) => {
    for (const earlier of contexts.slice(0, laterIndex)) {
      if (!concurrent(earlier.key, later.key)) continue;
      if (!bindingScopesOverlap(scopeOf(earlier), scopeOf(later))) continue;
      issues.push({
        path: ["contexts", laterIndex, "scope"],
        message: overlapMessage(earlier, later),
      });
    }
  });

  const writers = contexts.filter((c) => scopeOf(c).mode !== "readOnly");
  const deferred = contexts.map((context, index) => {
    const alongside = writers.find((w) => concurrent(w.key, context.key));
    const leaves = new Set<string>();
    if (alongside === undefined) return leaves;
    const certain = projectMustRunContextIds(topology, { given: context.key });
    const lane = workspaceOf(context);
    (context.checks ?? []).forEach((command, position) => {
      if (lane !== null && (laneChecks.get(lane) ?? []).includes(command)) {
        leaves.add(command);
        return;
      }
      const selecting = contexts.filter(
        (other) =>
          sameWorkspace(context.key, other.key) &&
          runsBefore(context.key, other.key) &&
          (other.checks ?? []).includes(command),
      );
      if (selecting.some((other) => certain.has(other.key))) {
        leaves.add(command);
        return;
      }
      const skippable = selecting[0];
      const remedy =
        lane === null
          ? `Add a context that depends on "${context.key}" and selects "${command}"; it runs the check on the assembled tree.`
          : `Add "${command}" to lane "${lane}"'s publication checks, which run on the lane merged with the session, or add a context in the lane that depends on "${context.key}" and selects it.`;
      issues.push({
        path: ["contexts", index, "checks", position],
        message: `"${command}" checks the whole tree, but "${alongside.key}" writes in the same workspace while "${context.key}" runs, so it cannot certify "${context.key}" alone. ${remedy}${skippable === undefined ? "" : ` "${skippable.key}" selects it, but a route can skip "${skippable.key}".`}`,
      });
    });
    return leaves;
  });
  return { issues, dependsOn, when, deferred };
}

/**
 * A workflow launch. Parsing it applies the topology rules too, so the CLI's
 * check verb, the launch route and the compiler refuse the same definitions
 * with the same located issues.
 */
export const workflowLaunchRequestSchema = z
  .object({
    title: z.string().trim().min(1).max(120),
    contexts: z.array(workflowContextRequestSchema).min(1),
    loops: z.array(workflowLoopRequestSchema).optional(),
    lanes: z.array(workflowLaneRequestSchema).optional(),
  })
  .strict()
  .superRefine((request, ctx) => {
    for (const issue of analyzeWorkflow(request).issues)
      ctx.addIssue({ code: "custom", path: issue.path, message: issue.message });
  });
export type WorkflowLaunchRequest = z.infer<typeof workflowLaunchRequestSchema>;

type Seats = { implementer: ResolvedSeat; reviewers: ResolvedSeat[] };

/**
 * Freezes a parsed workflow definition into a Run launch. Pure. The request
 * must come from workflowLaunchRequestSchema, which already refused every
 * definition this cannot compile.
 */
export function compileWorkflow(
  input: LaunchPlacement & {
    request: WorkflowLaunchRequest;
    seats: Record<string, Seats>;
  },
): RunLaunchInput {
  const contexts = input.request.contexts;
  const analysis = analyzeWorkflow(input.request);
  const first = analysis.issues[0];
  if (first !== undefined)
    throw new Error(`Cannot compile an unchecked workflow: ${first.message}`);
  const lanes = freezeLanes(input);
  const laneByKey = new Map(lanes.map((lane) => [lane.key, lane]));
  return {
    runId: input.runId,
    cause: input.cause,
    kind: "workflow",
    title: input.request.title,
    projectPath: input.projectPath,
    sessionName: input.session.sessionName,
    owner: input.owner,
    ...(input.request.loops !== undefined ? { loops: input.request.loops } : {}),
    ...(lanes.length > 0 ? { lanes } : {}),
    authored: input.request,
    contexts: contexts.map((context, index) => {
      const {
        key,
        dependsOn: authored,
        routing,
        scope: _scope,
        lane: laneKey,
        ...fields
      } = context;
      const lane = laneKey === undefined ? undefined : laneByKey.get(laneKey);
      const outputOnly = (authored ?? []).flatMap((entry) =>
        typeof entry !== "string" && entry.outputOnly === true ? [entry.key] : [],
      );
      const seats = input.seats[key];
      if (seats === undefined)
        throw new Error(`No resolved seats for workflow context "${key}"`);
      const when = analysis.when[index] ?? {};
      return {
        key,
        dependsOn: analysis.dependsOn[index] ?? [],
        ...(Object.keys(when).length > 0 ? { when } : {}),
        ...(routing !== undefined ? { routing } : {}),
        ...(outputOnly.length > 0 ? { outputOnly } : {}),
        ...(lane !== undefined ? { lane: lane.key } : {}),
        request: resolveContextStart({
          request: fields,
          key,
          placement: input,
          scope: scopeOf(context),
          seats,
          deferredChecks: analysis.deferred[index],
          ...(lane !== undefined
            ? { lane: { worktreePath: lane.worktreePath, branch: lane.branch } }
            : {}),
        }),
      };
    }),
  };
}

/**
 * Every lane the contexts work in, in order of first use, named for this run so
 * two runs in one session never share a lane worktree or branch.
 */
function freezeLanes(
  input: LaunchPlacement & { request: WorkflowLaunchRequest },
): RunLane[] {
  const runTag = input.runId.replace(/^run-/, "").slice(0, 8);
  const keys = [
    ...new Set(
      input.request.contexts.flatMap((c) => (c.lane === undefined ? [] : [c.lane])),
    ),
  ];
  return keys.map((key) => {
    const laneId = `${runTag}-${key}`;
    return {
      key,
      laneId,
      ...input.laneTargets(laneId),
      target: {
        worktreePath: input.session.worktreePath,
        branch: input.session.branch,
      },
      checks:
        input.request.lanes?.find((lane) => lane.key === key)?.checks ?? [],
    };
  });
}
