import { execSync } from "node:child_process";
import { readlink, realpath as nodeRealpath } from "node:fs/promises";
import path from "node:path";
import { createLogger } from "./logging";
import { getErrorMessage } from "@/lib/errors";

const logger = createLogger("dev-server");

// ============================================================
// Public types
// ============================================================

export interface PortOwnershipDeps {
  listListeningPids(port: number): Promise<number[]>;
  getProcessCwd(pid: number): Promise<string | null>;
  realpath(path: string): Promise<string | null>;
}

export interface PortOwnershipInput {
  port: number;
  worktreePath: string;
  allowedCwd?: string | null;
}

export type PortOwnershipResult =
  | { status: "available" }
  | { status: "owned"; pid: number; cwd: string }
  | { status: "conflict"; pid: number; cwd: string | null }
  | { status: "unknown"; reason: string };

export type ExecSyncLike = (
  command: string,
  options: {
    encoding: "utf-8";
    stdio: ["ignore", "pipe", "ignore"];
  },
) => string;

// ============================================================
// Pure path helpers
// ============================================================

/**
 * Normalize a filesystem path:
 * - Collapse `.` and redundant separators via `path.normalize`.
 * - Strip trailing slashes (except the root `/`).
 * This does NOT dereference symlinks — pair with `realpath` for that.
 */
export function normalizePath(p: string): string {
  if (!p) return "";
  const normalized = path.normalize(p);
  if (normalized === "/") return "/";
  return normalized.endsWith("/") ? normalized.replace(/\/+$/, "") : normalized;
}

/**
 * True when `candidate` equals `parent` or sits under `parent` as a descendant.
 * Path-segment aware: `/foo/barbaz` is NOT a descendant of `/foo/bar`.
 */
export function isSameOrDescendantPath(
  candidate: string,
  parent: string,
): boolean {
  if (!candidate || !parent) return false;
  const c = normalizePath(candidate);
  const p = normalizePath(parent);
  if (c === p) return true;
  const sep = p.endsWith("/") ? p : `${p}/`;
  return c.startsWith(sep);
}

/**
 * Decide whether a process cwd qualifies as "owned" by either the session
 * worktree or an explicitly configured app cwd. Pure string comparison —
 * the caller is responsible for realpath normalization when symlinks matter.
 */
export function isOwnedProcessCwd(
  candidate: string,
  worktreePath: string,
  allowedCwd?: string | null,
): boolean {
  if (isSameOrDescendantPath(candidate, worktreePath)) return true;
  if (allowedCwd && isSameOrDescendantPath(candidate, allowedCwd)) return true;
  return false;
}

// ============================================================
// Service factory
// ============================================================

async function resolveReal(
  deps: PortOwnershipDeps,
  p: string,
): Promise<string> {
  const real = await deps.realpath(p).catch(() => null);
  return real ? normalizePath(real) : normalizePath(p);
}

export function createPortOwnershipService(deps: PortOwnershipDeps) {
  async function classifyPort(
    input: PortOwnershipInput,
  ): Promise<PortOwnershipResult> {
    const { port, worktreePath } = input;
    const allowedCwd = input.allowedCwd ?? null;

    logger.info("dev-server.ownership.lookup", {
      port,
      worktreePath,
      allowedCwd,
    });

    let pids: number[];
    try {
      pids = await deps.listListeningPids(port);
    } catch (err) {
      const reason = `listener_lookup_failed: ${getErrorMessage(err)}`;
      logger.warn("dev-server.ownership.unknown", { port, reason });
      return { status: "unknown", reason };
    }

    if (pids.length === 0) {
      logger.info("dev-server.ownership.available", { port });
      return { status: "available" };
    }

    const worktreeReal = await resolveReal(deps, worktreePath);
    const allowedReal = allowedCwd ? await resolveReal(deps, allowedCwd) : null;

    let lastConflict: { pid: number; cwd: string } | null = null;
    let lastUnknown: { pid: number; reason: string } | null = null;

    for (const pid of pids) {
      const cwd = await deps.getProcessCwd(pid).catch(() => null);

      if (cwd === null) {
        lastUnknown = { pid, reason: "cwd_unresolved" };
        continue;
      }

      const cwdReal = await resolveReal(deps, cwd);
      const owned = isOwnedProcessCwd(
        cwdReal,
        worktreeReal,
        allowedReal ?? undefined,
      );

      if (owned) {
        logger.info("dev-server.ownership.owned", {
          port,
          pid,
          cwd,
          worktreePath,
        });
        return { status: "owned", pid, cwd };
      }

      lastConflict = { pid, cwd };
    }

    if (lastConflict) {
      logger.warn("dev-server.ownership.conflict", {
        port,
        pid: lastConflict.pid,
        cwd: lastConflict.cwd,
        worktreePath,
        allowedCwd,
      });
      return {
        status: "conflict",
        pid: lastConflict.pid,
        cwd: lastConflict.cwd,
      };
    }

    const unknown = lastUnknown!;
    logger.warn("dev-server.ownership.unknown", {
      port,
      pid: unknown.pid,
      reason: unknown.reason,
    });
    return { status: "unknown", reason: unknown.reason };
  }

  return { classifyPort };
}

