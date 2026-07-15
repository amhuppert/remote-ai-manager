/**
 * Format an ISO timestamp as a compact relative-time string.
 *
 * Two styles cover every call site:
 *   - "long"  (default): "just now" / "5m ago" / "3h ago" / "2d ago"
 *   - "short":           "now"      / "5m"     / "3h"     / "2d"
 *
 * `now` is injectable so callers that need deterministic output (view-model
 * derivations, tests) can pass a fixed clock; it defaults to `Date.now()`.
 */
export interface FormatRelativeTimeOptions {
  style?: "long" | "short";
  now?: number;
}

export function formatRelativeTime(
  isoDate: string,
  options: FormatRelativeTimeOptions = {},
): string {
  const { style = "long", now = Date.now() } = options;
  const diff = now - new Date(isoDate).getTime();
  const minutes = Math.floor(diff / 60_000);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (style === "short") {
    if (minutes < 1) return "now";
    if (minutes < 60) return `${minutes}m`;
    if (hours < 24) return `${hours}h`;
    return `${days}d`;
  }

  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  if (hours < 24) return `${hours}h ago`;
  return `${days}d ago`;
}
