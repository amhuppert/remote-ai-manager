import type { GraphWorkflowPlanRepairPolicy } from "@/lib/workflow-graph/config-schemas";
import { EXECUTION_TOTAL_PASS_BACKSTOP } from "@/lib/workflow-graph/constants";
import type {
  GraphWorkflowContextEdge,
  GraphWorkflowLoopBodyTemplate,
  GraphWorkflowLoopGroup,
  GraphWorkflowLoopPredicate,
  GraphWorkflowResolvedContext,
  GraphWorkflowResolvedLoopGroup,
  GraphWorkflowTaskDefinition,
  WorkflowGraphValidationError,
} from "@/lib/workflow-graph/definition-schemas";
// The dependency-free subset module, NOT the gate that re-exports it — same
// reason as `edge-guard-validation.ts`: this file is reached from
// `validation.ts`, which a `"use client"` builder component imports.
import { validateOutputSchemaDeclaration } from "@/lib/workflows/primitives/output-schema-subset";
import {
  checkGuardCompatibility,
  type EdgeGuardDeclaration,
} from "./edge-guard-validation";

/**
 * Loop groups: the accept-time contract and the seed-time resolver (D4 R9,
 * R10, R11).
 *
 * A loop group repeats a connected single-entry/single-exit body of one or
 * more contexts by UNROLLING it into immutable per-pass instances. Nothing in
 * this module runs a loop; it owns the two moments before the engine ever sees
 * one:
 *
 *  1. **Accept time** — {@link validateLoopGroups}, reached from
 *     `validateWorkflowDefinition`, so every definition-accept path (create,
 *     replace, saved-tier edit, seed re-validation, live-edit frontier) refuses
 *     the same malformed loop with the same located error.
 *  2. **Seed time** — {@link resolveLoopGroups}, reached from
 *     `resolveWorkflowDefinition`, which snapshots the authored body into the
 *     versioned template and materializes pass 1.
 *
 * The two expansion refusals R11 names —
 * {@link validateExpansionPayloadLoopDeclarations} and
 * {@link validateExpansionInitiator} — live here too, because both are
 * statements about loop composition rather than about expansion mechanics; the
 * expansion command calls them at its own accept point.
 */

// ============================================================
// The reserved pass-instance id namespace
// ============================================================

/**
 * Pass instances are minted as `<loopGroupId>__p<K>__<authoredId>` for
 * contexts, tasks, AND edges, so one authored body can be unrolled any number
 * of times without a generated id ever colliding with an authored one — which
 * is only true while the namespace stays reserved. An authored id inside it is
 * refused at accept time (see {@link validateLoopGroups}).
 */
export function loopInstanceId(
  loopGroupId: string,
  pass: number,
  authoredId: string,
): string {
  return `${loopGroupId}__p${pass}__${authoredId}`;
}

/** Recognizes the reserved infix; the group prefix is checked separately. */
export const RESERVED_LOOP_INSTANCE_ID_PATTERN = /__p[1-9][0-9]*__/;

/**
 * The authored-id slot the prior-exit wiring edge is minted under, so pass
 * K+1's only incoming edge lives in the same reserved namespace as every other
 * pass instance. Suffixed rather than free-form because a template edge whose
 * authored id collided with it would produce two edges with one id.
 */
export const LOOP_PASS_ENTRY_EDGE_SUFFIX = "__loop_pass_entry__";

/** A pass instance id decomposed back into the three parts it was minted from. */
export interface ParsedLoopInstanceId {
  readonly loopGroupId: string;
  readonly pass: number;
  readonly authoredId: string;
}

/**
 * Decode a pass instance id against the DECLARED group ids — the inverse of
 * {@link loopInstanceId}, and the only place the reserved namespace is read
 * back. Checked against the declared ids rather than by regex alone, so an id
 * merely shaped like some other group's instance does not decode.
 *
 * Read surfaces use this to answer "which loop, and which pass" for a
 * materialized instance; validation uses it to tell a legitimately minted id
 * from an authored one squatting in the reserved namespace.
 */
