import type { FilterToken } from "../components/filter-tokens";

/**
 * Parse a composer filter-mode draft (`key:value`) into a `FilterToken`, or
 * `null` when it is not a complete, recognized filter. Accepts the filter keys
 * `is` (with `status` as an alias), `target`, `branch`, and `archived`
 * (`archived:true`/`include` ⇒ include; `archived:only` ⇒ only-archived).
 *
 * Pure and dependency-free so it can be unit-tested directly and called on every
 * Enter in the unified composer's filter mode.
 */
export function parseFilterDraft(draft: string): FilterToken | null {
  const trimmed = draft.trim();
  const idx = trimmed.indexOf(":");
  if (idx <= 0) return null;
  const key = trimmed.slice(0, idx).toLowerCase();
  const value = trimmed.slice(idx + 1).trim();

  switch (key) {
    case "is":
    case "status":
      return value ? { cat: "status", key: "is", value } : null;
    case "target":
      return value ? { cat: "target", key: "target", value } : null;
    case "branch":
      return value ? { cat: "branch", key: "branch", value } : null;
    case "archived": {
      const v = value.toLowerCase();
      if (v === "true" || v === "include") {
        return { cat: "archived", key: "include", value: "include" };
      }
      if (v === "only") {
        return { cat: "archived", key: "only", value: "only", exclusive: true };
      }
      return null;
    }
    default:
      return null;
  }
}

/** Replace any existing token in the same category, keeping one filter per cat. */
export function replaceTokenByCat(
  tokens: FilterToken[],
  token: FilterToken,
): FilterToken[] {
  return [...tokens.filter((t) => t.cat !== token.cat), token];
}
