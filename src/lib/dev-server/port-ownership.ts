import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readlink, realpath as nodeRealpath } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { createLogger } from "../logging";
import { getErrorMessage } from "@/lib/shared/errors";

const execFileAsync = promisify(execFile);

const logger = createLogger("dev-server");

// ============================================================
// Public types
// ============================================================

export type PortBindProbeResult =
  | { bindable: true }
  | { bindable: false; reason: string };

export interface PortOwnershipDeps {
  listListeningPids(port: number): Promise<number[]>;
  /**
   * Best-effort batched listener lookup. Returns a map keyed by port whose
   * value is the set of PIDs listening on that port. Used by callers that
   * need to classify many ports without paying the per-port subprocess cost
   * (e.g. scan-range adoption sweeps).
   */
  listAllListeningPorts(): Promise<Map<number, number[]>>;
  getProcessCwd(pid: number): Promise<string | null>;
  realpath(path: string): Promise<string | null>;
  /**
   * Attempt to bind a server socket on `port` on both IPv6 wildcard (`::`)
   * and IPv4 wildcard (`0.0.0.0`). Returns `{ bindable: true }` only when
   * BOTH binds succeed (the sockets are immediately closed). This is the only
   * reliable signal that the port is truly free — `lsof`/`ss` miss root-owned
   * listeners (e.g. tailscaled when `tailscale serve --http=PORT` is active)
   * and specific-address binds that still trip wildcard-bind attempts with
   * EADDRINUSE.
   */
  probePortBindable(port: number): Promise<PortBindProbeResult>;
}

export interface PortOwnershipInput {
  port: number;
  worktreePath: string;
  allowedCwd?: string | null;
}

export type PortOwnershipResult =
  | { status: "available" }
  | { status: "owned"; pid: number; cwd: string }
  | {
      status: "conflict";
      pid: number | null;
      cwd: string | null;
      reason?: string;
    }
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

export interface ScanRangeInput {
  basePort: number;
  rangeSize: number;
  worktreePath: string;
  allowedCwd?: string | null;
}

export type ScanRangeMatch =
  | { status: "owned"; port: number; pid: number; cwd: string }
  | { status: "none" };

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
      // Listener lookup found no owning PIDs — but unprivileged `lsof` on macOS
      // can't see root-owned sockets (notably tailscaled when `tailscale serve`
      // is active), and specific-address binds still cause our subsequent
      // wildcard bind to fail. Confirm bindability before declaring available.
      const probe = await deps.probePortBindable(port);
      if (probe.bindable) {
        logger.info("dev-server.ownership.available", { port });
        return { status: "available" };
      }
      logger.warn("dev-server.ownership.hidden_conflict", {
        port,
        reason: probe.reason,
      });
      return {
        status: "conflict",
        pid: null,
        cwd: null,
        reason: probe.reason,
      };
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

    if (lastUnknown) {
      logger.warn("dev-server.ownership.unknown", {
        port,
        pid: lastUnknown.pid,
        reason: lastUnknown.reason,
      });
      return { status: "unknown", reason: lastUnknown.reason };
    }

    // Every listener PID either matched the worktree (returned above), failed
    // cwd resolution, or resolved elsewhere, and the PID list was non-empty —
    // so reaching here means the listener list changed shape underneath us.
    logger.warn("dev-server.ownership.unknown", {
      port,
      reason: "no_listener_classified",
    });
    return { status: "unknown", reason: "no_listener_classified" };
  }

  /**
   * Find the first listener in [basePort, basePort + rangeSize) whose process
   * cwd belongs to this session's worktree (or the configured app cwd).
   *
   * Performs a single batched listener lookup instead of probing every port,
   * then runs cwd resolution only on the (typically zero or one) listeners
   * that fall inside the scan range. This keeps the dev-server reconciliation
   * path fast even when adoption never matches.
   */
  async function findOwnedListenerInRange(
    input: ScanRangeInput,
  ): Promise<ScanRangeMatch> {
    const { basePort, rangeSize, worktreePath } = input;
    const allowedCwd = input.allowedCwd ?? null;

    logger.info("dev-server.ownership.scan_range", {
      basePort,
      rangeSize,
      worktreePath,
      allowedCwd,
    });

    let listeners: Map<number, number[]>;
    try {
      listeners = await deps.listAllListeningPorts();
    } catch (err) {
      logger.warn("dev-server.ownership.scan_range_failed", {
        basePort,
        rangeSize,
        worktreePath,
        reason: getErrorMessage(err),
      });
      return { status: "none" };
    }

    const worktreeReal = await resolveReal(deps, worktreePath);
    const allowedReal = allowedCwd ? await resolveReal(deps, allowedCwd) : null;

    for (let offset = 0; offset < rangeSize; offset++) {
      const port = basePort + offset;
      const pids = listeners.get(port);
      if (!pids || pids.length === 0) continue;

      for (const pid of pids) {
        const cwd = await deps.getProcessCwd(pid).catch(() => null);
        if (cwd === null) continue;

        const cwdReal = await resolveReal(deps, cwd);
        const owned = isOwnedProcessCwd(
          cwdReal,
          worktreeReal,
          allowedReal ?? undefined,
        );

        if (owned) {
          logger.info("dev-server.ownership.scan_range_owned", {
            port,
            pid,
            cwd,
            worktreePath,
          });
          return { status: "owned", port, pid, cwd };
        }
      }
    }

    return { status: "none" };
  }

  return { classifyPort, findOwnedListenerInRange };
}

