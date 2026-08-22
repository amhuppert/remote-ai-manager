import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

/**
 * Host process scans for the cancellation and lifetime acceptance cases
 * (spec R9.1, R9.2, R9.3, R9.5, R14.2).
 *
 * Cancellation is the criterion the transport choice turned on, and the only
 * honest way to check it is to ask the operating system rather than the SDK:
 * "is this exact process still on the host". Every helper here answers that
 * about a process the fixture itself marked, so a stray unrelated match cannot
 * be mistaken for a survivor.
 */

export interface MarkedProcess {
  pid: number;
  ppid: number;
  pgid: number;
}

/**
 * Every live process in a process group — a worker and everything it spawned.
 *
 * The credential criterion covers "the worker environment or ANY environment
 * the worker passes to its children", so the unit that has to be scanned is the
 * group, not the worker pid. Each Cursor worker leads its own group, which is
 * what makes the group the exact boundary of one conversation.
 */
export function findGroupPids(pgid: number): readonly number[] {
  try {
    return execFileSync("ps", ["-o", "pid=", "-g", String(pgid)], {
      encoding: "utf8",
    })
      .split("\n")
      .map((line) => Number.parseInt(line.trim(), 10))
      .filter((pid) => Number.isInteger(pid) && pid > 0);
  } catch {
    // `ps` exits non-zero when the group is already gone.
    return [];
  }
}

/** Pids whose full command line contains `marker`. */
export function findMarkedPids(marker: string): readonly number[] {
  try {
    return execFileSync("pgrep", ["-f", marker], { encoding: "utf8" })
      .split("\n")
      .map((line) => Number.parseInt(line.trim(), 10))
      .filter((pid) => Number.isInteger(pid) && pid > 0);
  } catch {
    // pgrep exits 1 when nothing matches, which is the passing case here.
    return [];
  }
}

/**
 * Identity of a live process, read from `/proc/<pid>/stat`. Null once the
 * process is gone — which is exactly the transition these cases measure.
 */
export function readMarkedProcess(pid: number): MarkedProcess | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    // The comm field can contain spaces and parentheses, so fields are read
    // after the last ')' rather than by splitting the whole line.
    const afterComm = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const ppid = Number.parseInt(afterComm[1] ?? "", 10);
    const pgid = Number.parseInt(afterComm[2] ?? "", 10);
    if (!Number.isInteger(ppid) || !Number.isInteger(pgid)) return null;
    return { pid, ppid, pgid };
  } catch {
    return null;
  }
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means it exists and belongs to someone else; ESRCH means gone.
    return (
      typeof error === "object" &&
      error !== null &&
      Reflect.get(error, "code") === "EPERM"
    );
  }
}

export function isGroupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    return (
      typeof error === "object" &&
      error !== null &&
      Reflect.get(error, "code") === "EPERM"
    );
  }
}

/** Milliseconds until `predicate` holds, or null if it never did. */
export async function measureUntil(
  predicate: () => boolean,
  timeoutMs: number,
  intervalMs = 25,
): Promise<number | null> {
  const started = Date.now();
  const deadline = started + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return Date.now() - started;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return predicate() ? Date.now() - started : null;
}