export function parseLoopInstanceId(
  id: string,
  loopGroupIds: Iterable<string>,
): ParsedLoopInstanceId | null {
  for (const loopGroupId of loopGroupIds) {
    const marker = `${loopGroupId}__p`;
    if (!id.startsWith(marker)) continue;
    const rest = id.slice(marker.length);
    const separator = rest.indexOf("__");
    if (separator <= 0) continue;
    const pass = rest.slice(0, separator);
    if (!/^[1-9][0-9]*$/.test(pass)) continue;
    return {
      loopGroupId,
      pass: Number(pass),
      authoredId: rest.slice(separator + "__".length),
    };
  }
  return null;
}

/**
 * True when `id` is a pass instance minted for one of `namespaces` — the ONLY
 * legitimate inhabitant of the reserved namespace.
 */
function isMintedInstanceId(
  id: string,
  namespaces: ReadonlySet<string>,
): boolean {
  return parseLoopInstanceId(id, namespaces) !== null;
}

// ============================================================
// Structural read shapes
// ============================================================

export interface LoopContextLike {
  readonly id: string;
  readonly outputSchema?: Record<string, unknown> | undefined;
}

export interface LoopTaskLike {
  readonly id: string;
  readonly contextId: string;
}

export interface LoopEdgeLike {
  readonly id: string;
  readonly sourceContextId: string;
  readonly targetContextId: string;
  readonly when?: EdgeGuardDeclaration | undefined;
}

/** An authored group: the body is named by reference into the definition. */
export interface AuthoredLoopGroupLike {
  readonly id: string;
  readonly bodyContextIds: readonly string[];
  readonly entryContextId: string;
  readonly exitContextId: string;
  readonly until: GraphWorkflowLoopPredicate;
  readonly maxPasses: number;
}

/** A resolved group: the body is carried inline as the versioned template. */
export interface ResolvedLoopGroupLike {
  readonly id: string;
  readonly entryContextId: string;
  readonly exitContextId: string;
  readonly until: GraphWorkflowLoopPredicate;
  readonly maxPasses: number;
  readonly template: {
    readonly contexts: readonly LoopContextLike[];
    readonly tasks: readonly LoopTaskLike[];
    readonly edges: readonly LoopEdgeLike[];
  };
}

export type LoopGroupLike = AuthoredLoopGroupLike | ResolvedLoopGroupLike;

/**
 * Read structurally, like the guard validator's inputs: an authored definition
 * and a resolved one differ only in how the body is carried, so one walk serves
 * both tiers.
 */
export interface LoopValidatableDefinition {
  readonly executionContexts: readonly LoopContextLike[];
  readonly tasks: readonly LoopTaskLike[];
  readonly edges: readonly LoopEdgeLike[];
  readonly loopGroups?: readonly LoopGroupLike[] | undefined;
}

function isResolvedGroup(group: LoopGroupLike): group is ResolvedLoopGroupLike {
  return Object.prototype.hasOwnProperty.call(group, "template");
}

// ============================================================
// Accept-time validation
// ============================================================

/**
 * The body a group declares, normalized across tiers: an authored group's body
 * is gathered from the definition by id, a resolved group's is read off its
 * template. Everything downstream — connectivity, single-entry/single-exit,
 * reconvergence, the terminal contract — reads this one shape.
 */
interface LoopBodyProjection {
  readonly group: LoopGroupLike;
  readonly index: number;
  readonly bodyContextIds: readonly string[];
  readonly contextsById: ReadonlyMap<string, LoopContextLike>;
  readonly internalEdges: readonly LoopEdgeLike[];
  /** Body ids the authored definition does not declare (resolved: never). */
  readonly missingContextIds: readonly string[];
}

function projectBody(
  definition: LoopValidatableDefinition,
  group: LoopGroupLike,
  index: number,
): LoopBodyProjection {
  if (isResolvedGroup(group)) {
    return {
      group,
      index,
      bodyContextIds: group.template.contexts.map((context) => context.id),
      contextsById: new Map(
        group.template.contexts.map((context) => [context.id, context]),
      ),
      internalEdges: group.template.edges,
      missingContextIds: [],
    };
  }

  const declared = new Map(
    definition.executionContexts.map((context) => [context.id, context]),
  );
  const contextsById = new Map<string, LoopContextLike>();
  const missingContextIds: string[] = [];
  for (const contextId of group.bodyContextIds) {
    const context = declared.get(contextId);
    if (context === undefined) {
      missingContextIds.push(contextId);
      continue;
    }
    contextsById.set(contextId, context);
  }

  const body = new Set(group.bodyContextIds);
  return {
    group,
    index,
    bodyContextIds: group.bodyContextIds,
    contextsById,
    internalEdges: definition.edges.filter(
      (edge) =>
        body.has(edge.sourceContextId) && body.has(edge.targetContextId),
    ),
    missingContextIds,
  };
}

