import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";

/**
 * Process identity beyond the pid (spec D9).
 *
 * A pid alone cannot own a signal: the kernel recycles pids, so a stored pid may
 * name an unrelated process by the time teardown escalates. The boot-time start
 * ticks in `/proc/<pid>/stat` make the identity durable — a recycled pid always
 * reads a later start time — which is what the ownership guard compares before
 * signalling anything.
 *
 * Linux-only by design: the Cursor preflight already refuses every host outside
 * the tested Linux baseline, so a null here means "identity unverifiable", and
 * every caller treats that as a refusal rather than a fallback.
 */

/**
 * `/proc/<pid>/stat` fields are space-separated, except field 2 (`comm`) which
 * is parenthesized and may itself contain spaces and parentheses. Splitting
 * after the LAST `)` is the only parse that survives a process named `a) b (c`.
 */
function statFields(raw: string): string[] | null {
  const commEnd = raw.lastIndexOf(")");
  if (commEnd === -1) return null;
  // The remainder starts at field 3 (state), so field N is at index N - 3.
  return raw
    .slice(commEnd + 2)
    .trim()
    .split(" ");
}

function fieldAt(raw: string, fieldNumber: number): string | null {
  const fields = statFields(raw);
  if (fields === null) return null;
  return fields[fieldNumber - 3] ?? null;
}

function parsePositiveInteger(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

/**
 * The `errno` code of a failed system call, read rather than asserted: signal
 * probes distinguish "no such process" from "exists but not signalable by us",
 * and that distinction must not rest on an unchecked cast of a thrown value.
 */
export function errnoCode(error: unknown): string | null {
  if (error === null || typeof error !== "object") return null;
  const code: unknown = Reflect.get(error, "code");
  return typeof code === "string" ? code : null;
}

/** The process group this process leads or belongs to; null when unreadable. */
export function readProcessGroupIdSync(pid: number | "self"): number | null {
  try {
    return parsePositiveInteger(
      fieldAt(readFileSync(`/proc/${pid}/stat`, "utf8"), 5),
    );
  } catch {
    return null;
  }
}

/**
 * Boot-relative start ticks (field 22). Opaque and only ever compared for
 * equality — its units never matter, only that the same process keeps the same
 * value and a recycled pid does not.
 */
export async function readProcessStartTicks(
  pid: number,
): Promise<string | null> {
  try {
    const value = fieldAt(await readFile(`/proc/${pid}/stat`, "utf8"), 22);
    return value !== null && value.length > 0 ? value : null;
  } catch {
    return null;
  }
}
