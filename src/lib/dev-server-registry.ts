import { spawn, type ChildProcess } from "node:child_process";
import { createLogger } from "./logging";
import { broadcast } from "./sse-broadcaster";
import * as tailscale from "./tailscale";
import * as liveness from "./dev-server-liveness";
import type { DevServerStatus, DevServerStatusEvent } from "@/types";

const logger = createLogger("dev-server");

const GLOBAL_KEY = "__cc_dev_servers" as const;
const STARTUP_TIMEOUT_MS = 60_000;
const OUTPUT_BUFFER_SIZE = 50;
const KILL_GRACE_MS = 5_000;

/** In-memory state for a single dev server */
export interface DevServerEntry {
  serverName: string;
  projectPath: string;
  sessionName: string;
  command: string;
  pid: number;
  status: DevServerStatus;
  port: number | null;
  remoteUrl: string | null;
  startedAt: string;
  errorMessage: string | null;
  recentOutput: string[];
  /** Internal: child process handle (not exposed via API) */
  _process: ChildProcess | null;
  /** Internal: startup timeout timer */
  _startupTimer: ReturnType<typeof setTimeout> | null;
}

type RegistryMap = Map<string, DevServerEntry>;

function getRegistry(): RegistryMap {
  const g = globalThis as unknown as Record<string, unknown>;
  if (!g[GLOBAL_KEY]) {
    g[GLOBAL_KEY] = new Map<string, DevServerEntry>();
  }
  return g[GLOBAL_KEY] as RegistryMap;
}

function makeKey(
  projectPath: string,
  sessionName: string,
  serverName: string,
): string {
  return `${projectPath}::${sessionName}::${serverName}`;
}

function broadcastStatus(entry: DevServerEntry): void {
  const event: DevServerStatusEvent = {
    type: "dev-server-status",
    projectName: entry.projectPath,
    sessionName: entry.sessionName,
    serverName: entry.serverName,
    status: entry.status,
    port: entry.port,
    remoteUrl: entry.remoteUrl,
    errorMessage: entry.errorMessage,
  };
  broadcast(event);
}

function appendOutput(entry: DevServerEntry, line: string): void {
  entry.recentOutput.push(line);
  if (entry.recentOutput.length > OUTPUT_BUFFER_SIZE) {
    entry.recentOutput.shift();
  }
}

function transitionTo(
  entry: DevServerEntry,
  status: DevServerStatus,
  extra?: { errorMessage?: string; port?: number; remoteUrl?: string | null },
): void {
  entry.status = status;
  if (extra?.errorMessage !== undefined)
    entry.errorMessage = extra.errorMessage;
  if (extra?.port !== undefined) entry.port = extra.port;
  if (extra?.remoteUrl !== undefined) entry.remoteUrl = extra.remoteUrl;
  broadcastStatus(entry);
}

function cleanupTimer(entry: DevServerEntry): void {
  if (entry._startupTimer) {
    clearTimeout(entry._startupTimer);
    entry._startupTimer = null;
  }
}

/**
 * Start a dev server for a session.
 * Spawns the command, monitors stdout for CC_PORT=<port>, and manages status transitions.
 */
