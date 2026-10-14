import {
  jsonSchemaTypesOverlap,
  joinSchemaPath,
} from "@/lib/workflows/primitives/output-schema-subset";

/**
 * Whether a subset-valid guard document can ever match what its source is
 * declared to produce: a mistyped property name, a `const` outside the
 * source's `enum` or a type that cannot intersect is a branch that silently
 * never fires. Route guards and a loop's `until` predicate are both checked
 * with this one walk.
 */

/**
 * What the compatibility walk does with each keyword the shared subset
 * descriptor supports. Keeping this exhaustive — pinned by a test comparing it
 * against `OUTPUT_SCHEMA_SUPPORTED_KEYWORDS` — is what makes "derived from the
 * exported descriptor" true rather than aspirational: widening the subset fails
 * that test until the new keyword is given a role here.
 *
 *  - `type-intersection`  — guard and source types must share a member.
 *  - `value-narrowing`    — the guard's admissible values must be producible.
 *  - `branch-walk`        — alternatives, walked branch by branch.
 *  - `structural-recursion` — descends into a child node.
 *  - `payload-constraint` — constrains the captured VALUE, never statically in
 *    conflict with a source declaration, so the walk deliberately ignores it.
 */
export type GuardCompatibilityRole =
  | "type-intersection"
  | "value-narrowing"
  | "branch-walk"
  | "structural-recursion"
  | "declared-property"
  | "payload-constraint";

export const GUARD_COMPATIBILITY_KEYWORD_ROLES: Readonly<
  Record<string, GuardCompatibilityRole>
> = {
  type: "type-intersection",
  enum: "value-narrowing",
  const: "value-narrowing",
  oneOf: "branch-walk",
  properties: "structural-recursion",
  required: "declared-property",
  additionalProperties: "payload-constraint",
  items: "structural-recursion",
  minItems: "payload-constraint",
  maxItems: "payload-constraint",
  minLength: "payload-constraint",
  maxLength: "payload-constraint",
  pattern: "payload-constraint",
  minimum: "payload-constraint",
  maximum: "payload-constraint",
};

// ============================================================
// Compatibility walk
// ============================================================

export interface GuardCompatibilityIssue {
  path: string;
  message: string;
}

/**
 * Walk a subset-valid guard document against a subset-valid source output
 * schema, reporting every node at which the guard can never match what the
 * source is declared to produce. Pure; collects all issues in document order.
 *
 * Exported for the loop terminal contract (R9.5): a loop's `until` predicate is
 * a guard over its exit context's captured output, so it gets THIS walk rather
 * than a second set of compatibility rules.
 */
export function checkGuardCompatibility(
  guard: Record<string, unknown>,
  source: Record<string, unknown>,
): GuardCompatibilityIssue[] {
  const issues: GuardCompatibilityIssue[] = [];
  walkCompatibility(guard, source, "$", issues);
  return issues;
}

function walkCompatibility(
  guard: Record<string, unknown>,
  source: Record<string, unknown>,
  path: string,
  issues: GuardCompatibilityIssue[],
): void {
  // A guard `oneOf` states alternatives the payload may take: EVERY branch must
  // be satisfiable, or that branch is dead code.
  const guardBranches = guard.oneOf;
  if (Array.isArray(guardBranches)) {
    guardBranches.forEach((branch, index) => {
      if (!isRecord(branch)) return;
      walkCompatibility(branch, source, `${path}.oneOf[${index}]`, issues);
    });
    return;
  }

  // A source `oneOf` states alternatives the source may PRODUCE: the guard need
  // only be satisfiable against one of them.
  const sourceBranches = source.oneOf;
  if (Array.isArray(sourceBranches)) {
    const branches = sourceBranches.filter(isRecord);
    for (const branch of branches) {
      const local: GuardCompatibilityIssue[] = [];
      walkCompatibility(guard, branch, path, local);
      if (local.length === 0) return;
    }
    issues.push({
      path,
      message: `no branch of the source schema's ${branches.length}-way oneOf can satisfy this guard`,
    });
    return;
  }

  checkTypeIntersection(guard, source, path, issues);
  checkValueNarrowing(guard, source, path, issues);
  checkObjectProperties(guard, source, path, issues);
  checkArrayItems(guard, source, path, issues);
}

function checkTypeIntersection(
  guard: Record<string, unknown>,
  source: Record<string, unknown>,
  path: string,
  issues: GuardCompatibilityIssue[],
): void {
  const guardTypes = effectiveTypes(guard);
  const sourceTypes = effectiveTypes(source);
  if (guardTypes === null || sourceTypes === null) return;
  if (jsonSchemaTypesOverlap(guardTypes, sourceTypes)) return;
  issues.push({
    path: hasOwn(guard, "type") ? `${path}.type` : path,
    message: `the guard requires ${describeTypes(guardTypes)} but the source declares ${describeTypes(sourceTypes)}`,
  });
}

