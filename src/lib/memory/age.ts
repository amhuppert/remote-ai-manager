import type { MemoryStatusNote } from "./schemas";

/**
 * The one age vocabulary every memory surface renders (spec R2.2), kept apart
 * from the freshness engine so a client component can call it: the engine
 * itself reaches the repository and the server logger, and a `"use client"`
 * module that imported it would pull `node:fs` into the browser bundle.
 * Assessment stays the engine's; only the words for "how old" live here.
 */

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

function plural(count: number, unit: string): string {
  return `${count} ${unit}${count === 1 ? "" : "s"} ago`;
}

/** "just now", "3 hours ago", "12 days ago" — the one age vocabulary every surface renders. */
export function describeMemoryAge(fromIso: string, nowIso: string): string {
  const elapsed = Date.parse(nowIso) - Date.parse(fromIso);
  if (Number.isNaN(elapsed) || elapsed < MINUTE_MS) return "just now";
  if (elapsed < HOUR_MS)
    return plural(Math.floor(elapsed / MINUTE_MS), "minute");
  if (elapsed < DAY_MS) return plural(Math.floor(elapsed / HOUR_MS), "hour");
  return plural(Math.floor(elapsed / DAY_MS), "day");
}

/**
 * The status line as delivered: the claim and how old it is. Age counts from
 * when the claim was WRITTEN, not from its last review — a review refreshes
 * the lease, it does not make an old claim recent.
 */
export function renderMemoryStatusLine(
  statusNote: MemoryStatusNote,
  nowIso: string,
): string {
  return `${statusNote.text} (status as of ${describeMemoryAge(statusNote.updatedAt, nowIso)})`;
}
