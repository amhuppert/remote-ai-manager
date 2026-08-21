/**
 * Both directions of the Codex structured-output schema adaptation.
 *
 * CC's authored JSON Schema is the canonical contract, and it is laxer than the
 * strict dialect the provider enforces behind Codex's `outputSchema`. The whole
 * cost of that difference is paid here, in the backend adapter, so neutral
 * callers keep writing the schema they mean:
 *
 * - {@link projectSchemaForCodex} rewrites the authored schema into the strict
 *   dialect on the way out.
 * - {@link restoreCodexOptionalOmissions} undoes the rewrite's one observable
 *   consequence on the way back in, so the payload reaching the shared output
 *   gate matches the authored schema rather than the projected one.
 *
 * The pair belongs in one module because a projection that changes what the
 * model may emit, without the matching restore, does not fail at dispatch — it
 * fails the gate three retries later as an unexplained validator error.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(target: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(target, key);
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

  if (isRecord(value.properties)) {
    const alreadyRequired = requiredKeys(value);
    const declared = Object.keys(value.properties);
    projected.properties = Object.fromEntries(
      Object.entries(value.properties).map(([key, schema]) => {
        const child = projectCodexSchemaNode(schema);
        return [
          key,
          alreadyRequired.has(key) ? child : nullableForCodex(child),
        ];
      }),
    );
    // The strict dialect has no optional property: `required` must name every
    // declared key, or the dispatch is refused outright (HTTP 400,
    // `invalid_json_schema`). An authored-optional key therefore travels as
    // required-and-nullable, and `restoreCodexOptionalOmissions` reads the null
    // back as the omission the author described.
    if (declared.length > 0) projected.required = declared;
  }
  if (isRecord(value.items)) {
    projected.items = projectCodexSchemaNode(value.items);
  }
  for (const key of ["anyOf", "oneOf"] as const) {
    const branches = value[key];
    if (Array.isArray(branches)) {
      projected[key] = branches.map(projectCodexSchemaNode);
    }
  }

  return projected;
}

/**
 * Rewrites an authored schema into the strict dialect Codex's provider enforces:
 * the redundant `type` beside a primitive `const`, and a `required` naming every
 * declared property with the authored-optional ones widened to admit `null`.
 *
 * The authored schema is left intact — CC's validator treats it as the canonical
 * contract and validates model output against it.
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