// ============================================================
// Production dependency implementations
// ============================================================

export type ExecFileLike = (
  cmd: string,
  args: readonly string[],
) => Promise<{ stdout: string; stderr: string }>;

/**
 * Async listener-only PID lookup with an injectable exec function. The
 * production path calls this with `execFileAsync`; tests inject a fake.
 *
 * Linux: prefer `ss -H -tlnp sport = :PORT`.
 * Fallback (Linux + macOS): `lsof -tiTCP:PORT -sTCP:LISTEN -n -P`.
 * Never uses `lsof -ti :PORT` (which also returns client connections).
 *
 * Throws when ALL inspection tools fail — the caller must treat that as
 * `unknown`. A `lsof` exit code of 1 means "no match" (port is free) and
 * resolves to an empty array.
 */
export async function listListeningPidsViaExecFile(
  port: number,
  execFile: ExecFileLike,
): Promise<number[]> {
  const pids = new Set<number>();
  let ssOk = false;
  let lsofOk = false;

  try {
    const { stdout } = await execFile("ss", [
      "-H",
      "-tlnp",
      `sport = :${port}`,
    ]);
    ssOk = true;
    addPidsFromOutput(stdout, pids);
    if (pids.size > 0) return Array.from(pids);
  } catch {
    // ss missing on macOS or returned nothing — fall through to lsof.
  }

  try {
    const { stdout } = await execFile("lsof", [
      "-tiTCP:" + port,
      "-sTCP:LISTEN",
      "-n",
      "-P",
    ]);
    lsofOk = true;
    addPidsFromOutput(stdout, pids);
  } catch (err) {
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

const productionExecFile: ExecFileLike = (cmd, args) =>
  execFileAsync(cmd, args as string[], { encoding: "utf-8" }) as Promise<{
    stdout: string;
    stderr: string;
  }>;

async function defaultListListeningPids(port: number): Promise<number[]> {
  return listListeningPidsViaExecFile(port, productionExecFile);
}

/**
 * Production batched lookup: one `ss -H -tlnp` call returns every TCP
 * listener system-wide. Parses the (port → PIDs) map and returns it.
 *
 * Falls back to `lsof -iTCP -sTCP:LISTEN -n -P -F` when `ss` is unavailable
 * (notably macOS). Returns an empty map when both tools fail — callers should
 * treat that as "no adoption candidates found" rather than an error, because
 * adoption is best-effort.
 */
async function defaultListAllListeningPorts(): Promise<Map<number, number[]>> {
  try {
    const { stdout } = await execFileAsync("ss", ["-H", "-tlnp"], {
      encoding: "utf-8",
      maxBuffer: 4 * 1024 * 1024,
    });
    return parseSsListenerOutput(stdout);
  } catch {
    // Fall through to lsof.
  }

  try {
    const { stdout } = await execFileAsync(
      "lsof",
      ["-iTCP", "-sTCP:LISTEN", "-n", "-P", "-F", "pPn"],
      { encoding: "utf-8", maxBuffer: 4 * 1024 * 1024 },
    );
    return parseLsofListenerOutput(stdout);
  } catch {
    return new Map();
  }
}

/**
 * Parse `ss -H -tlnp` output into a (port → pids) map. Tolerates the multiple
 * shapes `ss` emits depending on locale/permissions — only PID and the local
 * port (last `:NNN` in column 4) are extracted.
 */
export function parseSsListenerOutput(output: string): Map<number, number[]> {
  const result = new Map<number, number[]>();
  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const cols = trimmed.split(/\s+/);
    const localAddr = cols[3];
    if (!localAddr) continue;
    const colonIdx = localAddr.lastIndexOf(":");
    if (colonIdx === -1) continue;
    const port = parseInt(localAddr.slice(colonIdx + 1), 10);
    if (!Number.isFinite(port) || port <= 0) continue;

    const pids: number[] = [];
    for (const match of trimmed.matchAll(/pid=(\d+)/g)) {
      const n = parseInt(match[1]!, 10);
      if (Number.isFinite(n) && n > 0) pids.push(n);
    }
    if (pids.length === 0) continue;

    const existing = result.get(port);
    if (existing) {
      for (const pid of pids) {
        if (!existing.includes(pid)) existing.push(pid);
      }
    } else {
      result.set(port, pids);
    }
  }
  return result;
}

/**
 * Parse `lsof -F pPn` listener output into a (port → pids) map. lsof prints
 * one field per line tagged with a single-letter prefix; `p<pid>` opens a
 * process group, and `n<addr>` lines inside that group describe sockets.
 */
export function parseLsofListenerOutput(output: string): Map<number, number[]> {
  const result = new Map<number, number[]>();
  let currentPid: number | null = null;
  for (const line of output.split("\n")) {
    if (!line) continue;
    if (line.startsWith("p")) {
      const n = parseInt(line.slice(1), 10);
      currentPid = Number.isFinite(n) && n > 0 ? n : null;
      continue;
    }
    if (line.startsWith("n") && currentPid !== null) {
      const addr = line.slice(1);
      const colonIdx = addr.lastIndexOf(":");
      if (colonIdx === -1) continue;
      const port = parseInt(addr.slice(colonIdx + 1), 10);
      if (!Number.isFinite(port) || port <= 0) continue;
      const existing = result.get(port);
      if (existing) {
        if (!existing.includes(currentPid)) existing.push(currentPid);
      } else {
        result.set(port, [currentPid]);
      }
    }
  }
  return result;
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

/**
 * Extract a numeric exit code from an exec error. Handles both shapes:
 * `execSync` errors carry the exit code on `.status`; promisified `execFile`
 * errors carry it on `.code` (Node also puts string system errors like
 * `'ENOENT'` on `.code`, so we only honour numeric values).
 */
export function getExitStatus(err: unknown): number | null {
  const e = err as { status?: unknown; code?: unknown };
  if (typeof e.status === "number") return e.status;
  if (typeof e.code === "number") return e.code;
  return null;
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
async function defaultGetProcessCwd(pid: number): Promise<string | null> {
  try {
    return await readlink(`/proc/${pid}/cwd`);
  } catch {
    // /proc not available (macOS) or permission denied — fall through to lsof.
  }

  try {
    const { stdout } = await execFileAsync(
      "lsof",
      ["-a", "-p", String(pid), "-d", "cwd", "-Fn"],
      { encoding: "utf-8" },
    );
    for (const line of stdout.split("\n")) {
      if (line.startsWith("n")) return line.slice(1);
    }
  } catch {
    // Process gone or lsof unavailable.
  }

  return null;
}

/** Production realpath wrapper that returns null on failure (path doesn't exist). */
async function defaultRealpath(p: string): Promise<string | null> {
  try {
    return await nodeRealpath(p);
  } catch {
    return null;
  }
}

/**
 * Production bind-probe. Attempts a wildcard bind on both `::` (IPv6-only)
 * and `0.0.0.0`. We bind IPv6 with `ipv6Only` so the IPv6 attempt doesn't
 * claim the IPv4 port via dual-stack and falsely free it for the IPv4 probe.
 * If either bind fails (typically EADDRINUSE), the port is not truly free.
 */
export async function probePortBindableViaNet(
  port: number,
): Promise<PortBindProbeResult> {
  const tryBind = (
    host: string,
    ipv6Only: boolean,
  ): Promise<PortBindProbeResult> =>
    new Promise((resolve) => {
      const server = net.createServer();
      server.unref();
      const cleanup = () => {
        server.removeAllListeners();
        try {
          server.close();
        } catch {
          // already closed
        }
      };
      server.once("error", (err: NodeJS.ErrnoException) => {
        cleanup();
        const code = err.code ?? "EUNKNOWN";
        resolve({ bindable: false, reason: `${code} on ${host}` });
      });
      server.once("listening", () => {
        cleanup();
        resolve({ bindable: true });
      });
      try {
        server.listen({ host, port, exclusive: true, ipv6Only });
      } catch (err) {
        cleanup();
        resolve({
          bindable: false,
          reason: `listen threw on ${host}: ${getErrorMessage(err)}`,
        });
      }
    });

  const ipv6 = await tryBind("::", true);
  if (!ipv6.bindable) return ipv6;
  const ipv4 = await tryBind("0.0.0.0", false);
  return ipv4;
}

const defaultPortOwnershipDeps: PortOwnershipDeps = {
  listListeningPids: defaultListListeningPids,
  listAllListeningPorts: defaultListAllListeningPorts,
  getProcessCwd: defaultGetProcessCwd,
  realpath: defaultRealpath,
  probePortBindable: probePortBindableViaNet,
};

export const defaultPortOwnershipService = createPortOwnershipService(
  defaultPortOwnershipDeps,
);
