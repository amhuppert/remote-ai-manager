import type { WorkflowGraphValidationError } from "@/lib/workflow-graph/definition-schemas";
// The dependency-free subset module, NOT the gate that re-exports it — same
// reason as `output-schema-validation.ts`: this file is reached from
// `validation.ts`, which a `"use client"` builder component imports.
import {
  joinSchemaPath,
  validateOutputSchemaDeclaration,
} from "@/lib/workflows/primitives/output-schema-subset";
import type { EdgeGuardDeclaration } from "@/lib/runs/route-projection";
import { checkGuardCompatibility } from "@/lib/runs/guard-compatibility";

/**
 * Accept-time validation of edge activation guards (D4 R1).
 *
 * An edge may carry `when` — either a JSON-Schema-subset document its source
 * context's captured output must match, or the `else` marker. Three refusals
 * live here, and every definition-accept path reaches all three through the one
 * call in `validateWorkflowDefinition`:
 *
 *  1. a guard-bearing edge whose source declares no `outputSchema` (there is
 *     nothing for the guard to be evaluated against — including for an `else`
 *     edge, which is only meaningful among conditional siblings that need one);
 *  2. a guard document outside the supported schema subset, which
 *     {@link validateOutputSchemaDeclaration} refuses with the same messages the
 *     output-schema editor shows;
 *  3. a second `else` edge on one source, which would make the fallback branch
 *     ambiguous.
 *
 * Plus the compatibility walk: a subset-valid guard can still be unsatisfiable
 * against the source's declared output shape (a mistyped property name, a
 * `const` outside the source's `enum`, a type that cannot intersect). Those are
 * refused too, because the alternative is a branch that silently never fires.
 *
 * Every error names the edge (`edgeId`) and a definition-relative JSON path
 * (`field`) reaching the exact offending node.
 */

/**
 * Read structurally, like {@link validateOutputSchemaDeclaration}'s callers: the
 * authored edge and the resolved edge are the same shape, so one walk serves
 * both tiers.
 */
export interface GuardBearingEdge {
  readonly id: string;
  readonly sourceContextId: string;
  readonly targetContextId: string;
  readonly when?: EdgeGuardDeclaration | undefined;
}

export interface GuardSourceContext {
  readonly id: string;
  readonly outputSchema?: Record<string, unknown> | undefined;
}

export function validateEdgeGuards(
  contexts: readonly GuardSourceContext[],
  edges: readonly GuardBearingEdge[],
): WorkflowGraphValidationError[] {
  const errors: WorkflowGraphValidationError[] = [];
  const sourceById = new Map(contexts.map((context) => [context.id, context]));
  const elseEdgeBySource = new Map<string, string>();

  edges.forEach((edge, index) => {
    const guard = edge.when;
    if (guard === undefined) return;

    // An edge whose source does not exist is already refused by the structural
    // validator with a locator of its own; re-reporting it as a guard problem
    // would send the author to the wrong field.
    const source = sourceById.get(edge.sourceContextId);
    if (source === undefined) return;

    const base = `edges[${index}].when`;
    const locate = (
      code: string,
      message: string,
      field: string,
    ): WorkflowGraphValidationError => ({
      code,
      message,
      contextId: edge.sourceContextId,
      edgeId: edge.id,
      field,
    });

    if (source.outputSchema === undefined) {
      errors.push(
        locate(
          "guard-source-without-output-schema",
          `Edge "${edge.id}" carries an activation guard but its source context "${edge.sourceContextId}" declares no outputSchema; a guard is evaluated against the source's captured output`,
          base,
        ),
      );
    }

    if (isElseGuard(guard)) {
      const existing = elseEdgeBySource.get(edge.sourceContextId);
      if (existing !== undefined) {
        errors.push(
          locate(
            "duplicate-else-edge",
            `Edge "${edge.id}" is a second else edge on source context "${edge.sourceContextId}" (the first is "${existing}"); at most one else edge is admitted per source context`,
            `${base}.else`,
          ),
        );
      } else {
        elseEdgeBySource.set(edge.sourceContextId, edge.id);
      }
      return;
    }

    const document = guard.schema;
    const declarationIssues = validateOutputSchemaDeclaration(document);
    if (declarationIssues.length > 0) {
      for (const issue of declarationIssues) {
        errors.push(
          locate(
            "unsupported-guard-schema",
            `Edge "${edge.id}" guard: ${issue.message}`,
            guardField(base, issue.path),
          ),
        );
      }
      // A document outside the subset cannot be meaningfully compared against
      // the source shape — the author repairs it first, then sees the
      // compatibility verdict.
      return;
    }

    if (source.outputSchema === undefined) return;

    for (const issue of checkGuardCompatibility(
      document,
      source.outputSchema,
    )) {
      errors.push(
        locate(
          "incompatible-guard-schema",
          `Edge "${edge.id}" guard is incompatible with the outputSchema of source context "${edge.sourceContextId}": ${issue.message}`,
          guardField(base, issue.path),
        ),
      );
    }
  });

  return errors;
}