export function validateLoopGroups(
  definition: LoopValidatableDefinition,
): WorkflowGraphValidationError[] {
  const groups = definition.loopGroups ?? [];
  const errors: WorkflowGraphValidationError[] = [];

  errors.push(...validateReservedIds(definition, groups));
  if (groups.length === 0) return errors;

  const seenGroupIds = new Set<string>();
  const projections: LoopBodyProjection[] = [];

  groups.forEach((group, index) => {
    if (seenGroupIds.has(group.id)) {
      errors.push({
        code: "duplicate-loop-group-id",
        message: `Loop group "${group.id}" is declared more than once`,
        field: `loopGroups[${index}].id`,
      });
      return;
    }
    seenGroupIds.add(group.id);
    projections.push(projectBody(definition, group, index));
  });

  errors.push(...validateBodyDisjointness(projections));

  for (const projection of projections) {
    errors.push(...validateBodyMembership(projection));
    errors.push(...validateBodyShape(projection));
    errors.push(...validateBoundaryEdges(definition, projection));
    errors.push(...validateTerminalContract(projection));
    errors.push(...validatePassBudget(projection));
  }

  return errors;
}

/**
 * The static half of the execution pass backstop (R10.3).
 *
 * A declared cap above {@link EXECUTION_TOTAL_PASS_BACKSTOP} is an author — or a
 * repair — asking for more passes than the execution can ever admit, and the
 * runtime backstop would halt the run partway through the budget the plan
 * promised. Refusing here says so at accept time instead, on every path that
 * accepts a definition: create, replace, saved-tier edit, seed re-validation,
 * and the live-edit frontier (which re-validates the post-batch definition), so
 * no present or future edit operation can raise a cap past the backstop without
 * this refusal answering it.
 */
function validatePassBudget(
  projection: LoopBodyProjection,
): WorkflowGraphValidationError[] {
  const { group, index } = projection;
  if (group.maxPasses <= EXECUTION_TOTAL_PASS_BACKSTOP) return [];
  return [
    {
      code: "loop-max-passes-exceeds-backstop",
      message: `Loop group "${group.id}" declares maxPasses ${group.maxPasses}, above the per-execution total-pass backstop of ${EXECUTION_TOTAL_PASS_BACKSTOP}; the backstop bounds every loop group together and cannot be raised`,
      field: `loopGroups[${index}].maxPasses`,
    },
  ];
}

/**
 * The reserved namespace is closed to authoring on BOTH tiers: on the authored
 * tier nothing may inhabit it, and on the resolved tier only ids the engine
 * itself minted for a declared group may. That second half is what stops a live
 * edit or an expansion from smuggling a node into a running loop's id space.
 */
function validateReservedIds(
  definition: LoopValidatableDefinition,
  groups: readonly LoopGroupLike[],
): WorkflowGraphValidationError[] {
  const errors: WorkflowGraphValidationError[] = [];
  const namespaces = new Set(
    groups.filter(isResolvedGroup).map((group) => group.id),
  );

  const refuse = (
    id: string,
    field: string,
    subject: string,
  ): WorkflowGraphValidationError | null => {
    // The wiring-edge slot is reserved on its own: an authored edge carrying it
    // would mint to the same id as the prior-exit edge of its own pass.
    if (id === LOOP_PASS_ENTRY_EDGE_SUFFIX) {
      return {
        code: "reserved-loop-instance-id",
        message: `${subject} "${id}" uses the reserved loop pass-entry edge id`,
        field,
      };
    }
    if (!RESERVED_LOOP_INSTANCE_ID_PATTERN.test(id)) return null;
    if (isMintedInstanceId(id, namespaces)) return null;
    return {
      code: "reserved-loop-instance-id",
      message: `${subject} "${id}" uses the reserved loop pass-instance namespace "<loopGroupId>__p<pass>__…"`,
      field,
    };
  };

  definition.executionContexts.forEach((context, index) => {
    const error = refuse(
      context.id,
      `executionContexts[${index}].id`,
      "Execution context",
    );
    if (error) errors.push({ ...error, contextId: context.id });
  });
  definition.tasks.forEach((task, index) => {
    const own = refuse(task.id, `tasks[${index}].id`, "Task");
    if (own) errors.push({ ...own, taskId: task.id });
    const owner = refuse(
      task.contextId,
      `tasks[${index}].contextId`,
      "Task context",
    );
    if (owner) errors.push({ ...owner, taskId: task.id });
  });
  definition.edges.forEach((edge, index) => {
    const error = refuse(edge.id, `edges[${index}].id`, "Edge");
    if (error) errors.push({ ...error, edgeId: edge.id });
  });

  groups.forEach((group, index) => {
    if (!RESERVED_LOOP_INSTANCE_ID_PATTERN.test(group.id)) return;
    errors.push({
      code: "reserved-loop-group-id",
      message: `Loop group "${group.id}" uses the reserved loop pass-instance namespace "<loopGroupId>__p<pass>__…"`,
      field: `loopGroups[${index}].id`,
    });
  });

  return errors;
}

