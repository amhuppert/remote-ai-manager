import { expect } from "vitest";
import { z } from "zod";

/**
 * Test-only schema-driven round-trip durability harness.
 *
 * Drives a persist -> expected -> reload -> compare cycle parameterized by a
 * Zod schema, a maximal-fixture builder, persist/reload closures, and a field
 * policy map. It is the structural backstop for the serialization-boundary bug
 * class (a domain field silently dropped on write or reset to its default on
 * read).
 *
 * MUST NOT be imported by production code; it lives under `src/lib/shared/testing/`.
 */

export type FieldPath = string;

export type FieldPolicy = "not-persisted" | "derived-on-write";

export interface RoundTripSpec<TSchema extends z.ZodObject<z.ZodRawShape>> {
  readonly label: string;
  readonly schema: TSchema;
  buildMaximalFixture(): z.infer<TSchema>;
  persist(
    fixture: z.infer<TSchema>,
  ): Promise<z.infer<TSchema>> | z.infer<TSchema>;
  reload(
    expected: z.infer<TSchema>,
  ): Promise<z.infer<TSchema> | null> | (z.infer<TSchema> | null);
  readonly fieldPolicies?: Readonly<Partial<Record<FieldPath, FieldPolicy>>>;
}

type FieldPolicyMap = Readonly<Partial<Record<FieldPath, FieldPolicy>>>;

type AnyZodType = z.ZodType;

/** A leaf has no further introspectable structure the harness can descend. */
interface LeafNode {
  readonly kind: "leaf";
}

/** An object node maps its keys to unwrapped child schemas. */
interface ObjectNode {
  readonly kind: "object";
  readonly shape: Record<string, AnyZodType>;
}

/** An array node carries its element schema. */
interface ArrayNode {
  readonly kind: "array";
  readonly element: AnyZodType;
}

/** A record node carries its value schema. */
interface RecordNode {
  readonly kind: "record";
  readonly value: AnyZodType;
}

type SchemaNode = LeafNode | ObjectNode | ArrayNode | RecordNode;

/**
 * Result of unwrapping the optional/nullable/default wrappers off a schema:
 * the inner introspectable node plus, if a `ZodDefault` was present, the
 * resolved default value used to detect "left at default" fixtures.
 */