export async function startServer(params: {
  projectPath: string;
  sessionName: string;
  serverName: string;
  command: string;
  worktreePath: string;
}): Promise<void> {
  const { projectPath, sessionName, serverName, command, worktreePath } =
    params;
  const registry = getRegistry();
  const key = makeKey(projectPath, sessionName, serverName);

  const existing = registry.get(key);
  if (
    existing &&
    (existing.status === "starting" || existing.status === "running")
  ) {
    throw new Error(`Server "${serverName}" is already ${existing.status}`);
  }

  const child = spawn(command, {
    shell: true,
    cwd: worktreePath,
    stdio: "pipe",
  });

  const entry: DevServerEntry = {
    serverName,
    projectPath,
    sessionName,
    command,
    pid: child.pid ?? 0,
    status: "starting",
    port: null,
    remoteUrl: null,
    startedAt: new Date().toISOString(),
    errorMessage: null,
    recentOutput: [],
    _process: child,
    _startupTimer: null,
  };

  registry.set(key, entry);

  // Auto-start liveness poller when first server is registered
  liveness.start();

  logger.info("dev-server.start", {
    serverName,
    command,
    worktreePath,
    pid: child.pid,
  });

  broadcastStatus(entry);

  // Line-buffer stdout for CC_PORT detection
  let stdoutBuffer = "";
  let portFound = false;

  child.stdout?.on("data", (chunk: Buffer) => {
    stdoutBuffer += chunk.toString();
    const lines = stdoutBuffer.split("\n");
    stdoutBuffer = lines.pop() ?? "";

    for (const line of lines) {
      appendOutput(entry, line);
      const match = /^CC_PORT=(\d+)$/.exec(line.trim());
      if (match && !portFound) {
        portFound = true;
        const port = parseInt(match[1]!, 10);
        cleanupTimer(entry);

        logger.info("dev-server.port_discovered", { serverName, port });

        // Register with Tailscale (async, non-blocking)
        tailscale.register(port).then((remoteUrl) => {
          transitionTo(entry, "running", {
            port,
            remoteUrl: remoteUrl ?? null,
          });
          logger.info("dev-server.running", { serverName, port, remoteUrl });
        });
      }
    }
  });

  child.stderr?.on("data", (chunk: Buffer) => {
    const lines = chunk.toString().split("\n");
    for (const line of lines) {
      if (line.trim()) appendOutput(entry, line);
    }
  });

  // Handle process exit
  child.on("exit", (code, signal) => {
    cleanupTimer(entry);
    entry._process = null;

    logger.info("dev-server.exit", {
      serverName,
      pid: entry.pid,
      code,
      signal,
    });

    if (entry.status === "starting") {
      // Exited before CC_PORT was detected
      const output = entry.recentOutput.slice(-10).join("\n");
      transitionTo(entry, "error", {
        errorMessage: `Process exited (code=${code}, signal=${signal}) before reporting CC_PORT.\n${output}`,
      });
      logger.error("dev-server.error", {
        serverName,
        error: entry.errorMessage,
        recentOutput: entry.recentOutput.slice(-10),
      });
    } else if (entry.status === "running") {
      // Unexpected exit while running — liveness poller may also detect this
      if (entry.port) {
        tailscale.unregister(entry.port).catch(() => {});
      }
      transitionTo(entry, "stopped");
    }
    // If status is already 'stopped' or 'error', we're in a controlled teardown
  });

  child.on("error", (err) => {
    cleanupTimer(entry);
    entry._process = null;

    logger.error("dev-server.error", {
      serverName,
      error: err.message,
    });

    transitionTo(entry, "error", {
      errorMessage: `Failed to spawn process: ${err.message}`,
    });
  });

  // Startup timeout
  entry._startupTimer = setTimeout(() => {
    if (entry.status === "starting") {
      logger.warn("dev-server.startup_timeout", {
        serverName,
        timeoutMs: STARTUP_TIMEOUT_MS,
      });

      const output = entry.recentOutput.slice(-10).join("\n");
      transitionTo(entry, "error", {
        errorMessage: `Startup timeout (${STARTUP_TIMEOUT_MS / 1000}s): CC_PORT not detected.\n${output}`,
      });

      // Kill the process
      if (entry._process) {
        entry._process.kill("SIGTERM");
      }
    }
  }, STARTUP_TIMEOUT_MS);
}

/**
 * Stop a specific dev server.
 * Removes Tailscale registration, sends SIGTERM with grace period, then SIGKILL.
 */
