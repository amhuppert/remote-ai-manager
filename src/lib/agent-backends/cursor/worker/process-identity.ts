import { execFile, execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { promisify } from "node:util";

/**
 * Process identity beyond the pid (spec D9).
 *
 * A pid alone cannot own a signal: the kernel recycles pids, so a stored pid may
 * name an unrelated process by the time teardown escalates. Pairing the pid with
 * its process start marker gives the ownership guard a durable identity to
 * compare before signalling anything.
 *
 * Linux reads `/proc/<pid>/stat`; darwin has no `/proc`, so it asks `ps`
 * (whose own source is the kernel's proc table). On any other host every read
 * is null, meaning "identity unverifiable", and every caller treats that as a
 * refusal rather than a fallback.
 */

const execFileAsync = promisify(execFile);

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

/**
 * The pid `ps` should be asked about, or null when the target is not a real,
 * addressable process — pid 0 names the kernel, which `ps` happily reports but
 * no ownership check may ever claim.
 */
function darwinTargetPid(pid: number | "self"): number | null {
  const target = pid === "self" ? process.pid : pid;
  return Number.isInteger(target) && target > 0 ? target : null;
}

/** The process group this process leads or belongs to; null when unreadable. */
export function readProcessGroupIdSync(pid: number | "self"): number | null {
  if (process.platform === "darwin") {
    const target = darwinTargetPid(pid);
    if (target === null) return null;
    try {
      return parsePositiveInteger(
        execFileSync("ps", ["-o", "pgid=", "-p", String(target)], {
          encoding: "utf8",
        }).trim(),
      );
    } catch {
      return null;
    }
  }
  try {
    return parsePositiveInteger(
      fieldAt(readFileSync(`/proc/${pid}/stat`, "utf8"), 5),
    );
  } catch {
    return null;
  }
}

/**
 * A per-process start marker: boot-relative start ticks on linux (field 22),
 * the full start timestamp on darwin (`lstart`, stable across reads). Opaque
 * and only ever compared for equality on repeated reads of the same pid. Its
 * units never matter, and markers belonging to different pids need not differ.
 */
export async function readProcessStartTicks(
  pid: number,
): Promise<string | null> {
  if (process.platform === "darwin") {
    const target = darwinTargetPid(pid);
    if (target === null) return null;
    try {
      const { stdout } = await execFileAsync(
        "ps",
        ["-o", "lstart=", "-p", String(target)],
        { encoding: "utf8" },
      );
      const value = stdout.trim();
      return value.length > 0 ? value : null;
    } catch {
      return null;
    }
  }
  try {
    const value = fieldAt(await readFile(`/proc/${pid}/stat`, "utf8"), 22);
    return value !== null && value.length > 0 ? value : null;
  } catch {
    return null;
  }
}
