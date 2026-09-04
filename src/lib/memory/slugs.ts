/**
 * Server-generated slugs (spec R4, D3): derived from the hook when the caller
 * gives none, and made collision-safe within the scope owner by the write path
 * through {@link suffixMemorySlug}.
 */

/**
 * Long enough for a hook's leading clause to survive, short enough that a
 * generated slug stays a usable shell argument and index-line handle.
 */
export const MEMORY_SLUG_MAX_LENGTH = 64;

const FALLBACK_SLUG = "note";

/**
 * Lowercase ASCII words joined by single hyphens. Diacritics are folded rather
 * than dropped so "réseau" yields "reseau", not "rseau"; everything else that is
 * not a letter or digit becomes a separator. A cut for length lands on a word
 * boundary, so a slug never ends mid-word.
 */
export function deriveMemorySlug(hook: string): string {
  const folded = hook.normalize("NFKD").replace(/[̀-ͯ]/g, "");
  const joined = folded
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (joined === "") return FALLBACK_SLUG;
  if (joined.length <= MEMORY_SLUG_MAX_LENGTH) return joined;
  const window = joined.slice(0, MEMORY_SLUG_MAX_LENGTH + 1);
  const boundary = window.lastIndexOf("-");
  const cut =
    boundary > 0
      ? window.slice(0, boundary)
      : window.slice(0, MEMORY_SLUG_MAX_LENGTH);
  return cut.replace(/-+$/g, "");
}

/**
 * The ordinal a colliding generated slug retries with (`-2`, `-3`, …), trimmed
 * so the result still honours the length cap.
 */
export function suffixMemorySlug(slug: string, ordinal: number): string {
  const suffix = `-${ordinal}`;
  const room = MEMORY_SLUG_MAX_LENGTH - suffix.length;
  const base =
    slug.length > room ? slug.slice(0, room).replace(/-+$/g, "") : slug;
  return `${base}${suffix}`;
}
