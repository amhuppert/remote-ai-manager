/**
 * The JSON Schema SUBSET this repo's structured-output machinery understands,
 * in one module: the value validator the gate runs (`validateJsonSchemaSubset`),
 * the descriptor naming exactly which keywords that validator enforces, and the
 * authoring-time walker (`validateOutputSchemaDeclaration`) that refuses any
 * declaration outside the subset.
 *
 * They live together because the descriptor's only value is being TRUE about
 * the validator beside it. `validateJsonSchemaSubset` silently ignores anything
 * it does not implement — an author who writes `format: "email"` gets a
 * constraint that never runs — so the walker exists to turn every such silent
 * no-op into a fail-closed refusal at definition-accept time.
 *
 * This module is deliberately dependency-free: no logger, no Node builtins, no
 * imports at all. `structured-output-gate.ts` (which logs, and therefore pulls
 * in the Node-backed logger) re-exports it for server callers, while the
 * client-side schema-editor lint imports it directly from a `"use client"`
 * component. That is the single-source guarantee behind D2/R1.3: the editor's
 * red errors and the server's refusals are literally the same function.
 *
 * Downstream consumers of the client half are named tasks, not this one:
 * `OutputSchemaField` + builder inspector (T8, lane `context-lane-ui-editing`)
 * and the ContextConfigTab live editor (T9, same lane). They must IMPORT these
 * exports — re-deriving a keyword list in the UI is the exact drift this module
 * exists to prevent, and `output-schema-subset.arch.test.ts` fails the build if
 * this module ever grows an import that would break browser use.
 */

// ============================================================
// Runtime value validation
// ============================================================

export function validateJsonSchemaSubset(
  schema: Record<string, unknown>,
  value: unknown,
): { valid: boolean; errors?: string[] } {
  const errors: string[] = [];
  validateAgainstSchema(schema, value, "$", errors);
  return errors.length > 0 ? { valid: false, errors } : { valid: true };
}

function validateAgainstSchema(
  schema: Record<string, unknown>,
  value: unknown,
  path: string,
  errors: string[],
): void {
  if (Array.isArray(schema["oneOf"])) {
    const branches = schema["oneOf"];
    const branchErrors: string[][] = [];
    let matches = 0;
    for (const branch of branches) {
      // A non-schema branch is skipped, not counted. Validating one produced no
      // errors and therefore counted as a MATCH, which let a single junk entry
      // make any value satisfy the whole `oneOf`. The authoring walker now
      // refuses such a branch outright; this keeps a schema stored before that
      // check from validating vacuously.
      if (!isRecord(branch)) continue;
      const local: string[] = [];
      validateAgainstSchema(branch, value, path, local);
      if (local.length === 0) matches += 1;
      branchErrors.push(local);
    }
    if (matches !== 1) {
      errors.push(
        `${path} must match exactly one schema in oneOf (matched ${matches})`,
      );
      // Surface the first branch's diagnostics so callers see actionable detail.
      const first = branchErrors[0];
      if (first) errors.push(...first);
    }
    return;
  }

  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    errors.push(`${path} must be one of ${schema.enum.map(String).join(", ")}`);
    return;
  }

  if (hasOwn(schema, "const")) {
    if (value !== schema.const) {
      errors.push(`${path} must equal ${String(schema.const)}`);
    }
    return;
  }

  const type = schema.type;
  if (type !== undefined && !matchesJsonSchemaType(value, type)) {
    errors.push(`${path} must be ${describeJsonSchemaType(type)}`);
    return;
  }

  if (type === "object" || hasObjectShape(schema)) {
    validateObjectSchema(schema, value, path, errors);
    return;
  }

  if (type === "array") {
    validateArraySchema(schema, value, path, errors);
    return;
  }

  if (type === "string") {
    validateStringSchema(schema, value, path, errors);
    return;
  }

  if (type === "number" || type === "integer") {
    validateNumberSchema(schema, value, path, errors);
  }
}