/**
 * V1 admits neither nesting nor overlap. Both present as a shared context; a
 * body wholly contained in another is reported as nesting, because that is the
 * mistake the author actually made.
 */
function validateBodyDisjointness(
  projections: readonly LoopBodyProjection[],
): WorkflowGraphValidationError[] {
  const errors: WorkflowGraphValidationError[] = [];

  for (let outer = 0; outer < projections.length; outer += 1) {
    for (let inner = outer + 1; inner < projections.length; inner += 1) {
      const a = projections[outer]!;
      const b = projections[inner]!;
      const aIds = new Set(a.bodyContextIds);
      const shared = b.bodyContextIds.filter((contextId) =>
        aIds.has(contextId),
      );
      if (shared.length === 0) continue;

      const nested =
        shared.length === b.bodyContextIds.length ||
        shared.length === a.bodyContextIds.length;
      errors.push({
        code: nested ? "nested-loop-body" : "overlapping-loop-bodies",
        message: nested
          ? `Loop groups "${a.group.id}" and "${b.group.id}" nest: one body is wholly contained in the other (${shared.join(", ")})`
          : `Loop groups "${a.group.id}" and "${b.group.id}" overlap on context(s) ${shared.join(", ")}`,
        field: `loopGroups[${b.index}].bodyContextIds`,
      });
    }
  }

  return errors;
}

function validateBodyMembership(
  projection: LoopBodyProjection,
): WorkflowGraphValidationError[] {
  const { group, index } = projection;
  const errors: WorkflowGraphValidationError[] = [];

  for (const contextId of projection.missingContextIds) {
    errors.push({
      code: "unknown-loop-body-context",
      message: `Loop group "${group.id}" names body context "${contextId}", which the definition does not declare`,
      contextId,
      field: `loopGroups[${index}].bodyContextIds`,
    });
  }

  const body = new Set(projection.bodyContextIds);
  if (!body.has(group.entryContextId)) {
    errors.push({
      code: "loop-entry-not-in-body",
      message: `Loop group "${group.id}" declares entry context "${group.entryContextId}", which is not part of its body`,
      contextId: group.entryContextId,
      field: `loopGroups[${index}].entryContextId`,
    });
  }
  if (!body.has(group.exitContextId)) {
    errors.push({
      code: "loop-exit-not-in-body",
      message: `Loop group "${group.id}" declares exit context "${group.exitContextId}", which is not part of its body`,
      contextId: group.exitContextId,
      field: `loopGroups[${index}].exitContextId`,
    });
  }

  return errors;
}

/**
 * Connectivity, single entry, single exit, and reconvergence — the four shape
 * rules that make a body safely unrollable.
 *
 * Reconvergence is stated as "the exit is MUST-RUN inside the body": the entry
 * always runs, and a body context runs unconditionally only when some
 * unconditional internal edge reaches it from a context that itself always
 * runs. If the exit falls outside that set, some assignment of guard verdicts
 * skips it — and a pass whose exit never produces a verdict cannot settle.
 * Deliberately the same inductive rule the route projection uses for criterion
 * protection, so "reconverges" and "must-run" cannot drift apart.
 */
