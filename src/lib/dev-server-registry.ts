import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
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
const TAILSCALE_POLL_INTERVAL_MS = 500;
const TAILSCALE_POLL_TIMEOUT_MS = 30_000;

/**
 * Build a sanitized copy of process.env for child dev servers.
 * CC itself is a Next.js server, so its process.env contains internal
 * `__NEXT_PRIVATE_*`, `NODE_CHANNEL_*`, and other vars that confuse or crash
 * a child Next.js (or other Node) process.
 */
function buildChildEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (
      key.startsWith("__NEXT_") ||
      key.startsWith("NODE_CHANNEL_") ||
      key.startsWith("__TURBOPACK_")
    ) {
      delete env[key];
    }
  }
  return env;
}

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
  /** Whether this server was adopted (discovered running externally, not spawned by CC) */
  adopted: boolean;
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
    adopted: entry.adopted,
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
 * Check if a port is actually in use (something is listening on localhost).
 * Attempts a TCP connection to 127.0.0.1:port.
 * Returns true if the port is occupied, false if available.
 */
function isPortListening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createServer();
    socket.once("error", (err: NodeJS.ErrnoException) => {
      socket.close();
      // EADDRINUSE means something is listening
      resolve(err.code === "EADDRINUSE");
    });
    socket.once("listening", () => {
      // We were able to bind → nobody is listening
      socket.close(() => resolve(false));
    });
    socket.listen(port, "127.0.0.1");
  });
}

/**
 * Wait for a port to become occupied on localhost, then register with Tailscale.
 * This prevents Tailscale from binding the port before the dev server can.
 */
async function deferredTailscaleRegister(
  entry: DevServerEntry,
  port: number,
): Promise<void> {
  const deadline = Date.now() + TAILSCALE_POLL_TIMEOUT_MS;

  while (Date.now() < deadline) {
    // Abort if the server is no longer running (exited, stopped, errored)
    if (entry.status !== "running") return;

    if (await isPortListening(port)) {
      const remoteUrl = await tailscale.register(port);
      // Entry may have changed status while we awaited
      if (entry.status === "running") {
        entry.remoteUrl = remoteUrl ?? null;
        broadcastStatus(entry);
        logger.info("dev-server.tailscale_registered", {
          serverName: entry.serverName,
          port,
          remoteUrl,
        });
      }
      return;
    }

    await new Promise((r) => setTimeout(r, TAILSCALE_POLL_INTERVAL_MS));
  }

  // Timeout — server never started listening. Register anyway so remote URL
  // works if the server starts later (liveness poller will catch actual death).
  if (entry.status === "running") {
    logger.warn("dev-server.tailscale_poll_timeout", {
      serverName: entry.serverName,
      port,
      timeoutMs: TAILSCALE_POLL_TIMEOUT_MS,
    });
    const remoteUrl = await tailscale.register(port);
    if (entry.status === "running") {
      entry.remoteUrl = remoteUrl ?? null;
      broadcastStatus(entry);
    }
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
    env: buildChildEnv(),
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
    adopted: false,
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

  // Line-buffer stdout for CC_PORT detection and adoption markers
  let stdoutBuffer = "";
  let portFound = false;
  let adoptedFlag = false;
  let adoptedPid: number | null = null;

  child.stdout?.on("data", (chunk: Buffer) => {
    stdoutBuffer += chunk.toString();
    const lines = stdoutBuffer.split("\n");
    stdoutBuffer = lines.pop() ?? "";

    for (const line of lines) {
      appendOutput(entry, line);

      // Parse adoption markers (emitted before CC_PORT)
      if (/^CC_ADOPTED=1$/.test(line.trim())) {
        adoptedFlag = true;
      }
      const adoptedPidMatch = /^CC_ADOPTED_PID=(\d+)$/.exec(line.trim());
      if (adoptedPidMatch) {
        adoptedPid = parseInt(adoptedPidMatch[1]!, 10);
      }

      const match = /^CC_PORT=(\d+)$/.exec(line.trim());
      if (match && !portFound) {
        portFound = true;
        const port = parseInt(match[1]!, 10);
        cleanupTimer(entry);

        // Apply adoption state
        if (adoptedFlag) {
          entry.adopted = true;
          if (adoptedPid && adoptedPid > 0) {
            entry.pid = adoptedPid;
          }
          logger.info("dev-server.adopted", {
            serverName,
            port,
            adoptedPid: entry.pid,
          });
        }

        logger.info("dev-server.port_discovered", { serverName, port });

        // Transition to running immediately so the UI knows the port.
        // Tailscale registration is deferred until the server is actually
        // listening — otherwise Tailscale's `serve --http=<port>` binds the
        // port on the Tailscale interface before the dev server can, causing
        // EADDRINUSE and interactive prompts that block forever.
        transitionTo(entry, "running", { port, remoteUrl: null });
        logger.info("dev-server.running", { serverName, port });

        // Deferred: wait for the server to bind the port, then register Tailscale
        deferredTailscaleRegister(entry, port).catch((err) => {
          logger.warn("dev-server.tailscale_deferred_error", {
            serverName,
            port,
            error: err instanceof Error ? err.message : String(err),
          });
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

    // Adopted server: the detection script exited, not the real server.
    // Liveness polling will monitor the real PID going forward.
    // Note: status may still be "starting" if tailscale.register() hasn't resolved yet.
    if (entry.adopted) {
      logger.info("dev-server.adopted_script_exit", {
        serverName,
        adoptedPid: entry.pid,
      });
      return;
    }

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
      logger.warn("dev-server.unexpected_exit", {
        serverName,
        pid: entry.pid,
        code,
        signal,
        recentOutput: entry.recentOutput.slice(-10),
      });
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

  if (!entry) return;

  // Adopted servers cannot be stopped — CC doesn't own the process
  if (entry.adopted) {
    logger.warn("dev-server.stop_adopted_noop", {
      serverName,
      pid: entry.pid,
    });
    return;
  }

  if (!entry._process) return;

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

/** Stop all dev servers across all sessions (CC shutdown). */
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
