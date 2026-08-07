/**
 * Edge identity: one minting scheme, and the inflate-time normalization that
 * makes it safe to require uniqueness (D4 R1 / decision D2).
 *
 * Edge ids became first-class in D4 — guards make parallel edges between the
 * same pair meaningful, and every id-addressed edit resolves an edge by id — so
 * accept-time validation refuses duplicates for NEW authoring. Definitions
 * written before that rule exist with absent or duplicate ids, and refusing them
 * would brick templates at launch. So the boundary that inflates a stored
 * document repairs the ids instead, deterministically: the same stored bytes
 * normalize to the same ids on every load, and the next write persists them.
 *
 * Dependency-free on purpose: reached from the state-store read path, the
 * workflow storage read path, and both edit vocabularies.
 */

/**
 * `source__target`, then `-2`, `-3` … by duplicate ordinal. The single minting
 * scheme — saved-tier edits, live edits, and legacy normalization all call this,
 * so an id minted at runtime is indistinguishable from one minted at inflate.
 */
export function mintEdgeId(
  existingIds: ReadonlySet<string>,
  sourceContextId: string,
  targetContextId: string,
): string {
  const base = `${sourceContextId}__${targetContextId}`;
  if (!existingIds.has(base)) return base;
  let suffix = 2;
  while (existingIds.has(`${base}-${suffix}`)) suffix += 1;
  return `${base}-${suffix}`;
}

/**
 * Give every edge of a RAW (not yet schema-parsed) definition a unique id,
 * in place. Runs before the Zod parse because the parse already requires `id`,
 * so a legacy document missing one would fail there with an opaque error.
 *
 * Deterministic and idempotent: edges are visited in array order, the first
 * claim on an id wins, and anything absent, blank, non-string, or already taken
 * is minted from its endpoints. Re-running over the result changes nothing.
 *
 * An edge whose endpoints are unusable is left exactly as found — it cannot be
 * minted from, and the structural validator refuses it with a locator that
 * names the real problem.
 */
export function normalizeRawDefinitionEdgeIds(rawDefinition: unknown): void {
  if (!isRecord(rawDefinition)) return;
  const edges = rawDefinition.edges;
  if (!Array.isArray(edges)) return;

  const reserved = new Set<string>();
  for (const edge of edges) {
    if (!isRecord(edge)) continue;

    // Trimmed to match the schema's own `z.string().trim()`, so an id that
    // survives normalization cannot become a duplicate at parse time.
    const declared = typeof edge.id === "string" ? edge.id.trim() : "";
    if (declared.length > 0 && !reserved.has(declared)) {
      edge.id = declared;
      reserved.add(declared);
      continue;
    }

    const source = trimmedString(edge.sourceContextId);
    const target = trimmedString(edge.targetContextId);
    if (source === null || target === null) continue;

    const minted = mintEdgeId(reserved, source, target);
    edge.id = minted;
    reserved.add(minted);
  }
}

function trimmedString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