function validateBodyShape(
  projection: LoopBodyProjection,
): WorkflowGraphValidationError[] {
  const { group, index } = projection;
  const body = new Set(projection.bodyContextIds);
  if (!body.has(group.entryContextId) || !body.has(group.exitContextId)) {
    // Membership is already refused; the shape walk would only add noise.
    return [];
  }

  const errors: WorkflowGraphValidationError[] = [];
  const outgoing = new Map<string, LoopEdgeLike[]>();
  const incoming = new Map<string, LoopEdgeLike[]>();
  for (const contextId of body) {
    outgoing.set(contextId, []);
    incoming.set(contextId, []);
  }
  for (const edge of projection.internalEdges) {
    outgoing.get(edge.sourceContextId)?.push(edge);
    incoming.get(edge.targetContextId)?.push(edge);
  }

  const reachable = new Set<string>([group.entryContextId]);
  const queue = [group.entryContextId];
  while (queue.length > 0) {
    const contextId = queue.shift()!;
    for (const edge of outgoing.get(contextId) ?? []) {
      if (reachable.has(edge.targetContextId)) continue;
      reachable.add(edge.targetContextId);
      queue.push(edge.targetContextId);
    }
  }

  for (const contextId of projection.bodyContextIds) {
    if (reachable.has(contextId)) continue;
    errors.push({
      code: "disconnected-loop-body",
      message: `Loop group "${group.id}" body context "${contextId}" is not reachable from entry context "${group.entryContextId}"`,
      contextId,
      field: `loopGroups[${index}].bodyContextIds`,
    });
  }

  for (const contextId of projection.bodyContextIds) {
    if (contextId === group.entryContextId) continue;
    if ((incoming.get(contextId) ?? []).length > 0) continue;
    errors.push({
      code: "multi-entry-loop-body",
      message: `Loop group "${group.id}" body context "${contextId}" has no incoming edge inside the body, making it a second entry alongside "${group.entryContextId}"`,
      contextId,
      field: `loopGroups[${index}].entryContextId`,
    });
  }

  for (const contextId of projection.bodyContextIds) {
    if (contextId === group.exitContextId) continue;
    if ((outgoing.get(contextId) ?? []).length > 0) continue;
    errors.push({
      code: "multi-exit-loop-body",
      message: `Loop group "${group.id}" body context "${contextId}" has no outgoing edge inside the body, making it a second exit alongside "${group.exitContextId}"`,
      contextId,
      field: `loopGroups[${index}].exitContextId`,
    });
  }

  const mustRun = new Set<string>([group.entryContextId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const edge of projection.internalEdges) {
      if (edge.when !== undefined) continue;
      if (!mustRun.has(edge.sourceContextId)) continue;
      if (mustRun.has(edge.targetContextId)) continue;
      mustRun.add(edge.targetContextId);
      grew = true;
    }
  }
  if (!mustRun.has(group.exitContextId)) {
    errors.push({
      code: "non-reconverging-loop-branch",
      message: `Loop group "${group.id}" exit context "${group.exitContextId}" is reachable only through conditional edges; every branch inside a loop body must reconverge at the exit so the exit runs on every pass`,
      contextId: group.exitContextId,
      field: `loopGroups[${index}].exitContextId`,
    });
  }

  return errors;
}

/**
 * External edges may touch a body only at its two boundaries: incoming at the
 * entry, outgoing from the exit. Anything else would let work start mid-body or
 * consume a mid-body result, neither of which survives unrolling into
 * per-pass instances.
 */
function validateBoundaryEdges(
  definition: LoopValidatableDefinition,
  projection: LoopBodyProjection,
): WorkflowGraphValidationError[] {
  const { group } = projection;
  const body = new Set(projection.bodyContextIds);
  const errors: WorkflowGraphValidationError[] = [];

  definition.edges.forEach((edge, edgeIndex) => {
    const sourceInBody = body.has(edge.sourceContextId);
    const targetInBody = body.has(edge.targetContextId);
    if (sourceInBody === targetInBody) return;

    if (targetInBody && edge.targetContextId !== group.entryContextId) {
      errors.push({
        code: "external-edge-bypasses-loop-entry",
        message: `Edge "${edge.id}" enters loop group "${group.id}" at "${edge.targetContextId}"; an external edge into a loop body must target its entry context "${group.entryContextId}"`,
        contextId: edge.targetContextId,
        edgeId: edge.id,
        field: `edges[${edgeIndex}].targetContextId`,
      });
    }
    if (sourceInBody && edge.sourceContextId !== group.exitContextId) {
      errors.push({
        code: "external-edge-bypasses-loop-exit",
        message: `Edge "${edge.id}" leaves loop group "${group.id}" from "${edge.sourceContextId}"; an external edge out of a loop body must originate at its exit context "${group.exitContextId}"`,
        contextId: edge.sourceContextId,
        edgeId: edge.id,
        field: `edges[${edgeIndex}].sourceContextId`,
      });
    }
  });

  return errors;
}