interface Unwrapped {
  readonly node: SchemaNode;
  readonly hasDefault: boolean;
  readonly defaultValue: unknown;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Zod v4 types `.def.innerType`/`.def.element`/`.def.valueType` as the internal
 * `$ZodType` base rather than the public `ZodType`. At runtime every node is a
 * genuine `ZodType` instance, so narrow via `instanceof` (a verified runtime
 * check) instead of casting.
 */
function asZodType(node: unknown): AnyZodType {
  if (node instanceof z.ZodType) return node;
  throw new Error("expected a Zod schema node during introspection");
}

/**
 * Unwrap `ZodDefault`, `ZodOptional`, and `ZodNullable` wrappers and classify
 * the inner schema into a traversable node. The first `ZodDefault` encountered
 * supplies the default value (already resolved to a value in Zod v4, not a
 * thunk).
 */
function unwrap(schema: AnyZodType): Unwrapped {
  let current = schema;
  let hasDefault = false;
  let defaultValue: unknown;

  while (true) {
    if (current instanceof z.ZodDefault) {
      if (!hasDefault) {
        hasDefault = true;
        defaultValue = current.def.defaultValue;
      }
      current = asZodType(current.def.innerType);
      continue;
    }
    if (current instanceof z.ZodOptional) {
      current = asZodType(current.def.innerType);
      continue;
    }
    if (current instanceof z.ZodNullable) {
      current = asZodType(current.def.innerType);
      continue;
    }
    break;
  }

  return { node: classify(current), hasDefault, defaultValue };
}

function classify(schema: AnyZodType): SchemaNode {
  if (schema instanceof z.ZodObject) {
    return { kind: "object", shape: schema.shape };
  }
  if (schema instanceof z.ZodArray) {
    return { kind: "array", element: asZodType(schema.element) };
  }
  if (schema instanceof z.ZodRecord) {
    return { kind: "record", value: asZodType(schema.def.valueType) };
  }
  return { kind: "leaf" };
}

/** Does this schema, once unwrapped, expose introspectable object fields? */
function hasIntrospectableFields(schema: AnyZodType): boolean {
  const { node } = unwrap(schema);
  if (node.kind === "object") return Object.keys(node.shape).length > 0;
  if (node.kind === "array") return hasIntrospectableFields(node.element);
  if (node.kind === "record") return hasIntrospectableFields(node.value);
  return false;
}

function appendKey(path: FieldPath, key: string): FieldPath {
  return path === "" ? key : `${path}.${key}`;
}

function appendIndex(path: FieldPath, index: number): FieldPath {
  return `${path}[${index}]`;
}

class DurabilityError extends Error {
  constructor(label: string, path: FieldPath, detail: string) {
    super(`[${label}] ${path}: ${detail}`);
    this.name = "DurabilityError";
  }
}

/**
 * Look up a policy for `path`, treating any path at or below a declared parent
 * policy as covered so a subtree can be excluded by declaring its root.
 */
function policyFor(
  policies: FieldPolicyMap,
  path: FieldPath,
): FieldPolicy | undefined {
  const direct = policies[path];
  if (direct) return direct;
  for (const [declared, policy] of Object.entries(policies)) {
    if (
      path === declared ||
      path.startsWith(`${declared}.`) ||
      path.startsWith(`${declared}[`)
    ) {
      return policy;
    }
  }
  return undefined;
}

interface GuardContext {
  readonly label: string;
  readonly policies: FieldPolicyMap;
  /**
   * When true, `derived-on-write` paths are validated for presence/non-default
   * (used against the expected value returned by persist). When false, they are
   * skipped (the input fixture may legitimately differ from the derived value).
   */
  readonly enforceDerived: boolean;
}

/**
 * Recursively verify that `value` populates every introspectable persisted key
 * path of `schema` with a present, non-default value. Throws naming the first
 * offending key path.
 */
function assertComplete(
  ctx: GuardContext,
  schema: AnyZodType,
  value: unknown,
  path: FieldPath,
): void {
  const policy = path === "" ? undefined : policyFor(ctx.policies, path);
  if (policy === "not-persisted") return;
  if (policy === "derived-on-write" && !ctx.enforceDerived) return;

  const { node, hasDefault, defaultValue } = unwrap(schema);

  if (value === undefined || value === null) {
    throw new DurabilityError(
      ctx.label,
      path,
      "missing from fixture (undefined/null) but is a persisted key path",
    );
  }

  if (hasDefault && deepEqual(value, defaultValue)) {
    throw new DurabilityError(
      ctx.label,
      path,
      `left at schema default ${JSON.stringify(defaultValue)}; populate a non-default value`,
    );
  }

  if (node.kind === "leaf") return;

  if (node.kind === "object") {
    for (const [key, childSchema] of Object.entries(node.shape)) {
      const childPath = appendKey(path, key);
      const childValue = isPlainRecord(value) ? value[key] : undefined;
      assertComplete(ctx, childSchema, childValue, childPath);
    }
    return;
  }

  if (node.kind === "array") {
    if (!Array.isArray(value)) {
      throw new DurabilityError(ctx.label, path, "expected an array fixture");
    }
    if (!hasIntrospectableFields(node.element)) return;
    if (value.length === 0) {
      throw new DurabilityError(
        ctx.label,
        path,
        "persisted array is empty; provide at least one representative element so nested fields are checked",
      );
    }
    assertComplete(ctx, node.element, value[0], appendIndex(path, 0));
    return;
  }

  // record
  if (!isPlainRecord(value)) {
    throw new DurabilityError(ctx.label, path, "expected a record fixture");
  }
  if (!hasIntrospectableFields(node.value)) return;
  const entries = Object.entries(value);
  if (entries.length === 0) {
    throw new DurabilityError(
      ctx.label,
      path,
      "persisted record is empty; provide at least one representative entry so nested fields are checked",
    );
  }
  const firstEntry = entries[0];
  if (firstEntry === undefined) return;
  const [firstKey, firstValue] = firstEntry;
  assertComplete(ctx, node.value, firstValue, appendKey(path, firstKey));
}

interface CompareContext {
  readonly label: string;
  readonly policies: FieldPolicyMap;
}

/**
 * Recursively compare `reloaded` against `expected` for every introspectable
 * key path of `schema`, excluding `not-persisted` paths. Throws naming the
 * first key path whose reloaded value diverges from expected.
 */
function assertReloadMatches(
  ctx: CompareContext,
  schema: AnyZodType,
  expected: unknown,
  reloaded: unknown,
  path: FieldPath,
): void {
  if (path !== "" && policyFor(ctx.policies, path) === "not-persisted") return;

  const { node } = unwrap(schema);

  if (node.kind === "object") {
    for (const key of Object.keys(node.shape)) {
      const childSchema = node.shape[key];
      if (childSchema === undefined) continue;
      const childPath = appendKey(path, key);
      const expectedChild = isPlainRecord(expected) ? expected[key] : undefined;
      const reloadedChild = isPlainRecord(reloaded) ? reloaded[key] : undefined;
      assertReloadMatches(
        ctx,
        childSchema,
        expectedChild,
        reloadedChild,
        childPath,
      );
    }
    return;
  }

  // Leaves, arrays, records, and opaque payloads are compared as whole values
  // via deep equality so drops or mutations anywhere inside are caught and the
  // containing key path is named.
  if (!deepEqual(expected, reloaded)) {
    expect(
      reloaded,
      `[${ctx.label}] ${path === "" ? "<root>" : path}: reloaded value does not deep-equal the expected persisted value (field dropped or mutated at the serialization boundary)`,
    ).toEqual(expected);
  }
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return a === b;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    return a.every((item, index) => deepEqual(item, b[index]));
  }
  if (typeof a === "object" && typeof b === "object") {
    const aKeys = Object.keys(a as Record<string, unknown>);
    const bKeys = Object.keys(b as Record<string, unknown>);
    if (aKeys.length !== bKeys.length) return false;
    return aKeys.every((key) =>
      deepEqual(
        (a as Record<string, unknown>)[key],
        (b as Record<string, unknown>)[key],
      ),
    );
  }
  return false;
}