function hasObjectShape(schema: Record<string, unknown>): boolean {
  return (
    typeof schema.properties === "object" ||
    Array.isArray(schema.required) ||
    schema.additionalProperties === false
  );
}

function matchesJsonSchemaType(value: unknown, type: unknown): boolean {
  if (Array.isArray(type))
    return type.some((t) => matchesJsonSchemaType(value, t));
  switch (type) {
    case "object":
      return (
        typeof value === "object" && value !== null && !Array.isArray(value)
      );
    case "array":
      return Array.isArray(value);
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "null":
      return value === null;
    default:
      return true;
  }
}

function describeJsonSchemaType(type: unknown): string {
  return Array.isArray(type) ? type.map(String).join(" or ") : String(type);
}

function validateObjectSchema(
  schema: Record<string, unknown>,
  value: unknown,
  path: string,
  errors: string[],
): void {
  if (!isRecord(value)) {
    errors.push(`${path} must be object`);
    return;
  }

  const required = Array.isArray(schema.required) ? schema.required : [];
  for (const key of required) {
    // OWN property, not `in`: `"constructor" in {}` is true, so an inherited
    // name would silently satisfy `required` against a payload lacking it.
    if (typeof key === "string" && !hasOwn(value, key)) {
      errors.push(`${joinPath(path, key)} is required`);
    }
  }

  const properties = isRecord(schema.properties) ? schema.properties : {};

  if (schema.additionalProperties === false) {
    const allowed = new Set(Object.keys(properties));
    for (const key of Object.keys(value)) {
      if (!allowed.has(key)) {
        errors.push(`${joinPath(path, key)} is not allowed`);
      }
    }
  }

  for (const [key, childSchema] of Object.entries(properties)) {
    // Same reason: an absent optional property named `constructor` or `toString`
    // would otherwise be validated against the value on `Object.prototype`.
    if (!hasOwn(value, key)) continue;
    if (!isRecord(childSchema)) continue;
    validateAgainstSchema(childSchema, value[key], joinPath(path, key), errors);
  }
}

function validateArraySchema(
  schema: Record<string, unknown>,
  value: unknown,
  path: string,
  errors: string[],
): void {
  if (!Array.isArray(value)) {
    errors.push(`${path} must be array`);
    return;
  }

  if (typeof schema.minItems === "number" && value.length < schema.minItems) {
    errors.push(`${path} must contain at least ${schema.minItems} items`);
  }
  if (typeof schema.maxItems === "number" && value.length > schema.maxItems) {
    errors.push(`${path} must contain at most ${schema.maxItems} items`);
  }

  const items = schema.items;
  if (!isRecord(items)) return;
  for (let i = 0; i < value.length; i += 1) {
    validateAgainstSchema(items, value[i], `${path}[${i}]`, errors);
  }
}

function validateStringSchema(
  schema: Record<string, unknown>,
  value: unknown,
  path: string,
  errors: string[],
): void {
  if (typeof value !== "string") return;
  if (typeof schema.minLength === "number" && value.length < schema.minLength) {
    errors.push(`${path} must be at least ${schema.minLength} characters`);
  }
  if (typeof schema.maxLength === "number" && value.length > schema.maxLength) {
    errors.push(`${path} must be at most ${schema.maxLength} characters`);
  }
  if (typeof schema.pattern === "string") {
    const pattern = new RegExp(schema.pattern);
    if (!pattern.test(value)) {
      errors.push(`${path} must match pattern ${schema.pattern}`);
    }
  }
}

function validateNumberSchema(
  schema: Record<string, unknown>,
  value: unknown,
  path: string,
  errors: string[],
): void {
  if (typeof value !== "number") return;
  if (typeof schema.minimum === "number" && value < schema.minimum) {
    errors.push(`${path} must be >= ${schema.minimum}`);
  }
  if (typeof schema.maximum === "number" && value > schema.maximum) {
    errors.push(`${path} must be <= ${schema.maximum}`);
  }
}

