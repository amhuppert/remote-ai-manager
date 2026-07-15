/**
 * Claude-owned wire projection for structured-output JSON schemas.
 *
 * Claude's native structured-output enforcement (`outputFormat: { type:
 * "json_schema" }`) validates the listed keywords against the model's output
 * but cannot steer generation to satisfy them, so a schema carrying them makes
 * the claude_code backend loop and fail the whole turn ("Failed to provide
 * valid structured output after N attempts"). The schema handed to Claude must
 * omit them; bounds live in field descriptions (advisory) and in CC's own Zod
 * `safeParse` instead. See docs/structured-data-responses.md §Backend
 * Enforcement Compatibility. Codex tolerates these keywords, so its adapter
 * applies no projection — this asymmetry is provider knowledge owned below the
 * backend seam.
 */

/**
 * Keywords Claude's native enforcement validates but cannot steer. The
 * documented set plus `exclusiveMinimum`/`exclusiveMaximum` — the same
 * numeric-range class, and what Zod emits for `.positive()`/`.gt()`.
 */
export const UNSUPPORTED_CLAUDE_STRUCTURED_OUTPUT_KEYWORDS = [
  "minLength",
  "maxLength",
  "pattern",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minItems",
  "maxItems",
] as const;

const UNSUPPORTED_KEYWORD_SET: ReadonlySet<string> = new Set(
  UNSUPPORTED_CLAUDE_STRUCTURED_OUTPUT_KEYWORDS,
);

/**
 * Object keys whose values are name→schema maps: the map keys are user-chosen
 * names, never JSON Schema keywords, so they must not be treated as such.
 */
const SCHEMA_MAP_KEYS: ReadonlySet<string> = new Set(["properties", "$defs"]);

/**
 * Object keys whose values are data, not schemas: keyword-shaped keys inside
 * them (e.g. a `default` object with a `minimum` field) are payload, not
 * constraints.
 */
const DATA_VALUE_KEYS: ReadonlySet<string> = new Set([
  "enum",
  "const",
  "default",
  "examples",
]);

/** Pure. Returns every path in `schema` carrying an unsupported keyword. */
export function unsupportedStructuredOutputKeywordPaths(
  schema: unknown,
  path = "$",
): string[] {
  const hits: string[] = [];
  walkSchema(schema, path, hits);
  return hits;
}

/** Pure. Deep-copies `schema` with every unsupported keyword removed, everything else preserved. */
export function projectSchemaForClaude(
  schema: Record<string, unknown>,
): Record<string, unknown> {
  return projectRecord(schema);
}

function walkSchema(node: unknown, path: string, hits: string[]): void {
  if (Array.isArray(node)) {
    node.forEach((item, index) => walkSchema(item, `${path}[${index}]`, hits));
    return;
  }
  if (!isRecord(node)) return;
  for (const [key, value] of Object.entries(node)) {
    const childPath = `${path}.${key}`;
    if (UNSUPPORTED_KEYWORD_SET.has(key)) {
      hits.push(childPath);
      continue;
    }
    if (DATA_VALUE_KEYS.has(key)) continue;
    if (SCHEMA_MAP_KEYS.has(key) && isRecord(value)) {
      for (const [name, child] of Object.entries(value)) {
        walkSchema(child, `${childPath}.${name}`, hits);
      }
      continue;
    }
    walkSchema(value, childPath, hits);
  }
}

function projectRecord(node: Record<string, unknown>): Record<string, unknown> {
  const projected: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if (UNSUPPORTED_KEYWORD_SET.has(key)) continue;
    if (DATA_VALUE_KEYS.has(key)) {
      projected[key] = structuredClone(value);
      continue;
    }
    if (SCHEMA_MAP_KEYS.has(key) && isRecord(value)) {
      const map: Record<string, unknown> = {};
      for (const [name, child] of Object.entries(value)) {
        map[name] = projectNode(child);
      }
      projected[key] = map;
      continue;
    }
    projected[key] = projectNode(value);
  }
  return projected;
}

function projectNode(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(projectNode);
  if (isRecord(node)) return projectRecord(node);
  return node;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