/**
 * The loop's terminal contract (R9.5). A loop concludes by matching the exit's
 * captured output against `until`, so an exit that declares no output shape has
 * nothing to be matched, and a predicate the exit's shape can never satisfy is
 * a loop that can only ever exhaust its budget.
 *
 * Both the subset check and the compatibility walk are the SAME ones edge
 * guards use — a loop predicate is a guard over the exit's output, and a second
 * evaluator would be a second set of rules.
 */
function validateTerminalContract(
  projection: LoopBodyProjection,
): WorkflowGraphValidationError[] {
  const { group, index } = projection;
  const errors: WorkflowGraphValidationError[] = [];
  const exit = projection.contextsById.get(group.exitContextId);
  if (exit === undefined) return errors;

  if (exit.outputSchema === undefined) {
    errors.push({
      code: "loop-exit-without-output-schema",
      message: `Loop group "${group.id}" exit context "${group.exitContextId}" declares no outputSchema; the until predicate is evaluated against the exit's captured output`,
      contextId: group.exitContextId,
      field: `loopGroups[${index}].exitContextId`,
    });
  }

  const base = `loopGroups[${index}].until.schema`;
  const locate = (path: string): string => `${base}${path.slice("$".length)}`;

  const declarationIssues = validateOutputSchemaDeclaration(group.until.schema);
  if (declarationIssues.length > 0) {
    for (const issue of declarationIssues) {
      errors.push({
        code: "unsupported-loop-predicate",
        message: `Loop group "${group.id}" until predicate: ${issue.message}`,
        field: locate(issue.path),
      });
    }
    // A document outside the subset cannot be meaningfully compared against the
    // exit's shape — the author repairs it first, then sees the verdict.
    return errors;
  }

  if (exit.outputSchema === undefined) return errors;

  for (const issue of checkGuardCompatibility(
    group.until.schema,
    exit.outputSchema,
  )) {
    errors.push({
      code: "incompatible-loop-predicate",
      message: `Loop group "${group.id}" until predicate is incompatible with the outputSchema of exit context "${group.exitContextId}": ${issue.message}`,
      contextId: group.exitContextId,
      field: locate(issue.path),
    });
  }

  return errors;
}

/**
 * Every context id a definition's loop groups declare but no longer carries in
 * `executionContexts` — the logical entry and exit, which external edges still
 * address after resolution (D1). The structural validator adds these to its
 * node set so a loop's outgoing edge is not read as dangling.
 */
export function collectLoopBoundaryContextIds(
  definition: LoopValidatableDefinition,
): Set<string> {
  const ids = new Set<string>();
  for (const group of definition.loopGroups ?? []) {
    if (!isResolvedGroup(group)) continue;
    ids.add(group.entryContextId);
    ids.add(group.exitContextId);
  }
  return ids;
}

// ============================================================
// Expansion refusals (R11.1)
// ============================================================

/**
 * Loop groups are seed-authored only: a running agent may append contexts,
 * tasks, and edges, but never a new control-flow shape. Read structurally so
 * the refusal does not wait on the expansion payload's own schema.
 */
export function validateExpansionPayloadLoopDeclarations(
  payload: unknown,
): WorkflowGraphValidationError[] {
  if (typeof payload !== "object" || payload === null) return [];
  if (!Object.prototype.hasOwnProperty.call(payload, "loopGroups")) return [];
  return [
    {
      code: "loop-declaration-in-expansion",
      message:
        "Expansion payloads may not declare loop groups; loops are seed-authored only",
      field: "loopGroups",
    },
  ];
}