// ============================================================
// Subset descriptor
// ============================================================

/**
 * The dispatch branches of `validateAgainstSchema`. `common` is the pre-dispatch
 * prefix (read at every node); the rest are the type-specific branches, which is
 * why `SchemaKind` is exactly this list minus `common`.
 */
const KEYWORD_GROUPS = [
  "common",
  "object",
  "array",
  "string",
  "number",
] as const;
type OutputSchemaKeywordGroup = (typeof KEYWORD_GROUPS)[number];
type SchemaKind = Exclude<OutputSchemaKeywordGroup, "common">;

/**
 * Keywords `validateAgainstSchema` actually enforces, grouped by the dispatch
 * branch that reads them. A keyword in a kind group only runs when the node's
 * declared `type` selects that exact branch — a `minLength` on an array node is
 * as silent a no-op as an unknown keyword, so the walker enforces that too.
 */
export const OUTPUT_SCHEMA_SUPPORTED_KEYWORDS: Readonly<
  Record<OutputSchemaKeywordGroup, readonly string[]>
> = {
  /** Read before the type dispatch, at any node. */
  common: ["type", "enum", "const", "oneOf"],
  object: ["properties", "required", "additionalProperties"],
  array: ["items", "minItems", "maxItems"],
  string: ["minLength", "maxLength", "pattern"],
  number: ["minimum", "maximum"],
};

/**
 * Keywords carried to the model as documentation but never validated. Allowed
 * because they make no enforcement claim the validator silently drops — unlike
 * `format`, which reads as a constraint and is therefore refused below.
 */
export const OUTPUT_SCHEMA_ANNOTATION_KEYWORDS = [
  "title",
  "description",
  "default",
  "examples",
  "$schema",
  "$id",
  "$comment",
] as const;

/** The `type` values `matchesJsonSchemaType` knows how to check. */
export const OUTPUT_SCHEMA_SUPPORTED_TYPES = [
  "object",
  "array",
  "string",
  "number",
  "integer",
  "boolean",
  "null",
] as const;

/**
 * Per-keyword guidance for the JSON Schema keywords an author is most likely to
 * reach for that this subset cannot enforce. Every message says what to write
 * instead, so a refusal is actionable rather than a dead end. Keywords absent
 * from this map are still refused, with the generic message the walker builds.
 */
export const UNSUPPORTED_OUTPUT_SCHEMA_KEYWORDS: ReadonlyMap<string, string> =
  new Map(
    Object.entries({
      $ref: "`$ref` is not supported — inline the referenced subschema at each use site.",
      $defs:
        "`$defs` is not supported — inline each definition at its use site.",
      definitions:
        "`definitions` is not supported — inline each definition at its use site.",
      anyOf:
        "`anyOf` is not supported — use `oneOf` when the branches are mutually exclusive, or widen the shape into a single schema.",
      allOf:
        "`allOf` is not supported — merge the subschemas into one schema by hand.",
      not: "`not` is not supported — express the constraint positively (`enum`, `pattern`, `const`).",
      format:
        "`format` is not enforced by this validator — express the constraint with `pattern`, or drop it rather than imply a check that never runs.",
      if: "`if`/`then`/`else` are not supported — use `oneOf` over fully-specified branches.",
      then: "`if`/`then`/`else` are not supported — use `oneOf` over fully-specified branches.",
      else: "`if`/`then`/`else` are not supported — use `oneOf` over fully-specified branches.",
      patternProperties:
        "`patternProperties` is not supported — declare each property explicitly under `properties`.",
      propertyNames:
        "`propertyNames` is not supported — declare each property explicitly under `properties`.",
      dependentRequired:
        "`dependentRequired` is not supported — model the alternatives as `oneOf` branches.",
      dependentSchemas:
        "`dependentSchemas` is not supported — model the alternatives as `oneOf` branches.",
      unevaluatedProperties:
        "`unevaluatedProperties` is not supported — use `additionalProperties: false`.",
      unevaluatedItems: "`unevaluatedItems` is not supported.",
      additionalItems:
        "`additionalItems` is not supported — this validator applies one `items` schema to every element.",
      prefixItems:
        "`prefixItems` (tuple typing) is not supported — `items` must be a single schema applied to every element.",
      contains:
        "`contains` is not supported — use `minItems` with an `items` schema.",
      minContains: "`minContains` is not supported — use `minItems`.",
      maxContains: "`maxContains` is not supported — use `maxItems`.",
      uniqueItems: "`uniqueItems` is not enforced by this validator.",
      multipleOf: "`multipleOf` is not enforced — use `minimum`/`maximum`.",
      exclusiveMinimum:
        "`exclusiveMinimum` is not enforced — use `minimum` with the adjusted bound.",
      exclusiveMaximum:
        "`exclusiveMaximum` is not enforced — use `maximum` with the adjusted bound.",
      minProperties:
        "`minProperties` is not enforced — list the mandatory keys in `required`.",
      maxProperties:
        "`maxProperties` is not enforced — use `additionalProperties: false`.",
      nullable:
        '`nullable` is not supported — use a `type` array such as ["string", "null"], and drop any type-specific constraint on that node (a union type reaches no type-specific check).',
      readOnly: "`readOnly` is not meaningful for a generated output payload.",
      writeOnly:
        "`writeOnly` is not meaningful for a generated output payload.",
      deprecated:
        "`deprecated` is not meaningful for a generated output payload.",
    }),
  );