/** Swap the subset walker's `$` root for the definition-relative guard locator. */
function guardField(base: string, path: string): string {
  return `${base}.schema${path.slice("$".length)}`;
}

// ============================================================
// Enum-coverage lint (R3.2)
// ============================================================

/**
 * The one authoring WARNING in the guard vocabulary: a source whose branches all
 * test the same closed-enum field, leaving some of that field's values with no
 * branch and no `else` edge — at runtime the source completes and nothing
 * downstream of it runs.
 *
 * The analysis is deliberately limited to the simple case (R3.2): every
 * conditional guard from the source must constrain exactly ONE top-level field,
 * all of them the same field, with `const`/`enum` only. A guard reaching into a
 * nested object, constraining a second field, constraining the rest of the
 * payload (`additionalProperties`), or testing a non-enum form makes the covered
 * value set unknowable without a real solver, and a warning derived from a
 * partial reading would be worse than none — so those sources are simply not
 * analysed.
 *
 * Every read here is an OWN-property read, guard document and source schema
 * alike. A JSON document may carry `properties`, `enum` or `const` as ordinary
 * data, and `Object.prototype` carries members of its own; treating an inherited
 * member as authored content would let the lint report values the author never
 * declared, which for a soundness-sensitive module is the same class of defect
 * as evaluating a guard against a payload no context produced.
 *
 * A warning, not an error: leaving values unrouted is legal (R3's branches are
 * independent by default), and the author who means it is served by
 * `routing.cardinality`, which turns under-selection into a runtime halt.
 */
export function lintGuardEnumCoverage(
  contexts: readonly GuardSourceContext[],
  edges: readonly GuardBearingEdge[],
): WorkflowGraphValidationError[] {
  const warnings: WorkflowGraphValidationError[] = [];
  const outgoingBySource = new Map<string, GuardBearingEdge[]>();
  for (const edge of edges) {
    const bucket = outgoingBySource.get(edge.sourceContextId);
    if (bucket) bucket.push(edge);
    else outgoingBySource.set(edge.sourceContextId, [edge]);
  }

  contexts.forEach((context, index) => {
    const outgoing = outgoingBySource.get(context.id) ?? [];
    // An else edge routes every value no sibling claimed, so nothing is left
    // uncovered by construction.
    if (
      outgoing.some((edge) => edge.when !== undefined && isElseGuard(edge.when))
    ) {
      return;
    }

    const probes: SingleFieldProbe[] = [];
    for (const edge of outgoing) {
      const guard = edge.when;
      if (guard === undefined || isElseGuard(guard)) continue;
      // A `when` wrapper that owns neither marker is not a guard document this
      // lint can read; bail on the whole source rather than analyse a partial
      // branch set.
      if (!hasOwn(guard, "schema") || !isRecord(guard.schema)) return;
      const probe = probeSingleEnumField(guard.schema);
      if (probe === null) return;
      probes.push(probe);
    }
    const [first, ...siblings] = probes;
    if (first === undefined) return;
    const field = first.field;
    if (siblings.some((probe) => probe.field !== field)) return;

    const declared = ownChildSchema(context.outputSchema, field);
    if (declared === null) return;
    const allowed = admissibleValues(declared);
    if (allowed === null) return;

    const covered = new Set(
      probes.flatMap((probe) => probe.values.map(valueKey)),
    );
    const uncovered = allowed.filter((value) => !covered.has(valueKey(value)));
    if (uncovered.length === 0) return;

    const keyword = hasOwn(declared, "enum") ? "enum" : "const";
    warnings.push({
      code: "uncovered-guard-enum-values",
      message: `Source context "${context.id}" branches on "${field}" but no outgoing edge covers ${uncovered
        .map((value) => JSON.stringify(value))
        .join(", ")}; add a branch for those values or an else edge`,
      contextId: context.id,
      field: `${joinSchemaPath(
        `executionContexts[${index}].outputSchema.properties`,
        field,
      )}.${keyword}`,
    });
  });

  return warnings;
}