/** How an expansion attempt learns whether a loop is currently running. */
export interface LoopActivationReader {
  isActive(loopGroupId: string): boolean;
}

export interface ExpansionInitiatorCheck {
  readonly initiatorContextId: string;
  readonly loopGroups: readonly ResolvedLoopGroupLike[];
  readonly activation: LoopActivationReader;
}

/**
 * Refuses expansion from inside an ACTIVE loop body. A body context is cloned
 * verbatim into every subsequent pass, so a node an agent appends from inside
 * one either vanishes at the next pass or silently multiplies — v1 admits
 * neither. Once the loop has concluded (or was never taken) its instances are
 * ordinary settled contexts and expansion is unremarkable.
 */
export function validateExpansionInitiator(
  check: ExpansionInitiatorCheck,
): WorkflowGraphValidationError[] {
  const membership = findLoopBodyMembership(
    check.initiatorContextId,
    check.loopGroups,
  );
  if (membership === null) return [];
  if (!check.activation.isActive(membership.loopGroupId)) return [];

  return [
    {
      code: "expansion-from-active-loop-body",
      message: `Context "${check.initiatorContextId}" is inside the active loop body of "${membership.loopGroupId}"; runtime expansion from inside a running loop is refused`,
      contextId: check.initiatorContextId,
    },
  ];
}

export interface LoopBodyMembership {
  readonly loopGroupId: string;
  /** The pass this instance belongs to; null for the logical (template) id. */
  readonly pass: number | null;
}

/**
 * Which loop body — if any — a context belongs to, by either its logical
 * template id or its minted pass-instance id.
 */
export function findLoopBodyMembership(
  contextId: string,
  loopGroups: readonly ResolvedLoopGroupLike[],
): LoopBodyMembership | null {
  for (const group of loopGroups) {
    if (group.template.contexts.some((context) => context.id === contextId)) {
      return { loopGroupId: group.id, pass: null };
    }
    const parsed = parseLoopInstanceId(contextId, [group.id]);
    if (!parsed) continue;
    if (
      !group.template.contexts.some(
        (context) => context.id === parsed.authoredId,
      )
    ) {
      continue;
    }
    return { loopGroupId: group.id, pass: parsed.pass };
  }
  return null;
}

// ============================================================
// Seed-time resolution
// ============================================================

interface LoopResolutionContext {
  readonly id: string;
}

export type GraphWorkflowResolvedLoopGroupFor<
  TContext extends LoopResolutionContext,
> = Omit<GraphWorkflowResolvedLoopGroup, "template"> & {
  readonly template: Omit<GraphWorkflowLoopBodyTemplate, "contexts"> & {
    readonly contexts: TContext[];
  };
};

export interface LoopResolutionInput<
  TContext extends LoopResolutionContext = GraphWorkflowResolvedContext,
> {
  readonly loopGroups: readonly GraphWorkflowLoopGroup[];
  /** Every context, body members included, AFTER the config cascade. */
  readonly executionContexts: readonly TContext[];
  readonly tasks: readonly GraphWorkflowTaskDefinition[];
  readonly edges: readonly GraphWorkflowContextEdge[];
  resolvePlanRepair(
    group: GraphWorkflowLoopGroup,
  ): GraphWorkflowPlanRepairPolicy;
}

export interface LoopResolution<
  TContext extends LoopResolutionContext = GraphWorkflowResolvedContext,
> {
  readonly executionContexts: TContext[];
  readonly tasks: GraphWorkflowTaskDefinition[];
  readonly edges: GraphWorkflowContextEdge[];
  readonly loopGroups: GraphWorkflowResolvedLoopGroupFor<TContext>[];
}

const FIRST_PASS = 1;

/**
 * The version every body template is snapshotted at. Seed resolution takes the
 * snapshot and clones pass 1 from it in one call, so pass 1 always ran THIS
 * version — which is what the ledger records for it even if a later quiescent
 * template edit bumps the group before the loop activates (R11.2).
 */
export const SEED_TEMPLATE_VERSION = 1;