/**
 * The refusal message for a keyword outside the subset — specific guidance when
 * this module has it, the generic list otherwise. THE single source both the
 * server refusal and the editor lint must call: a `Map` lookup rather than an
 * index, so an author writing `toString` as a keyword gets a sentence instead of
 * `Object.prototype.toString`.
 */
export function outputSchemaKeywordGuidance(keyword: string): string {
  return (
    UNSUPPORTED_OUTPUT_SCHEMA_KEYWORDS.get(keyword) ??
    `\`${keyword}\` is not a supported output-schema keyword; supported keywords are ${supportedKeywordList()}`
  );
}

// ============================================================
// Authoring-time declaration walking
// ============================================================

/** One authoring-time defect in a declared output schema. */
export interface OutputSchemaDeclarationIssue {
  /**
   * JSON path within the declared document, rooted at `$` and naming the exact
   * offending keyword (e.g. `$.properties.findings.items.format`).
   */
  path: string;
  message: string;
}

const KIND_BY_KEYWORD: ReadonlyMap<string, OutputSchemaKeywordGroup> = new Map(
  KEYWORD_GROUPS.flatMap((group) =>
    OUTPUT_SCHEMA_SUPPORTED_KEYWORDS[group].map(
      (keyword): [string, OutputSchemaKeywordGroup] => [keyword, group],
    ),
  ),
);

const ANNOTATION_KEYWORD_SET: ReadonlySet<string> = new Set(
  OUTPUT_SCHEMA_ANNOTATION_KEYWORDS,
);

const SUPPORTED_TYPE_SET: ReadonlySet<string> = new Set(
  OUTPUT_SCHEMA_SUPPORTED_TYPES,
);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Own-property test. Every key read out of an authored schema or a produced
 * payload goes through this rather than `in` or a bare index: JSON objects carry
 * `Object.prototype`, so `constructor`, `toString` and friends are legal
 * property names that `in` reports as present and indexing resolves to an
 * inherited function.
 */
function hasOwn(target: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(target, key);
}

const PLAIN_PROPERTY_KEY = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/**
 * Append a property or keyword name to a JSON path, bracket-quoting anything
 * that is not a plain identifier. Without this, `properties: { "a.b": … }` and
 * `properties: { a: { properties: { b: … } } }` produce the identical locator
 * `$.properties.a.b`, pointing the author at a node that may not exist.
 *
 * Exported as {@link joinSchemaPath} so every walker over one of these
 * documents — the declaration walk here, and the D4 edge-guard compatibility
 * walk — locates the same node with the same string.
 */
