import { z } from "zod";

/**
 * Detects collections that can grow without a static bound inside a Zod schema
 * that is serialized whole into a single SQLite TEXT column ("blob").
 *
 * Every such collection is a write/read-amplification and unbounded-growth risk:
 * mutating one element rewrites the entire column, and nothing in the schema
 * caps the element count. The gate that consumes this module forces every
 * unbounded collection in a persisted blob to carry an explicit discharge
 * (a static `.max()` self-discharges; everything else is declared in a registry
 * naming where/why it is bounded), so the decision is made when the field is
 * added rather than discovered in production.
 *
 * Detection walks the schema's JSON Schema projection (`z.toJSONSchema`) — the
 * stable, documented surface — rather than Zod's internal `_def`, and treats an
 * array without `maxItems` or an open map (`additionalProperties` schema) as
 * unbounded.
 */

export type UnboundedCollectionKind = "array" | "record";

export interface UnboundedCollection {
  /** Dotted path from the blob root. `[]` = array element, `.*` = map value. */
  readonly path: string;
  readonly kind: UnboundedCollectionKind;
}

function isObjectNode(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asObjectArray(value: unknown): readonly Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isObjectNode);
}

function typeIncludes(node: Record<string, unknown>, wanted: string): boolean {
  const type = node["type"];
  if (typeof type === "string") return type === wanted;
  if (Array.isArray(type)) return type.includes(wanted);
  return false;
}

function joinPath(parent: string, segment: string): string {
  if (segment.startsWith("[")) return `${parent}${segment}`;
  return parent ? `${parent}.${segment}` : segment;
}

interface WalkContext {
  readonly defs: Record<string, unknown>;
  readonly found: UnboundedCollection[];
  readonly visitedRefs: Set<string>;
}

function resolveRef(ref: string, ctx: WalkContext): unknown {
  const marker = "#/$defs/";
  if (!ref.startsWith(marker)) return undefined;
  const key = ref.slice(marker.length);
  return ctx.defs[key];
}

function walk(node: unknown, path: string, ctx: WalkContext): void {
  if (!isObjectNode(node)) return;

  const ref = node["$ref"];
  if (typeof ref === "string") {
    if (ctx.visitedRefs.has(ref)) return;
    ctx.visitedRefs.add(ref);
    walk(resolveRef(ref, ctx), path, ctx);
    return;
  }

  for (const combinator of ["anyOf", "oneOf", "allOf"] as const) {
    for (const branch of asObjectArray(node[combinator])) {
      walk(branch, path, ctx);
    }
  }

  if (typeIncludes(node, "array")) {
    const bounded = typeof node["maxItems"] === "number";
    if (!bounded) ctx.found.push({ path, kind: "array" });
    walk(node["items"], joinPath(path, "[]"), ctx);
    for (const item of asObjectArray(node["prefixItems"])) {
      walk(item, joinPath(path, "[]"), ctx);
    }
  }

  const properties = node["properties"];
  if (isObjectNode(properties)) {
    for (const [key, child] of Object.entries(properties)) {
      walk(child, joinPath(path, key), ctx);
    }
  }

  const additional = node["additionalProperties"];
  const isOpenMap = additional === true || isObjectNode(additional);
  if (isOpenMap && !isObjectNode(properties)) {
    ctx.found.push({ path, kind: "record" });
  }
  if (isObjectNode(additional)) {
    walk(additional, joinPath(path, "*"), ctx);
  }
}

/**
 * Returns every unbounded collection reachable in `schema`, identified by a path
 * from the blob root. Resolves `$ref`/`$defs` and breaks reference cycles.
 */
export function findUnboundedCollections(
  schema: z.ZodType,
): UnboundedCollection[] {
  const json: unknown = z.toJSONSchema(schema, {
    io: "output",
    unrepresentable: "any",
    cycles: "ref",
  });
  const rawDefs = isObjectNode(json) ? json["$defs"] : undefined;
  const ctx: WalkContext = {
    defs: isObjectNode(rawDefs) ? rawDefs : {},
    found: [],
    visitedRefs: new Set<string>(),
  };
  walk(json, "", ctx);
  return ctx.found;
}

const SUBTREE_SUFFIX = ".**";

/**
 * True when discharge `key` covers `path`.
 *
 * A plain key matches exactly one node, so a collection added beside a
 * discharged one is still caught. A key ending in `.**` covers its node and
 * every descendant — the deliberate escape for an immutable subtree (e.g. an
 * author-fixed definition that is never mutated at runtime).
 */
function dischargeCovers(path: string, key: string): boolean {
  if (key.endsWith(SUBTREE_SUFFIX)) {
    const base = key.slice(0, -SUBTREE_SUFFIX.length);
    return (
      path === base ||
      path.startsWith(`${base}.`) ||
      path.startsWith(`${base}[`)
    );
  }
  return path === key;
}

export interface DischargeReconciliation {
  /** Unbounded collections no discharge covers — these fail the gate. */
  readonly undischarged: readonly UnboundedCollection[];
  /** Discharge keys that cover no unbounded collection — stale, fail the gate. */
  readonly staleDischargeKeys: readonly string[];
}

/**
 * Matches discovered unbounded collections against the declared discharges.
 * Keys match exactly unless suffixed with `.**` (covers a whole subtree). Stale
 * keys (covering nothing) are reported so the registry cannot rot as schemas
 * shrink or fields are renamed.
 */
export function reconcileDischarges(
  found: readonly UnboundedCollection[],
  discharges: Readonly<Record<string, string>>,
): DischargeReconciliation {
  const keys = Object.keys(discharges);
  const undischarged = found.filter(
    (node) => !keys.some((key) => dischargeCovers(node.path, key)),
  );
  const staleDischargeKeys = keys.filter(
    (key) => !found.some((node) => dischargeCovers(node.path, key)),
  );
  return { undischarged, staleDischargeKeys };
}