interface SingleFieldProbe {
  field: string;
  values: unknown[];
}

/**
 * The ONLY top-level keywords a single-field guard may carry.
 * `additionalProperties` is deliberately absent: forbidding (or shaping) the
 * fields the guard does not name is a constraint on every other top-level field,
 * which puts the guard outside the single-field case whatever its `properties`
 * say.
 */
const SINGLE_FIELD_GUARD_KEYWORDS = new Set(["type", "properties", "required"]);

/** Child keywords a bare closed-value test may carry. */
const CLOSED_VALUE_KEYWORDS = new Set(["type", "const", "enum"]);

/**
 * The single top-level field a guard tests by closed value, or null when the
 * guard is outside the analysed simple case. Own-property throughout: a keyword
 * the document does not itself declare is not part of the guard.
 */
function probeSingleEnumField(
  schema: Record<string, unknown>,
): SingleFieldProbe | null {
  if (ownKeys(schema).some((key) => !SINGLE_FIELD_GUARD_KEYWORDS.has(key))) {
    return null;
  }
  if (hasOwn(schema, "type") && schema.type !== "object") return null;
  if (!hasOwn(schema, "properties")) return null;
  const properties = schema.properties;
  if (!isRecord(properties)) return null;
  const [field, ...extraFields] = ownKeys(properties);
  if (field === undefined || extraFields.length > 0) return null;

  if (hasOwn(schema, "required")) {
    const required = schema.required;
    if (!Array.isArray(required)) return null;
    if (required.some((name) => name !== field)) return null;
  }

  // `field` came from the document's own keys, so this read cannot reach the
  // prototype.
  const child = properties[field];
  if (!isRecord(child)) return null;
  if (ownKeys(child).some((key) => !CLOSED_VALUE_KEYWORDS.has(key)))
    return null;
  const values = admissibleValues(child);
  return values === null ? null : { field, values };
}

/** A schema node's own child schema for `field`, or null when it declares none. */
function ownChildSchema(
  schema: Record<string, unknown> | undefined,
  field: string,
): Record<string, unknown> | null {
  if (schema === undefined) return null;
  if (!hasOwn(schema, "properties")) return null;
  const properties = schema.properties;
  if (!isRecord(properties) || !hasOwn(properties, field)) return null;
  const child = properties[field];
  return isRecord(child) ? child : null;
}

/** Enum members are JSON scalars, so their encoding is their identity. */
function valueKey(value: unknown): string {
  return JSON.stringify(value) ?? "undefined";
}

function isElseGuard(
  guard: EdgeGuardDeclaration,
): guard is { readonly else: true } {
  return !hasOwn(guard, "schema") && hasOwn(guard, "else");
}

/**
 * The values a node admits, or null when it admits any. `enum` and `const` are
 * the subset's only closed value sets; a guard naming a value outside them can
 * never match. Own-property: an inherited `enum` is not a declaration. The
 * coverage lint's copy of the compatibility walk's helper (`runs/`).
 */
function admissibleValues(schema: Record<string, unknown>): unknown[] | null {
  if (hasOwn(schema, "enum") && Array.isArray(schema.enum)) return schema.enum;
  if (hasOwn(schema, "const")) return [schema.const];
  return null;
}

// ============================================================
// Own-property primitives
// ============================================================

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Own-property test, for the same reason the subset module uses one: a JSON
 * document may legitimately carry `constructor` or `toString` as a property
 * name, and `in`/bare indexing would resolve those on `Object.prototype` —
 * reading a source schema as declaring a property it never declares.
 */
function hasOwn(target: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(target, key);
}

function ownKeys(target: Record<string, unknown>): string[] {
  return Object.keys(target);
}