export function joinSchemaPath(path: string, key: string): string {
  return joinPath(path, key);
}

function joinPath(path: string, key: string): string {
  return PLAIN_PROPERTY_KEY.test(key)
    ? `${path}.${key}`
    : `${path}[${JSON.stringify(key)}]`;
}

/**
 * The type-specific branch `validateAgainstSchema` would reach for this node, or
 * null when it reaches none. A LITERAL mirror of that function's `if` ladder,
 * which is the only way the "this keyword is never read" refusals stay true.
 *
 * Two consequences of mirroring rather than reasoning about `type`:
 * `hasObjectShape` is tested FIRST and ignores `type` entirely, so object
 * keywords route an array-valued or even contradictory `type` into
 * `validateObjectSchema`; and a non-object `type` written as an ARRAY reaches no
 * branch at all, because the runtime compares `type === "string"` against the
 * array itself. A node the runtime hijacks into object validation despite a
 * non-object `type` is unsatisfiable, and `validateObjectShapeSatisfiability`
 * refuses it separately — the keyword-applicability messages here stay honest
 * about what is read, and that rule speaks to what can ever pass.
 */
function dispatchKind(schema: Record<string, unknown>): SchemaKind | null {
  const type = schema.type;
  if (type === "object" || hasObjectShape(schema)) return "object";
  if (type === "array") return "array";
  if (type === "string") return "string";
  if (type === "number" || type === "integer") return "number";
  return null;
}

/** Every `type` name a node declares, or null when it declares none. */
function declaredTypeNames(schema: Record<string, unknown>): unknown[] | null {
  if (!hasOwn(schema, "type")) return null;
  const type = schema.type;
  return Array.isArray(type) ? type : [type];
}

/**
 * Whether this node constrains the payload to be a JSON object — the root
 * requirement, and the requirement each `oneOf` branch of a root inherits.
 *
 * Distinct from `dispatchKind`: `{ type: ["object"] }` names exactly one type and
 * so is enforced as an object by `matchesJsonSchemaType`, even though it carries
 * no object keywords and therefore selects no object branch.
 */
function describesObjectPayload(schema: Record<string, unknown>): boolean {
  const names = declaredTypeNames(schema);
  if (names === null) return hasObjectShape(schema);
  return names.length > 0 && names.every((name) => name === "object");
}

/**
 * Object keywords make `validateAgainstSchema` route EVERY value into
 * `validateObjectSchema`, which rejects anything that is not an object. So a node
 * carrying them while declaring a type that admits a non-object can never accept
 * what it declares — unsatisfiable rather than merely unenforced, and refused for
 * the same fail-closed reason.
 */
function validateObjectShapeSatisfiability(
  schema: Record<string, unknown>,
  path: string,
  issues: OutputSchemaDeclarationIssue[],
): void {
  if (!hasObjectShape(schema)) return;
  const names = declaredTypeNames(schema);
  if (names === null) return;
  const nonObject = names.filter((name) => name !== "object");
  if (nonObject.length === 0) return;
  issues.push({
    path: `${path}.type`,
    message: `this node declares object keywords, which route every value into object validation, so a ${nonObject
      .map((name) => JSON.stringify(name))
      .join(
        "/",
      )} value can never satisfy it — drop the non-object \`type\` members, or model the alternatives as \`oneOf\` branches`,
  });
}

/**
 * The keyword that makes `validateAgainstSchema` return before reading the rest
 * of the node, or null. `oneOf` (when it is an array — a malformed one falls
 * through at runtime) returns immediately; `const` returns after `enum`, which
 * is why `enum` survives as a live sibling of `const` and nothing else does.
 */
function shortCircuitKeyword(
  schema: Record<string, unknown>,
): "oneOf" | "const" | null {
  if (Array.isArray(schema.oneOf)) return "oneOf";
  if (hasOwn(schema, "const")) return "const";
  return null;
}