// ============================================================
// Production dependency implementations
// ============================================================

/**
 * Production listener-only PID lookup.
 * Linux: prefer `ss -H -tlnp sport = :PORT`.
 * Fallback (Linux + macOS): `lsof -tiTCP:PORT -sTCP:LISTEN -n -P`.
 * Never uses `lsof -ti :PORT` (which also returns client connections).
 *
 * Throws when ALL inspection tools fail — that means we cannot prove the
 * port is unoccupied, so the caller must treat it as `unknown`.
 */
export async function defaultListListeningPids(
  port: number,
): Promise<number[]> {
  return listListeningPidsWithExec(port, execSync as ExecSyncLike);
}

function addPidsFromOutput(output: string, pids: Set<number>): void {
  for (const match of output.matchAll(/pid=(\d+)/g)) {
    const n = parseInt(match[1]!, 10);
    if (!isNaN(n) && n > 0) pids.add(n);
  }

  for (const line of output.split("\n")) {
    const n = parseInt(line.trim(), 10);
    if (!isNaN(n) && n > 0) pids.add(n);
  }
}

function getExitStatus(err: unknown): number | null {
  const status = (err as { status?: unknown }).status;
  return typeof status === "number" ? status : null;
}

export async function listListeningPidsWithExec(
  port: number,
  exec: ExecSyncLike,
): Promise<number[]> {
  const pids = new Set<number>();
  let ssOk = false;
  let lsofOk = false;

  try {
    const ssOut = exec(`ss -H -tlnp "sport = :${port}"`, {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    ssOk = true;
    addPidsFromOutput(ssOut, pids);
    if (pids.size > 0) return Array.from(pids);
  } catch {
    // ss missing on macOS or returned nothing — fall through to lsof.
  }

  try {
    const lsofOut = exec(`lsof -tiTCP:${port} -sTCP:LISTEN -n -P`, {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    lsofOk = true;
    addPidsFromOutput(lsofOut, pids);
  } catch (err) {
    // lsof exits non-zero when no listener matches — that's success, not failure.
    // Missing binary is usually status 127; no-match is status 1.
    if (getExitStatus(err) === 1) {
      lsofOk = true;
    } else if (!ssOk) {
      throw new Error("port listener lookup failed: ss and lsof both unusable");
    }
  }

  if (!ssOk && !lsofOk) {
    throw new Error(
      "port listener lookup failed: no inspection tool available",
    );
  }

  return Array.from(pids);
}

/** Production cwd resolver via /proc/<pid>/cwd (Linux). Falls back to lsof (macOS). */
export async function defaultGetProcessCwd(
  pid: number,
): Promise<string | null> {
  try {
    return await readlink(`/proc/${pid}/cwd`);
  } catch {
    // /proc not available (macOS) or permission denied — fall through to lsof.
  }

  try {
    const out = execSync(`lsof -a -p ${pid} -d cwd -Fn`, {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    for (const line of out.split("\n")) {
      if (line.startsWith("n")) return line.slice(1);
    }
  } catch {
    // Process gone or lsof unavailable.
  }

  return null;
}

/** Production realpath wrapper that returns null on failure (path doesn't exist). */
export async function defaultRealpath(p: string): Promise<string | null> {
  try {
    return await nodeRealpath(p);
  } catch {
    return null;
  }
}

export const defaultPortOwnershipDeps: PortOwnershipDeps = {
  listListeningPids: defaultListListeningPids,
  getProcessCwd: defaultGetProcessCwd,
  realpath: defaultRealpath,
};

export const defaultPortOwnershipService = createPortOwnershipService(
  defaultPortOwnershipDeps,
);
