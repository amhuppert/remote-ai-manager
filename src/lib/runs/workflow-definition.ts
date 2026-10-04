import { z } from "zod";
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

export const workflowContextRequestSchema = agentLaunchRequestSchema
  .extend({
    key: z
      .string()
      .regex(
        /^[a-z0-9][a-z0-9_-]{0,47}$/,
        "Use 1-48 lowercase letters, digits, - or _, starting with a letter or digit",
      ),
    dependsOn: z.array(z.string().min(1)).optional(),
    scope: workspaceScopeSchema.optional(),
  })
  .strict();
export type WorkflowContextRequest = z.infer<
  typeof workflowContextRequestSchema
>;

/** One problem with a definition, located by its path in the request. */
interface DefinitionIssue {
  path: Array<string | number>;
  message: string;
}

interface WorkflowAnalysis {
  issues: DefinitionIssue[];
  /** Each context's dependencies as keys, deduplicated, by position. */
  dependsOn: string[][];
  /** The selected checks each context leaves to later work, by position. */
  deferred: Array<Set<string>>;
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

function readDependencies(
  contexts: readonly WorkflowContextRequest[],
): { issues: DefinitionIssue[]; dependsOn: string[][] } {
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
  const dependsOn = contexts.map((context, index) => {
    const known = new Set<string>();
    (context.dependsOn ?? []).forEach((dependency, position) => {
      const path = ["contexts", index, "dependsOn", position];
      if (dependency === context.key)
        issues.push({ path, message: "A context cannot depend on itself" });
      else if (!firstIndex.has(dependency))
        issues.push({
          path,
          message: `"${dependency}" names no context in this workflow`,
        });
      else known.add(dependency);
    });
    return [...known];
  });
  return { issues, dependsOn };
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
 * later context that depends on it and selects the same check covers it, and
 * that context's own check is judged the same way, so coverage chains end at a
 * check no writer can run alongside.
 */
function analyzeWorkflow(
  contexts: readonly WorkflowContextRequest[],
): WorkflowAnalysis {
  const read = readDependencies(contexts);
  const none = { dependsOn: read.dependsOn, deferred: [] };
  if (read.issues.length > 0) return { issues: read.issues, ...none };
  const cycle = findCycle(contexts, read.dependsOn);
  if (cycle !== null) return { issues: [cycle], ...none };

  const ancestors = ancestorsOf(contexts, read.dependsOn);
  const runsBefore = (earlier: string, later: string): boolean =>
    ancestors.get(later)?.has(earlier) ?? false;
  const concurrent = (a: string, b: string): boolean =>
    a !== b && !runsBefore(a, b) && !runsBefore(b, a);

  const issues: DefinitionIssue[] = [];
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
    (context.checks ?? []).forEach((command, position) => {
      const covered = contexts.some(
        (other) =>
          runsBefore(context.key, other.key) &&
          (other.checks ?? []).includes(command),
      );
      if (covered) {
        leaves.add(command);
        return;
      }
      issues.push({
        path: ["contexts", index, "checks", position],
        message: `"${command}" checks the whole tree, but "${alongside.key}" writes in the same workspace while "${context.key}" runs, so it cannot certify "${context.key}" alone. Add a context that depends on "${context.key}" and selects "${command}"; it runs the check on the assembled tree.`,
      });
    });
    return leaves;
  });
  return { issues, dependsOn: read.dependsOn, deferred };
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
  })
  .strict()
  .superRefine((request, ctx) => {
    for (const issue of analyzeWorkflow(request.contexts).issues)
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
  const analysis = analyzeWorkflow(contexts);
  const first = analysis.issues[0];
  if (first !== undefined)
    throw new Error(`Cannot compile an unchecked workflow: ${first.message}`);
  return {
    runId: input.runId,
    cause: input.cause,
    kind: "workflow",
    title: input.request.title,
    projectPath: input.projectPath,
    sessionName: input.session.sessionName,
    owner: input.owner,
    contexts: contexts.map((context, index) => {
      const { key, dependsOn: _authored, scope: _scope, ...fields } = context;
      const seats = input.seats[key];
      if (seats === undefined)
        throw new Error(`No resolved seats for workflow context "${key}"`);
      return {
        key,
        dependsOn: analysis.dependsOn[index] ?? [],
        request: resolveContextStart({
          request: fields,
          key,
          placement: input,
          scope: scopeOf(context),
          seats,
          deferredChecks: analysis.deferred[index],
        }),
      };
    }),
  };
}