export async function stopServer(params: {
  projectPath: string;
  sessionName: string;
  serverName: string;
}): Promise<void> {
  const { projectPath, sessionName, serverName } = params;
  const registry = getRegistry();
  const key = makeKey(projectPath, sessionName, serverName);
  const entry = registry.get(key);

  if (!entry || !entry._process) {
    return;
  }

  cleanupTimer(entry);

  logger.info("dev-server.stop", {
    serverName,
    pid: entry.pid,
  });

  // Unregister from Tailscale first
  if (entry.port) {
    await tailscale.unregister(entry.port);
  }

  const child = entry._process;
  entry._process = null;

  await new Promise<void>((resolve) => {
    let resolved = false;

    const onExit = () => {
      if (!resolved) {
        resolved = true;
        resolve();
      }
    };

    child.once("exit", onExit);
    child.kill("SIGTERM");

    // Grace period: SIGKILL after 5s
    setTimeout(() => {
      if (!resolved) {
        try {
          child.kill("SIGKILL");
        } catch {
          // process may have already exited
        }
        onExit();
      }
    }, KILL_GRACE_MS);
  });

  transitionTo(entry, "stopped");
}

/** Stop all dev servers for a session in parallel. */
export async function stopAllForSession(params: {
  projectPath: string;
  sessionName: string;
}): Promise<void> {
  const servers = getSessionServers(params);
  const running = servers.filter(
    (s) => s.status === "running" || s.status === "starting",
  );
  await Promise.all(
    running.map((s) =>
      stopServer({
        projectPath: params.projectPath,
        sessionName: params.sessionName,
        serverName: s.serverName,
      }),
    ),
  );
}

/** Stop all dev servers across all sessions (CSM shutdown). */
export async function stopAll(): Promise<void> {
  const registry = getRegistry();
  const entries = Array.from(registry.values()).filter(
    (e) => e.status === "running" || e.status === "starting",
  );
  await Promise.all(
    entries.map((e) =>
      stopServer({
        projectPath: e.projectPath,
        sessionName: e.sessionName,
        serverName: e.serverName,
      }),
    ),
  );
}

/** Get runtime state for all dev servers in a session. */
export function getSessionServers(params: {
  projectPath: string;
  sessionName: string;
}): DevServerEntry[] {
  const registry = getRegistry();
  const prefix = `${params.projectPath}::${params.sessionName}::`;
  const results: DevServerEntry[] = [];
  for (const [key, entry] of registry) {
    if (key.startsWith(prefix)) {
      results.push(entry);
    }
  }
  return results;
}

/** Get runtime state for a specific dev server. */
export function getServer(params: {
  projectPath: string;
  sessionName: string;
  serverName: string;
}): DevServerEntry | undefined {
  const registry = getRegistry();
  const key = makeKey(
    params.projectPath,
    params.sessionName,
    params.serverName,
  );
  return registry.get(key);
}

/** Reset state for testing — do not use in production */
export function _resetForTesting(): void {
  const g = globalThis as unknown as Record<string, unknown>;
  const registry = g[GLOBAL_KEY] as RegistryMap | undefined;
  if (registry) {
    // Kill all processes
    for (const entry of registry.values()) {
      cleanupTimer(entry);
      if (entry._process) {
        try {
          entry._process.kill("SIGKILL");
        } catch {
          // ignore
        }
      }
    }
    registry.clear();
  }
}

// ============================================================
// SIGTERM Shutdown Handler
// ============================================================

const SHUTDOWN_KEY = "__cc_dev_server_shutdown_registered" as const;

function registerShutdownHandler(): void {
  const g = globalThis as unknown as Record<string, unknown>;
  if (g[SHUTDOWN_KEY]) return;
  g[SHUTDOWN_KEY] = true;

  process.on("SIGTERM", () => {
    logger.info("dev-server.shutdown", {
      message: "SIGTERM received, stopping all dev servers",
    });
    stopAll().catch(() => {});
  });
}

registerShutdownHandler();
