/**
 * Deterministic JSON serialization shared across the state-store repos. Object
 * keys are emitted in sorted order recursively so that two domain values that
 * are structurally equal serialize to byte-identical strings — the property the
 * per-column reference diff and the conditional definition-tier write both rely
 * on to decide whether a column actually changed.
 */
export function stableStringify(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return "[" + value.map(stableStringify).join(",") + "]";
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const parts: string[] = [];
  for (const k of keys) {
    parts.push(JSON.stringify(k) + ":" + stableStringify(obj[k]));
  }
  return "{" + parts.join(",") + "}";
}

export function jsonOrNull(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  return stableStringify(value);
}