/** Keywords still evaluated despite a short-circuit keyword being present. */
function keywordsStillReached(
  shortCircuit: "oneOf" | "const",
): ReadonlySet<string> {
  return shortCircuit === "const" ? new Set(["enum"]) : new Set<string>();
}

/**
 * Accept-time validation of an AUTHORED output-schema declaration (as opposed to
 * `validateJsonSchemaSubset`, which validates a produced VALUE against one).
 * Pure; collects every issue in document order rather than stopping at the first
 * so an author sees the whole repair list at once.
 *
 * A structured-output payload is always a JSON object, so the root must describe
 * one. Returns an empty array when the declaration is fully enforceable.
 */
export function validateOutputSchemaDeclaration(
  schema: unknown,
): OutputSchemaDeclarationIssue[] {
  const issues: OutputSchemaDeclarationIssue[] = [];
  walkDeclaration(schema, "$", issues, true);
  return issues;
}

function walkDeclaration(
  node: unknown,
  path: string,
  issues: OutputSchemaDeclarationIssue[],
  requireObjectPayload: boolean,
): void {
  if (!isRecord(node)) {
    issues.push({
      path,
      message:
        "must be a JSON Schema object (a plain object of schema keywords)",
    });
    return;
  }

  const schema = node;
  const shortCircuit = shortCircuitKeyword(schema);

  // A `oneOf` root delegates the object-payload requirement to each branch, so
  // `{ oneOf: [ {type: "object", …}, … ] }` — a legitimate discriminated
  // payload — is accepted and a bad branch is located at that branch.
  if (
    requireObjectPayload &&
    shortCircuit !== "oneOf" &&
    !describesObjectPayload(schema)
  ) {
    issues.push({
      path,
      message:
        'must describe an object — declare `type: "object"` (a structured-output payload is always a JSON object), or a `oneOf` over object branches; a `type` array must name no type other than "object"',
    });
    return;
  }

  validateNodeKeywords(schema, path, issues, shortCircuit);
  validateDeclaredType(schema, path, issues);
  validateObjectShapeSatisfiability(schema, path, issues);
  validateDeclaredEnum(schema, path, issues);
  validateDeclaredConst(schema, path, issues);
  validateDeclaredOneOf(schema, path, issues, requireObjectPayload);
  validateDeclaredObjectKeywords(schema, path, issues);
  validateDeclaredArrayKeywords(schema, path, issues);
  validateDeclaredBounds(schema, path, issues);
  validateDeclaredPattern(schema, path, issues);
}

/**
 * Classify every key on the node: annotation (ignored), unsupported (refused
 * with guidance), shadowed by a short-circuit keyword (refused — the validator
 * never reads it), or applicable to a dispatch branch this node does not select
 * (refused for the same reason).
 */
function validateNodeKeywords(
  schema: Record<string, unknown>,
  path: string,
  issues: OutputSchemaDeclarationIssue[],
  shortCircuit: "oneOf" | "const" | null,
): void {
  const kind = dispatchKind(schema);
  const stillReached =
    shortCircuit === null ? null : keywordsStillReached(shortCircuit);

  for (const key of Object.keys(schema)) {
    if (ANNOTATION_KEYWORD_SET.has(key)) continue;

    const keywordKind = KIND_BY_KEYWORD.get(key);
    if (keywordKind === undefined) {
      issues.push({
        path: joinPath(path, key),
        message: outputSchemaKeywordGuidance(key),
      });
      continue;
    }

    if (stillReached !== null && key !== shortCircuit) {
      if (stillReached.has(key)) continue;
      issues.push({
        path: joinPath(path, key),
        message: `\`${key}\` is ignored when \`${shortCircuit}\` is present — this validator stops at \`${shortCircuit}\` and never reads it`,
      });
      continue;
    }

    if (keywordKind !== "common" && keywordKind !== kind) {
      issues.push({
        path: joinPath(path, key),
        message: inapplicableKeywordMessage(key, keywordKind, schema),
      });
    }
  }
}

