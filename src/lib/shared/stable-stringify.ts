/**
 * Canonical JSON bytes for domain hashes and persistence. Object keys are
 * sorted recursively so structurally equal values serialize identically.
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
    // An object key set to `undefined` is an absent field, and encoding it as
    // `null` writes a row the reader's own schema rejects: a domain field
    // declared `.optional()` but not nullable comes back as an unparseable
    // value, and the record can never be loaded again. Arrays keep the `null`
    // encoding below, where position is meaning.
    if (obj[k] === undefined) continue;
    parts.push(JSON.stringify(k) + ":" + stableStringify(obj[k]));
  }
  return "{" + parts.join(",") + "}";
}
