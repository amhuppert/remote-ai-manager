/**
 * The Codex structured-output transport: everything that turns an authored
 * JSON Schema into what the provider will accept, and turns the provider's
 * answer back into the authored shape.
 *
 * CC's authored JSON Schema is the canonical contract, and it is laxer than the
 * strict dialect the provider enforces behind Codex's `outputSchema`. The whole
 * cost of that difference is paid here, in the backend adapter, so neutral
 * callers keep writing the schema they mean:
 *
 * - {@link resolveCodexStructuredOutput} decides how one authored schema
 *   reaches the model. A schema the strict dialect can express is projected
 *   into it and enforced natively; a schema it cannot express rides the prompt
 *   as the neutral rendered contract, with the shared output gate as the only
 *   enforcement — the same path Claude always takes.
 * - {@link projectSchemaForCodex} is the strict-dialect rewrite itself.
 * - {@link restoreCodexOptionalOmissions} undoes the rewrite's one observable
 *   consequence on the way back in, so the payload reaching the shared output
 *   gate matches the authored schema rather than the projected one.
 *
 * The pieces belong in one module because a projection that changes what the
 * model may emit, without the matching restore, does not fail at dispatch — it
 * fails the gate three retries later as an unexplained validator error. And a
 * schema handed to the provider outside the projection is refused at dispatch
 * with HTTP 400 `invalid_json_schema`, which every retry repeats identically.
 *
 * The strict dialect's rules, as the provider stated them when refusing live
 * dispatches (execution 81d48065, execution cc44014e, and a probe of one
 * schema per rule on 2026-09-01):
 *
 * - the root must be a single object schema; a `oneOf`/`anyOf` root is refused
 * - `oneOf` is refused everywhere; `anyOf` is the union it permits
 * - every object must say `additionalProperties: false`
 * - every object must list `properties`, and `required` must name all of them
 * - a `const` node must also carry `type`
 *
 * Everything else CC's authoring subset admits — every constraint keyword,
 * `enum` without `type`, `type` arrays, `$schema`, and annotations — passes
 * through untouched.
 */

import {
  appendStructuredOutputInstruction,
  renderStructuredOutputInstruction,
} from "../structured-output-prompt";

/** The prompt shape both Codex adapters dispatch: text, or text with images. */
export type CodexPromptInput =
  | string
  | Array<
      { type: "text"; text: string } | { type: "local_image"; path: string }
    >;

export type CodexStructuredOutputTransport = "native" | "prompt_contract";

/**
 * How one authored schema travels on a Codex dispatch. Adapters use it
 * end-to-end: `prepareInput` on the prompt they built, `outputSchema` on the
 * SDK turn, and `restore` on the parsed final response.
 */
export interface CodexStructuredOutputDispatch {
  readonly transport: CodexStructuredOutputTransport;
  /**
   * The strict-dialect projection for the SDK's `outputSchema`, or undefined
   * when the contract rides the prompt instead.
   */
  readonly outputSchema: Record<string, unknown> | undefined;
  /** Why the contract rides the prompt, for the adapter's log line; null natively. */
  readonly reason: string | null;
  /** The prompt to dispatch, with the rendered contract appended where it does not travel natively. */
  prepareInput(input: CodexPromptInput): CodexPromptInput;
  /** Reads a parsed final response back into the authored shape. */
  restore(value: unknown): unknown;
}