function inapplicableKeywordMessage(
  keyword: string,
  keywordKind: SchemaKind,
  schema: Record<string, unknown>,
): string {
  const required =
    keywordKind === "number"
      ? '`type: "number"` (or `"integer"`)'
      : `\`type: ${JSON.stringify(keywordKind)}\``;
  const declared = schema.type;
  if (typeof declared === "string") {
    return `\`${keyword}\` only applies to ${keywordKind} schemas, but this node declares \`type: ${JSON.stringify(declared)}\` — it would never be checked`;
  }
  if (Array.isArray(declared)) {
    return `\`${keyword}\` is not checked on a union \`type\` — this validator only runs type-specific checks for a single declared type; declare ${required} on its own node`;
  }
  return `\`${keyword}\` is only checked when the node declares ${required} — without it this validator never reads it`;
}

function supportedKeywordList(): string {
  return Object.values(OUTPUT_SCHEMA_SUPPORTED_KEYWORDS)
    .flat()
    .map((keyword) => `\`${keyword}\``)
    .join(", ");
}

function validateDeclaredType(
  schema: Record<string, unknown>,
  path: string,
  issues: OutputSchemaDeclarationIssue[],
): void {
  if (!hasOwn(schema, "type")) return;
  const type = schema.type;
  const names = Array.isArray(type) ? type : [type];
  if (names.length === 0) {
    issues.push({
      path: `${path}.type`,
      message: "`type` must name at least one JSON Schema type",
    });
    return;
  }
  for (const name of names) {
    if (typeof name !== "string" || !SUPPORTED_TYPE_SET.has(name)) {
      issues.push({
        path: `${path}.type`,
        message: `\`type\` must be one of ${[...SUPPORTED_TYPE_SET].join(", ")} (or an array of those), got ${JSON.stringify(name)}`,
      });
    }
  }
}

/**
 * `enum` membership is `Array.includes` and `const` equality is `!==` — both
 * reference comparisons for objects and arrays, which a freshly parsed payload
 * can never satisfy. Such a declaration is not merely unenforced: it is
 * unsatisfiable, so it is refused with the same fail-closed treatment.
 */
function isComparableByValue(value: unknown): boolean {
  return value === null || typeof value !== "object";
}

const REFERENCE_EQUALITY_GUIDANCE =
  "object and array values are compared by reference and can never match a parsed payload — describe the shape with a nested schema instead";

function validateDeclaredEnum(
  schema: Record<string, unknown>,
  path: string,
  issues: OutputSchemaDeclarationIssue[],
): void {
  if (!hasOwn(schema, "enum")) return;
  const values = schema.enum;
  if (!Array.isArray(values) || values.length === 0) {
    issues.push({
      path: `${path}.enum`,
      message: "`enum` must be a non-empty array of allowed values",
    });
    return;
  }
  values.forEach((value, index) => {
    if (!isComparableByValue(value)) {
      issues.push({
        path: `${path}.enum[${index}]`,
        message: `\`enum\` entries must be primitives — ${REFERENCE_EQUALITY_GUIDANCE}`,
      });
    }
  });
}

function validateDeclaredConst(
  schema: Record<string, unknown>,
  path: string,
  issues: OutputSchemaDeclarationIssue[],
): void {
  if (!hasOwn(schema, "const")) return;
  if (!isComparableByValue(schema.const)) {
    issues.push({
      path: `${path}.const`,
      message: `\`const\` must be a primitive — ${REFERENCE_EQUALITY_GUIDANCE}`,
    });
  }
}

function validateDeclaredOneOf(
  schema: Record<string, unknown>,
  path: string,
  issues: OutputSchemaDeclarationIssue[],
  requireObjectPayload: boolean,
): void {
  if (!hasOwn(schema, "oneOf")) return;
  const branches = schema.oneOf;
  if (!Array.isArray(branches) || branches.length === 0) {
    issues.push({
      path: `${path}.oneOf`,
      message: "`oneOf` must be a non-empty array of schemas",
    });
    return;
  }
  branches.forEach((branch, index) => {
    walkDeclaration(
      branch,
      `${path}.oneOf[${index}]`,
      issues,
      requireObjectPayload,
    );
  });
}