/**
 * The types a node constrains its value to. A node carrying object keywords but
 * no `type` still routes every value into object validation (see the subset
 * module's `hasObjectShape`), so it constrains the type just as firmly.
 */
function effectiveTypes(schema: Record<string, unknown>): string[] | null {
  if (hasOwn(schema, "type")) {
    const declared = schema.type;
    const names = Array.isArray(declared) ? declared : [declared];
    const strings = names.filter(
      (name): name is string => typeof name === "string",
    );
    return strings.length > 0 ? strings : null;
  }
  return hasObjectKeywords(schema) ? ["object"] : null;
}

function hasObjectKeywords(schema: Record<string, unknown>): boolean {
  return (
    hasOwn(schema, "properties") ||
    hasOwn(schema, "required") ||
    schema.additionalProperties === false
  );
}

function describeTypes(names: readonly string[]): string {
  return names.map((name) => JSON.stringify(name)).join(" or ");
}

/**
 * The values a node admits, or null when it admits any. `enum` and `const` are
 * the subset's only closed value sets; a guard naming a value outside them can
 * never match. Own-property: an inherited `enum` is not a declaration.
 */
function admissibleValues(schema: Record<string, unknown>): unknown[] | null {
  if (hasOwn(schema, "enum") && Array.isArray(schema.enum)) return schema.enum;
  if (hasOwn(schema, "const")) return [schema.const];
  return null;
}

function checkValueNarrowing(
  guard: Record<string, unknown>,
  source: Record<string, unknown>,
  path: string,
  issues: GuardCompatibilityIssue[],
): void {
  const allowed = admissibleValues(source);
  if (allowed === null) return;
  const rendered = allowed.map(String).join(", ");

  if (hasOwn(guard, "const") && !allowed.includes(guard.const)) {
    issues.push({
      path: `${path}.const`,
      message: `the guard requires ${JSON.stringify(guard.const)}, which the source never produces (allowed: ${rendered})`,
    });
  }

  if (Array.isArray(guard.enum)) {
    guard.enum.forEach((value, index) => {
      if (allowed.includes(value)) return;
      issues.push({
        path: `${path}.enum[${index}]`,
        message: `the source never produces ${JSON.stringify(value)} (allowed: ${rendered})`,
      });
    });
  }
}

function checkObjectProperties(
  guard: Record<string, unknown>,
  source: Record<string, unknown>,
  path: string,
  issues: GuardCompatibilityIssue[],
): void {
  const guardProperties = isRecord(guard.properties) ? guard.properties : null;
  const sourceProperties = isRecord(source.properties)
    ? source.properties
    : null;

  const constrained = new Set<string>();
  if (guardProperties) {
    for (const key of ownKeys(guardProperties)) {
      constrained.add(key);
      const childSource =
        sourceProperties && hasOwn(sourceProperties, key)
          ? sourceProperties[key]
          : undefined;
      const located = joinSchemaPath(`${path}.properties`, key);
      if (!isRecord(childSource)) {
        issues.push({
          path: located,
          message: `the source schema declares no property "${key}"`,
        });
        continue;
      }
      const childGuard = guardProperties[key];
      if (!isRecord(childGuard)) continue;
      walkCompatibility(childGuard, childSource, located, issues);
    }
  }

  if (!Array.isArray(guard.required)) return;
  guard.required.forEach((name, index) => {
    if (typeof name !== "string") return;
    // A required name the guard also constrains under `properties` is already
    // located at that node; reporting it twice sends the author to two places
    // for one typo.
    if (constrained.has(name)) return;
    if (sourceProperties && hasOwn(sourceProperties, name)) return;
    issues.push({
      path: `${path}.required[${index}]`,
      message: `the guard requires property "${name}", which the source schema never declares`,
    });
  });
}

function checkArrayItems(
  guard: Record<string, unknown>,
  source: Record<string, unknown>,
  path: string,
  issues: GuardCompatibilityIssue[],
): void {
  const guardItems = guard.items;
  if (!isRecord(guardItems)) return;
  const sourceItems = source.items;
  if (!isRecord(sourceItems)) {
    issues.push({
      path: `${path}.items`,
      message: "the source schema declares no items schema for this array",
    });
    return;
  }
  walkCompatibility(guardItems, sourceItems, `${path}.items`, issues);
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