/**
 * Drive the persist -> expected -> reload -> compare cycle for `spec`.
 *
 * Throws a Vitest-surfaced assertion naming the offending key path when:
 * - the maximal fixture omits or defaults a persisted key path (before persist);
 * - `reload()` returns `null` (the fixture was never persisted);
 * - a persisted key path diverges from the expected persisted value on reload;
 * - a `derived-on-write` key path is absent/default in the value returned by persist.
 */
export async function assertRoundTripDurability<
  TSchema extends z.ZodObject<z.ZodRawShape>,
>(spec: RoundTripSpec<TSchema>): Promise<void> {
  const policies: FieldPolicyMap = spec.fieldPolicies ?? {};

  const fixture = spec.buildMaximalFixture();
  assertComplete(
    { label: spec.label, policies, enforceDerived: false },
    spec.schema,
    fixture,
    "",
  );

  const expected = await spec.persist(fixture);

  // Every declared `derived-on-write` key path must be present and non-default
  // in the value returned by persist; otherwise the write path failed to derive
  // it and a reload comparison would be meaningless.
  assertComplete(
    { label: spec.label, policies, enforceDerived: true },
    spec.schema,
    expected,
    "",
  );

  const reloaded = await spec.reload(expected);
  if (reloaded === null) {
    throw new DurabilityError(
      spec.label,
      "<root>",
      "reload() returned null; the fixture was not persisted at all",
    );
  }

  assertReloadMatches(
    { label: spec.label, policies },
    spec.schema,
    expected,
    reloaded,
    "",
  );
}
