import { spawn, execSync, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import net from "node:net";
import { buildChildEnv } from "./child-env";
import { createLogger } from "./logging";
import { broadcast as defaultBroadcast } from "./sse-broadcaster";
import * as defaultTailscale from "./tailscale";
import * as liveness from "./dev-server-liveness";
import { readConfig as defaultReadConfig } from "./config";
import { getLanUrl as defaultGetLanUrl } from "./network";
import {
  getGlobalSingleton,
  getGlobalValue,
  setGlobalValue,
} from "./global-singleton";
import { getErrorMessage } from "@/lib/errors";
import type { DevServerStatus, DevServerStatusEvent } from "@/types";

const logger = createLogger("dev-server");

const GLOBAL_KEY = "__cc_dev_servers" as const;
const STARTUP_TIMEOUT_MS = 60_000;
const OUTPUT_BUFFER_SIZE = 50;
const KILL_GRACE_MS = 5_000;
const TAILSCALE_POLL_INTERVAL_MS = 500;
const TAILSCALE_POLL_TIMEOUT_MS = 30_000;

/** In-memory state for a single dev server */
export interface DevServerEntry {
  serverName: string;
  projectPath: string;
  sessionName: string;
  command: string;
  status: DevServerStatus;
  port: number | null;
  remoteUrl: string | null;
  startedAt: string;
  errorMessage: string | null;
  recentOutput: string[];
  /** Internal: child process handle (not exposed via API) */
  _process: ChildProcess | null;
  /** Internal: PID of the process group leader (for group kills after shell exits) */
  _pid: number | null;
  /** Internal: startup timeout timer */
  _startupTimer: ReturnType<typeof setTimeout> | null;
}

// ============================================================
// Dependency Injection
// ============================================================

export interface DevServerRegistryDeps {
  broadcast: typeof defaultBroadcast;
  tailscale: {
    register: typeof defaultTailscale.register;
    unregister: typeof defaultTailscale.unregister;
  };
  readConfig: typeof defaultReadConfig;
  livenessStart: typeof liveness.start;
  getLanUrl: typeof defaultGetLanUrl;
  checkPortListening(port: number): Promise<boolean>;
}

export const defaultDevServerRegistryDeps: DevServerRegistryDeps = {
  broadcast: defaultBroadcast,
  tailscale: {
    register: defaultTailscale.register,
    unregister: defaultTailscale.unregister,
  },
  readConfig: defaultReadConfig,
  livenessStart: liveness.start,
  getLanUrl: defaultGetLanUrl,
  checkPortListening: isPortListening,
};

// ============================================================
// Factory
// ============================================================

export function createDevServerRegistry(
  deps: DevServerRegistryDeps = defaultDevServerRegistryDeps,
) {
  type RegistryMap = Map<string, DevServerEntry>;

  function getRegistry(): RegistryMap {
    return getGlobalSingleton(
      GLOBAL_KEY,
      () => new Map<string, DevServerEntry>(),
    );
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
    deps.broadcast(event);
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
    extra?: {
      errorMessage?: string;
      port?: number;
      remoteUrl?: string | null;
    },
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
   * Wait for a port to become occupied on localhost, then resolve a remote URL.
   * When Tailscale is enabled, registers with Tailscale Serve.
   * When Tailscale is disabled, uses the machine's LAN IP.
   */
  async function deferredRemoteUrlRegister(
    entry: DevServerEntry,
    port: number,
  ): Promise<void> {
    const config = await deps.readConfig();

    if (!config.tailscaleEnabled) {
      // LAN mode: set remote URL immediately using LAN IP
      if (entry.status === "running") {
        const remoteUrl = deps.getLanUrl(port);
        entry.remoteUrl = remoteUrl;
        broadcastStatus(entry);
        logger.info("dev-server.lan_url_set", {
          serverName: entry.serverName,
          port,
          remoteUrl,
        });
      }
      return;
    }

    // Tailscale mode: wait for port to accept connections before registering
    const deadline = Date.now() + TAILSCALE_POLL_TIMEOUT_MS;

    while (Date.now() < deadline) {
      // Abort if the server is no longer running (exited, stopped, errored)
      if (entry.status !== "running") return;

      if (await deps.checkPortListening(port)) {
        const remoteUrl = await deps.tailscale.register(port);
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
      const remoteUrl = await deps.tailscale.register(port);
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
  async function startServer(params: {
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
      detached: true,
      cwd: worktreePath,
      stdio: "pipe",
      env: buildChildEnv(),
    });

    const entry: DevServerEntry = {
      serverName,
      projectPath,
      sessionName,
      command,
      status: "starting",
      port: null,
      remoteUrl: null,
      startedAt: new Date().toISOString(),
      errorMessage: null,
      recentOutput: [],
      _process: child,
      _pid: child.pid ?? null,
      _startupTimer: null,
    };

    registry.set(key, entry);

    // Auto-start liveness poller when first server is registered
    deps.livenessStart();

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

          // Transition to running immediately so the UI knows the port.
          // Tailscale registration is deferred until the server is actually
          // listening — otherwise Tailscale's `serve --http=<port>` binds the
          // port on the Tailscale interface before the dev server can, causing
          // EADDRINUSE and interactive prompts that block forever.
          transitionTo(entry, "running", { port, remoteUrl: null });
          logger.info("dev-server.running", { serverName, port });

          // Deferred: wait for the server to bind the port, then resolve remote URL
          deferredRemoteUrlRegister(entry, port).catch((err) => {
            logger.warn("dev-server.remote_url_deferred_error", {
              serverName,
              port,
              error: getErrorMessage(err),
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
    child.on("exit", async (code, signal) => {
      cleanupTimer(entry);
      entry._process = null;

      logger.info("dev-server.exit", {
        serverName,
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
      } else if (entry.status === "running" && entry.port) {
        // Check if port is still alive — script may have exited but server
        // continues running (e.g., found existing server and reported its port)
        const alive = await isPortAlive(entry.port);
        if (!alive) {
          logger.warn("dev-server.unexpected_exit", {
            serverName,
            port: entry.port,
            code,
            signal,
          });
          if (entry.port) {
            deps
              .readConfig()
              .then((cfg) => {
                if (cfg.tailscaleEnabled) {
                  deps.tailscale.unregister(entry.port!).catch(() => {});
                }
              })
              .catch(() => {});
          }
          transitionTo(entry, "stopped");
        }
        // If alive, server is still running — liveness poller monitors from here
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

        // Kill the process group
        if (entry._pid) {
          try {
            process.kill(-entry._pid, "SIGTERM");
          } catch {
            // Process group may have already exited
          }
        }
      }
    }, STARTUP_TIMEOUT_MS);
  }

  /**
   * Stop a specific dev server.
   * Kills the process group first (shell + all children), then falls back
   * to port-based kill for any orphaned processes.
   */
  async function stopServer(params: {
    projectPath: string;
    sessionName: string;
    serverName: string;
  }): Promise<void> {
    const { projectPath, sessionName, serverName } = params;
    const registry = getRegistry();
    const key = makeKey(projectPath, sessionName, serverName);
    const entry = registry.get(key);

    if (!entry) return;
    if (entry.status !== "running" && entry.status !== "starting") return;

    cleanupTimer(entry);

    logger.info("dev-server.stop", {
      serverName,
      port: entry.port,
      pid: entry._pid,
    });

    // Unregister from Tailscale if enabled
    if (entry.port) {
      const config = await deps.readConfig();
      if (config.tailscaleEnabled) {
        await deps.tailscale.unregister(entry.port);
      }
    }

    // Kill the entire process group (shell + dev server + all children).
    // This is the primary kill mechanism — more reliable than killing
    // just the shell wrapper because detached:true gives us a dedicated
    // process group whose PGID matches the shell's PID.
    if (entry._pid) {
      await killProcessGroup(entry._pid);
    }
    entry._process = null;
    entry._pid = null;

    // Fallback: kill by port for any orphaned processes that escaped the
    // process group (e.g. processes that called setsid() themselves).
    if (entry.port) {
      await killByPort(entry.port);
    }

    transitionTo(entry, "stopped");
  }

  /** Stop all dev servers for a session in parallel. */
  async function stopAllForSession(params: {
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
  async function stopAll(): Promise<void> {
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
  function getSessionServers(params: {
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
  function getServer(params: {
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
  function _resetForTesting(): void {
    const registry = getGlobalValue<RegistryMap>(GLOBAL_KEY);
    if (registry) {
      // Kill all process groups
      for (const entry of registry.values()) {
        cleanupTimer(entry);
        if (entry._pid) {
          try {
            process.kill(-entry._pid, "SIGKILL");
          } catch {
            // ignore
          }
        }
      }
      registry.clear();
    }
  }

  return {
    startServer,
    stopServer,
    stopAllForSession,
    stopAll,
    getSessionServers,
    getServer,
    _resetForTesting,
  };
}

// ============================================================
// Shared Utilities (stateless, no DI needed)
// ============================================================

/**
 * Check if a port is actually in use (something is listening on localhost).
 * Attempts to bind to 127.0.0.1:port — EADDRINUSE means something is there.
 * Used by deferredTailscaleRegister to wait for the server to start listening.
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
 * Check if a port is alive by attempting a TCP connection.
 * More reliable than bind test for detecting running servers.
 * Used by liveness poller and exit handler.
 */
export function isPortAlive(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(2000);
    socket.on("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.on("timeout", () => {
      socket.destroy();
      resolve(false);
    });
    socket.on("error", () => {
      resolve(false);
    });
    socket.connect(port, "127.0.0.1");
  });
}

/**
 * Kill an entire process group by sending signals to -pid.
 * Sends SIGTERM first, waits up to KILL_GRACE_MS for graceful shutdown,
 * then sends SIGKILL to force-terminate any remaining processes.
 *
 * Requires the process to have been spawned with `detached: true` so it
 * has its own process group (PGID = pid).
 */
async function killProcessGroup(pid: number): Promise<void> {
  // Send SIGTERM to the entire process group
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    return; // Group doesn't exist or already exited
  }

  // Wait up to KILL_GRACE_MS for the group to exit
  const deadline = Date.now() + KILL_GRACE_MS;
  while (Date.now() < deadline) {
    try {
      process.kill(-pid, 0); // Check if any process in the group is still alive
    } catch {
      return; // Group has fully exited
    }
    await new Promise((r) => setTimeout(r, 500));
  }

  // Force-kill remaining processes in the group
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // Already exited
  }
}

/**
 * Kill all processes listening on a given port.
 * Sends SIGTERM first, waits up to 5s for graceful shutdown, then SIGKILL.
 */
async function killByPort(port: number): Promise<void> {
  let pidsRaw: string;
  try {
    pidsRaw = execSync(`lsof -ti :${port}`, { encoding: "utf-8" }).trim();
  } catch {
    return; // No processes found or lsof not available
  }

  if (!pidsRaw) return;

  const pids = pidsRaw
    .split("\n")
    .map((p) => parseInt(p.trim(), 10))
    .filter((p) => !isNaN(p) && p > 0);

  if (pids.length === 0) return;

  // Send SIGTERM to all PIDs
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // Process may have already exited
    }
  }

  // Wait up to 5 seconds for processes to exit
  const deadline = Date.now() + KILL_GRACE_MS;
  while (Date.now() < deadline) {
    const alive = pids.filter((pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    });
    if (alive.length === 0) return;
    await new Promise((r) => setTimeout(r, 500));
  }

  // SIGKILL remaining
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Process may have already exited
    }
  }
}

// ============================================================
// Default singleton exports (backward-compatible)
// ============================================================

const defaultRegistry = createDevServerRegistry();

export const startServer = defaultRegistry.startServer;
export const stopServer = defaultRegistry.stopServer;
export const stopAllForSession = defaultRegistry.stopAllForSession;
export const stopAll = defaultRegistry.stopAll;
export const getSessionServers = defaultRegistry.getSessionServers;
export const getServer = defaultRegistry.getServer;
export const _resetForTesting = defaultRegistry._resetForTesting;

// ============================================================
// SIGTERM Shutdown Handler
// ============================================================

const SHUTDOWN_KEY = "__cc_dev_server_shutdown_registered" as const;

function registerShutdownHandler(): void {
  if (getGlobalValue<boolean>(SHUTDOWN_KEY)) return;
  setGlobalValue(SHUTDOWN_KEY, true);

  process.on("SIGTERM", () => {
    logger.info("dev-server.shutdown", {
      message: "SIGTERM received, stopping all dev servers",
    });
    defaultRegistry.stopAll().catch(() => {});
  });
}

registerShutdownHandler();