export function resolveCodexStructuredOutput(
  schema: Record<string, unknown>,
): CodexStructuredOutputDispatch {
  const gap = findStrictDialectGap(schema);
  if (gap !== null) {
    return {
      transport: "prompt_contract",
      outputSchema: undefined,
      reason: gap,
      prepareInput: (input) => appendContract(input, schema),
      // Nothing was projected, so a null in the response is the model's own
      // value for the gate to judge.
      restore: (value) => value,
    };
  }
  return {
    transport: "native",
    outputSchema: projectSchemaForCodex(schema),
    reason: null,
    prepareInput: (input) => input,
    restore: (value) => restoreCodexOptionalOmissions(schema, value),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(target: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(target, key);
}

/**
 * Whether a node constrains the payload to a JSON object: `type: "object"`,
 * a `type` array naming only "object", or object keywords with no `type`.
 */
function describesObject(node: Record<string, unknown>): boolean {
  const type = node.type;
  if (type === "object") return true;
  if (Array.isArray(type)) {
    return type.length > 0 && type.every((entry) => entry === "object");
  }
  return type === undefined && isRecord(node.properties);
}

/**
 * The first place the authored schema asks for something the strict dialect
 * has no way to say, or null when the whole schema can be projected. A free-form
 * object is the important case: the dialect can only close an object over its
 * declared properties, so one that declares none would be coerced to `{}` —
 * silent loss of the very payload the caller asked for.
 */
function findStrictDialectGap(schema: Record<string, unknown>): string | null {
  if (!describesObject(schema)) {
    return "$ must be a single object schema; the provider refuses a union or non-object root";
  }
  return findGapInNode(schema, "$");
}

function findGapInNode(node: unknown, path: string): string | null {
  if (!isRecord(node)) return null;

  if (describesObject(node)) {
    const additional = node.additionalProperties;
    if (additional !== undefined && additional !== false) {
      return `${path} is an explicitly open object (additionalProperties is not false), which the strict dialect cannot express`;
    }
    if (!isRecord(node.properties) && additional !== false) {
      return `${path} is a free-form object with no declared properties, which the strict dialect could only express by coercing every payload to {}`;
    }
    if (isRecord(node.properties)) {
      for (const [key, child] of Object.entries(node.properties)) {
        const gap = findGapInNode(child, `${path}.properties.${key}`);
        if (gap !== null) return gap;
      }
    }
  }
  if (isRecord(node.items)) {
    const gap = findGapInNode(node.items, `${path}.items`);
    if (gap !== null) return gap;
  }
  for (const key of ["anyOf", "oneOf"] as const) {
    const branches = node[key];
    if (!Array.isArray(branches)) continue;
    for (const [index, branch] of branches.entries()) {
      const gap = findGapInNode(branch, `${path}.${key}[${index}]`);
      if (gap !== null) return gap;
    }
  }
  return null;
}

function appendContract(
  input: CodexPromptInput,
  schema: Record<string, unknown>,
): CodexPromptInput {
  if (typeof input === "string") {
    return appendStructuredOutputInstruction(input, schema);
  }
  const lastTextIndex = input.reduce(
    (found, item, index) => (item.type === "text" ? index : found),
    -1,
  );
  if (lastTextIndex === -1) {
    return [
      ...input,
      { type: "text", text: renderStructuredOutputInstruction(schema) },
    ];
  }
  return input.map((item, index) =>
    index === lastTextIndex && item.type === "text"
      ? { ...item, text: appendStructuredOutputInstruction(item.text, schema) }
      : item,
  );
}

function inferPrimitiveConstType(
  value: unknown,
): "string" | "number" | "boolean" | "null" | null {
  if (value === null) return "null";
  if (typeof value === "string") return "string";
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "number" && Number.isFinite(value)) return "number";
  return null;
}

function requiredKeys(schema: Record<string, unknown>): Set<string> {
  const required = schema.required;
  if (!Array.isArray(required)) return new Set();
  return new Set(
    required.filter((key): key is string => typeof key === "string"),
  );
}

/**
 * Whether the authored subschema already accepts `null`. Where it does, a null
 * in the response is the author's own value and the restore pass leaves it be.
 */
function admitsNull(schema: unknown): boolean {
  if (!isRecord(schema)) return false;
  if (schema.type === "null") return true;
  if (Array.isArray(schema.type) && schema.type.includes("null")) return true;
  if (Array.isArray(schema.enum) && schema.enum.includes(null)) return true;
  if (hasOwn(schema, "const") && schema.const === null) return true;
  for (const key of ["anyOf", "oneOf"] as const) {
    const branches = schema[key];
    if (Array.isArray(branches) && branches.some(admitsNull)) return true;
  }
  return false;
}

/**
 * Widens a projected subschema to admit `null`, the strict dialect's only way
 * to say "this key may carry nothing". A branch union rather than a union
 * `type`, because the authored node may carry keywords — `enum`, `const`,
 * `items` — that only mean anything against its own type.
 */
function nullableForCodex(schema: unknown): unknown {
  return admitsNull(schema) ? schema : { anyOf: [schema, { type: "null" }] };
}

function projectCodexSchemaNode(value: unknown): unknown {
  if (!isRecord(value)) return value;

  const projected: Record<string, unknown> = { ...value };
  if (!hasOwn(value, "type") && hasOwn(value, "const")) {
    const inferredType = inferPrimitiveConstType(value.const);
    if (inferredType !== null) projected.type = inferredType;
  }

  if (describesObject(value)) {
    if (!hasOwn(value, "type")) projected.type = "object";
    const properties = isRecord(value.properties) ? value.properties : {};
    const alreadyRequired = requiredKeys(value);
    projected.properties = Object.fromEntries(
      Object.entries(properties).map(([key, schema]) => {
        const child = projectCodexSchemaNode(schema);
        return [
          key,
          alreadyRequired.has(key) ? child : nullableForCodex(child),
        ];
      }),
    );
    // The strict dialect has no optional property: `required` must name every
    // declared key, or the dispatch is refused outright. An authored-optional
    // key therefore travels as required-and-nullable, and
    // `restoreCodexOptionalOmissions` reads the null back as the omission the
    // author described.
    projected.required = Object.keys(properties);
    // The dialect likewise refuses an object that does not say
    // `additionalProperties: false`. Closing an authored-open object narrows
    // what the model may emit, and every payload the closed node admits also
    // satisfies the authored one, so the gate never sees a difference.
    projected.additionalProperties = false;
  }
  if (isRecord(value.items)) {
    projected.items = projectCodexSchemaNode(value.items);
  }
  if (Array.isArray(value.anyOf)) {
    projected.anyOf = value.anyOf.map(projectCodexSchemaNode);
  }
  // `oneOf` is refused outright; `anyOf` is the union the dialect permits. The
  // widening from exactly-one to at-least-one is invisible to a discriminated
  // payload, and the gate still judges the response against the authored
  // `oneOf`.
  if (Array.isArray(value.oneOf)) {
    const existing = Array.isArray(projected.anyOf) ? projected.anyOf : [];
    projected.anyOf = [...existing, ...value.oneOf.map(projectCodexSchemaNode)];
    delete projected.oneOf;
  }

  return projected;
}

/**
 * Rewrites an authored schema into the strict dialect Codex's provider enforces:
 * `type` beside a primitive `const`, `anyOf` for `oneOf`, and on every object a
 * declared `type`, `additionalProperties: false`, and a `required` naming every
 * declared property with the authored-optional ones widened to admit `null`.
 *
 * The authored schema is left intact — CC's validator treats it as the canonical
 * contract and validates model output against it. Only reachable for a schema
 * {@link resolveCodexStructuredOutput} found expressible; a free-form object
 * handed here directly is closed over no properties.
 */
export function projectSchemaForCodex(
  schema: Record<string, unknown>,
): Record<string, unknown> {
  return projectCodexSchemaNode(schema) as Record<string, unknown>;
}

/**
 * The inverse of the projection's required-and-nullable rewrite: drops keys the
 * authored schema left optional that came back as an explicit `null`.
 *
 * Only what the projection could have caused is removed. A null at a key the
 * authored schema requires stays, because there it is a contract failure the
 * gate must see rather than an omission; a null the authored subschema itself
 * admits stays, because there it is the author's own value; and a key the schema
 * does not describe is passed through for the gate to judge.
 */
export function restoreCodexOptionalOmissions(
  schema: Record<string, unknown>,
  value: unknown,
): unknown {
  return restoreNode(schema, value);
}

function restoreNode(schema: unknown, value: unknown): unknown {
  if (!isRecord(schema)) return value;

  if (Array.isArray(value)) {
    const items = schema.items;
    return isRecord(items)
      ? value.map((entry) => restoreNode(items, entry))
      : value;
  }

  if (!isRecord(value)) return value;

  const properties = schema.properties;
  if (!isRecord(properties)) return value;

  const required = requiredKeys(schema);
  const restored: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    const propertySchema = properties[key];
    if (propertySchema === undefined) {
      restored[key] = entry;
      continue;
    }
    if (entry === null && !required.has(key) && !admitsNull(propertySchema)) {
      continue;
    }
    restored[key] = restoreNode(propertySchema, entry);
  }
  return restored;
}