function validateDeclaredObjectKeywords(
  schema: Record<string, unknown>,
  path: string,
  issues: OutputSchemaDeclarationIssue[],
): void {
  if (hasOwn(schema, "properties")) {
    const properties = schema.properties;
    if (!isRecord(properties)) {
      issues.push({
        path: `${path}.properties`,
        message:
          "`properties` must be an object mapping property names to schemas",
      });
    } else {
      for (const [key, child] of Object.entries(properties)) {
        walkDeclaration(
          child,
          joinPath(`${path}.properties`, key),
          issues,
          false,
        );
      }
    }
  }

  if (hasOwn(schema, "required")) {
    const required = schema.required;
    if (!Array.isArray(required)) {
      issues.push({
        path: `${path}.required`,
        message: "`required` must be an array of property names",
      });
    } else {
      required.forEach((name, index) => {
        if (typeof name !== "string") {
          issues.push({
            path: `${path}.required[${index}]`,
            message:
              "`required` entries must be property-name strings; a non-string entry is silently skipped",
          });
        }
      });
    }
  }

  if (hasOwn(schema, "additionalProperties")) {
    if (typeof schema.additionalProperties !== "boolean") {
      issues.push({
        path: `${path}.additionalProperties`,
        message:
          "`additionalProperties` must be a boolean; only `false` is enforced, and a schema value is ignored",
      });
    }
  }
}

function validateDeclaredArrayKeywords(
  schema: Record<string, unknown>,
  path: string,
  issues: OutputSchemaDeclarationIssue[],
): void {
  if (!hasOwn(schema, "items")) return;
  const items = schema.items;
  if (!isRecord(items)) {
    issues.push({
      path: `${path}.items`,
      message:
        "`items` must be a single schema object applied to every element (tuple form is not supported)",
    });
    return;
  }
  walkDeclaration(items, `${path}.items`, issues, false);
}

const INTEGER_BOUND_KEYWORDS = [
  "minItems",
  "maxItems",
  "minLength",
  "maxLength",
] as const;

const NUMERIC_BOUND_KEYWORDS = ["minimum", "maximum"] as const;

function validateDeclaredBounds(
  schema: Record<string, unknown>,
  path: string,
  issues: OutputSchemaDeclarationIssue[],
): void {
  for (const keyword of INTEGER_BOUND_KEYWORDS) {
    if (!hasOwn(schema, keyword)) continue;
    const value = schema[keyword];
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
      issues.push({
        path: `${path}.${keyword}`,
        message: `\`${keyword}\` must be a non-negative integer; a non-number is silently ignored`,
      });
    }
  }
  for (const keyword of NUMERIC_BOUND_KEYWORDS) {
    if (!hasOwn(schema, keyword)) continue;
    const value = schema[keyword];
    if (typeof value !== "number" || !Number.isFinite(value)) {
      issues.push({
        path: `${path}.${keyword}`,
        message: `\`${keyword}\` must be a finite number; a non-number is silently ignored`,
      });
    }
  }
}

function validateDeclaredPattern(
  schema: Record<string, unknown>,
  path: string,
  issues: OutputSchemaDeclarationIssue[],
): void {
  if (!hasOwn(schema, "pattern")) return;
  const pattern = schema.pattern;
  if (typeof pattern !== "string") {
    issues.push({
      path: `${path}.pattern`,
      message: "`pattern` must be a regular-expression string",
    });
    return;
  }
  try {
    new RegExp(pattern);
  } catch {
    // The runtime validator compiles this same pattern per value; an invalid
    // one would throw mid-gate instead of failing the author at accept time.
    issues.push({
      path: `${path}.pattern`,
      message: `\`pattern\` is not a valid regular expression: ${pattern}`,
    });
  }
}