/**
 * Turn authored loop declarations into the artifact the engine runs: each
 * body is lifted out of the scheduled graph into its group's versioned
 * template, and pass 1 is materialized in its place under the reserved id
 * namespace.
 *
 * The two boundaries are deliberately asymmetric. An INCOMING external edge is
 * retargeted onto the pass-1 entry instance and is never cloned again — it is
 * the loop's activation, consumed once (R9). An OUTGOING external edge keeps
 * the AUTHORED exit as its source: the logical exit stays immutable in the
 * topology while the route projection resolves which pass instance actually
 * satisfies the edge, so downstream work cannot become eligible until the loop
 * concludes (D1).
 */
export function resolveLoopGroups<TContext extends LoopResolutionContext>(
  input: LoopResolutionInput<TContext>,
): LoopResolution<TContext> {
  if (input.loopGroups.length === 0) {
    return {
      executionContexts: [...input.executionContexts],
      tasks: [...input.tasks],
      edges: [...input.edges],
      loopGroups: [],
    };
  }

  const bodyOwnerByContextId = new Map<string, GraphWorkflowLoopGroup>();
  for (const group of input.loopGroups) {
    for (const contextId of group.bodyContextIds) {
      bodyOwnerByContextId.set(contextId, group);
    }
  }

  const resolvedGroups: GraphWorkflowResolvedLoopGroupFor<TContext>[] = [];
  const passContextsByGroupId = new Map<string, TContext[]>();
  const passTasks: GraphWorkflowTaskDefinition[] = [];
  const passEdges: GraphWorkflowContextEdge[] = [];

  for (const group of input.loopGroups) {
    const body = new Set(group.bodyContextIds);
    const contexts = input.executionContexts.filter((context) =>
      body.has(context.id),
    );
    const tasks = input.tasks.filter((task) => body.has(task.contextId));
    const edges = input.edges.filter(
      (edge) =>
        body.has(edge.sourceContextId) && body.has(edge.targetContextId),
    );

    const mint = (authoredId: string): string =>
      loopInstanceId(group.id, FIRST_PASS, authoredId);

    passContextsByGroupId.set(
      group.id,
      contexts.map((context) => ({ ...context, id: mint(context.id) })),
    );
    passTasks.push(
      ...tasks.map((task) => ({
        ...task,
        id: mint(task.id),
        contextId: mint(task.contextId),
      })),
    );
    passEdges.push(
      ...edges.map((edge) => ({
        ...edge,
        id: mint(edge.id),
        sourceContextId: mint(edge.sourceContextId),
        targetContextId: mint(edge.targetContextId),
      })),
    );

    resolvedGroups.push({
      id: group.id,
      ...(group.title !== undefined ? { title: group.title } : {}),
      entryContextId: group.entryContextId,
      exitContextId: group.exitContextId,
      until: group.until,
      maxPasses: group.maxPasses,
      template: { contexts, tasks, edges },
      templateVersion: SEED_TEMPLATE_VERSION,
      planRepair: input.resolvePlanRepair(group),
    });
  }

  // Splice each group's pass-1 instances in where its body sat, so the scheduled
  // graph keeps reading top-to-bottom the way the author laid it out.
  const executionContexts: TContext[] = [];
  const splicedGroupIds = new Set<string>();
  for (const context of input.executionContexts) {
    const owner = bodyOwnerByContextId.get(context.id);
    if (owner === undefined) {
      executionContexts.push(context);
      continue;
    }
    if (splicedGroupIds.has(owner.id)) continue;
    splicedGroupIds.add(owner.id);
    executionContexts.push(...(passContextsByGroupId.get(owner.id) ?? []));
  }

  const tasks = [
    ...input.tasks.filter((task) => !bodyOwnerByContextId.has(task.contextId)),
    ...passTasks,
  ];

  const edges: GraphWorkflowContextEdge[] = [];
  for (const edge of input.edges) {
    const sourceOwner = bodyOwnerByContextId.get(edge.sourceContextId);
    const targetOwner = bodyOwnerByContextId.get(edge.targetContextId);
    if (sourceOwner !== undefined && targetOwner !== undefined) continue;
    if (targetOwner !== undefined) {
      edges.push({
        ...edge,
        targetContextId: loopInstanceId(
          targetOwner.id,
          FIRST_PASS,
          edge.targetContextId,
        ),
      });
      continue;
    }
    edges.push(edge);
  }
  edges.push(...passEdges);

  return { executionContexts, tasks, edges, loopGroups: resolvedGroups };
}
