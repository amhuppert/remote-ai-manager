import { z } from "zod";

/**
 * Returns whether `schema` applies any "effect" — anything that makes
 * `schema.parse(x)` produce output structurally different from `x`:
 * `.default()`, `.prefault()`, `.catch()`, `.transform()` / `.preprocess()`
 * (a `pipe` wrapping a transform), or `z.coerce.*`. Optional, nullable, refine,
 * enum, literal, object, array, union, record etc. are not effects.
 *
 * An effect-free schema's parse output deep-equals its input, so skipping the
 * parse in production (`parseTrusted`) cannot diverge from dev/test behavior.
 * The check recursively walks Zod v4's internal `_zod.def` tree, which is the
 * exact surface: `z.toJSONSchema` cannot observe coercion or input-side
 * preprocessing, and asymmetrically emits `additionalProperties` between its
 * input/output projections. This is a test-only helper; if Zod's internals
 * change it fails loudly and is corrected here.
 */
export function isEffectFree(schema: z.ZodType): boolean {
  return !hasEffect(schema, new Set());
}

const EFFECT_TYPES = new Set(["default", "prefault", "catch", "transform"]);

const CHILD_KEYS = [
  "innerType",
  "element",
  "keyType",
  "valueType",
  "left",
  "right",
  "in",
  "out",
  "rest",
] as const;

function hasEffect(schema: z.ZodType, visited: Set<z.ZodType>): boolean {
  if (visited.has(schema)) return false;
  visited.add(schema);

  const def = defOf(schema);
  if (def["coerce"] === true) return true;
  const type = def["type"];
  if (typeof type === "string" && EFFECT_TYPES.has(type)) return true;

  return childSchemas(def).some((child) => hasEffect(child, visited));
}

function defOf(schema: z.ZodType): Record<string, unknown> {
  const internal: unknown = (schema as { _zod?: unknown })._zod;
  if (
    typeof internal !== "object" ||
    internal === null ||
    !("def" in internal)
  ) {
    throw new Error("isEffectFree: expected a Zod schema exposing _zod.def");
  }
  const def = (internal as { def: unknown }).def;
  if (typeof def !== "object" || def === null) {
    throw new Error("isEffectFree: expected _zod.def to be an object");
  }
  return def as Record<string, unknown>;
}

function isZodSchema(value: unknown): value is z.ZodType {
  return typeof value === "object" && value !== null && "_zod" in value;
}

function childSchemas(def: Record<string, unknown>): z.ZodType[] {
  const children: z.ZodType[] = [];
  const pushOne = (value: unknown): void => {
    if (isZodSchema(value)) children.push(value);
  };
  const pushAll = (value: unknown): void => {
    if (Array.isArray(value)) value.forEach(pushOne);
  };

  for (const key of CHILD_KEYS) pushOne(def[key]);
  pushAll(def["options"]);
  pushAll(def["items"]);

  const shape = def["shape"];
  if (typeof shape === "object" && shape !== null) {
    Object.values(shape as Record<string, unknown>).forEach(pushOne);
  }

  const getter = def["getter"];
  if (typeof getter === "function") {
    pushOne((getter as () => unknown)());
  }

  return children;
}
