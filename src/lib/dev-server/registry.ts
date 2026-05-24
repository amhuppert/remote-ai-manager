import { execSync, type ChildProcess } from "node:child_process";
import { spawn as timedSpawn } from "../shared/exec";
import { readFileSync } from "node:fs";
import { createServer } from "node:net";
import net from "node:net";
import { buildChildEnv } from "../shared/child-env";
import { createLogger } from "../logging";
import type { BroadcastFn } from "../events/broadcaster";
import { publishSessionStatus } from "../workflows/primitives/default-session-status-bus";
import * as defaultTailscale from "../shared/tailscale";
import * as liveness from "./liveness";
import { readConfig as defaultReadConfig } from "../config/loader";
import { getLanUrl as defaultGetLanUrl } from "../shared/network";
import {
  getGlobalSingleton,
  getGlobalValue,
  setGlobalValue,
} from "../shared/global-singleton";
import { getErrorMessage } from "@/lib/shared/errors";
import {
  defaultPortOwnershipService,
  type PortOwnershipInput,
  type PortOwnershipResult,
} from "./port-ownership";
import type {
  DevServerSource,
  DevServerStatus,
  DevServerStatusEvent,
} from "@/lib/dev-server/schemas";
const logger = createLogger("dev-server");

const GLOBAL_KEY = "__cc_dev_servers" as const;
const STARTUP_TIMEOUT_MS = 60_000;
const OUTPUT_BUFFER_SIZE = 50;
const KILL_GRACE_MS = 5_000;
const TAILSCALE_POLL_INTERVAL_MS = 500;
const TAILSCALE_POLL_TIMEOUT_MS = 30_000;

/**
 * How the registry should start a dev server. The default `stdout-cc-port`
 * mode preserves the legacy preset script protocol (parse `CC_PORT=<n>` on
 * stdout, transition to running when the line is seen). `cc-assigned` mode
 * pre-allocates the port, injects it into the child via env vars, and waits
 * for a TCP readiness probe before transitioning to running.
 */
export type DevServerStartMode =
  | { type: "stdout-cc-port" }
  | {
      type: "cc-assigned";
      port: number;
      envAliases?: ReadonlyArray<string>;
      cwd?: string;
      readiness: { type: "tcp"; timeoutMs: number };
    };

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
  /** Worktree the server was spawned in; used to verify listener ownership on stop. */
  worktreePath: string;
  /**
   * Whether this entry represents a process CC spawned (`cc-started`) or an
   * externally started listener CC adopted (`external-adopted`). Null until the
   * post-CC_PORT classification completes.
   */
  source: DevServerSource | null;
  /**
   * True when the most recent ownership classification matched this session's
   * worktree (or configured app cwd). Cleanup safety gate — never kill unless
   * this is true at stop time.
   */
  ownedByThisSession: boolean;
  /**
   * Listener PID identified at classification time. Best-effort diagnostic;
   * may be null when ownership could not be determined.
   */
  ownerPid: number | null;
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
  broadcast: BroadcastFn;
  tailscale: {
    register: typeof defaultTailscale.register;
    unregister: typeof defaultTailscale.unregister;
  };
  readConfig: typeof defaultReadConfig;
  livenessStart: typeof liveness.start;
  getLanUrl: typeof defaultGetLanUrl;
  checkPortListening(port: number): Promise<boolean>;
  /**
   * Classify which process (if any) owns a TCP port relative to a session
   * worktree. Returned by the canonical port-ownership service — registry
   * stop logic must never reimplement listener/cwd discovery itself.
   */
  classifyPortOwnership(
    input: PortOwnershipInput,
  ): Promise<PortOwnershipResult>;
  /** Send a signal to a single PID. Returns false if the PID no longer exists. */
  sendSignal(pid: number, signal: NodeJS.Signals): boolean;
  /** True iff the PID currently exists (signal 0 probe). */
  isProcessAlive(pid: number): boolean;
  /** Grace period (ms) between SIGTERM and SIGKILL escalation. */
  killGraceMs: number;
  /**
   * Classify whether a verified listener PID belongs to the process group CC
   * spawned for this entry (cc-started) or some pre-existing process tree
   * (external-adopted). The default implementation compares the PID directly
   * and falls back to the listener's process-group id when they differ.
   */
  classifyServerSource(input: {
    listenerPid: number;
    spawnedPid: number | null;
  }): Promise<DevServerSource>;
}

const defaultRegistryBroadcast: BroadcastFn = (event) => {
  publishSessionStatus(event);
};

const defaultDevServerRegistryDeps: DevServerRegistryDeps = {
  broadcast: defaultRegistryBroadcast,
  tailscale: {
    register: defaultTailscale.register,
    unregister: defaultTailscale.unregister,
  },
  readConfig: defaultReadConfig,
  livenessStart: liveness.start,
  getLanUrl: defaultGetLanUrl,
  checkPortListening: isPortListening,
  classifyPortOwnership: defaultPortOwnershipService.classifyPort,
  sendSignal: defaultSendSignal,
  isProcessAlive: defaultIsProcessAlive,
  killGraceMs: KILL_GRACE_MS,
  classifyServerSource: defaultClassifyServerSource,
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
      source: entry.source,
      ownedByThisSession: entry.ownedByThisSession,
      worktreePath: entry.worktreePath,
      ownerPid: entry.ownerPid,
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
   * Classify the listener owning `port` and update the entry with source,
   * ownerPid, and ownedByThisSession. Runs after CC_PORT is detected. Best
   * effort — leaves the entry's defaults intact when ownership is unverified.
   */
  async function classifyEntrySource(
    entry: DevServerEntry,
    port: number,
  ): Promise<void> {
    const ownership = await deps.classifyPortOwnership({
      port,
      worktreePath: entry.worktreePath,
    });

    if (ownership.status !== "owned") {
      // Listener present but cwd unverified, or no listener at all. Leave
      // ownedByThisSession=false and source unset — the safety floor.
      logger.info("dev-server.source.unverified", {
        serverName: entry.serverName,
        port,
        ownership: ownership.status,
      });
      broadcastStatus(entry);
      return;
    }

    entry.ownerPid = ownership.pid;
    entry.ownedByThisSession = true;
    entry.source = await deps.classifyServerSource({
      listenerPid: ownership.pid,
      spawnedPid: entry._pid,
    });

    if (entry.source === "cc-started") {
      logger.info("dev-server.source.cc_started", {
        serverName: entry.serverName,
        port,
        ownerPid: entry.ownerPid,
        spawnedPid: entry._pid,
      });
    } else {
      logger.info("dev-server.source.external_adopted", {
        serverName: entry.serverName,
        port,
        ownerPid: entry.ownerPid,
        spawnedPid: entry._pid,
        cwd: ownership.cwd,
      });
    }

    broadcastStatus(entry);
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

  const READINESS_POLL_INTERVAL_MS = 250;

  /**
   * Poll for the assigned port to start listening, then transition to running.
   * On timeout, transitions to error. Used only by cc-assigned start mode —
   * stdout-cc-port mode relies on the CC_PORT line parser instead.
   */
  async function runCcAssignedReadinessProbe(params: {
    entry: DevServerEntry;
    port: number;
    timeoutMs: number;
  }): Promise<void> {
    const { entry, port, timeoutMs } = params;
    const deadline = Date.now() + timeoutMs;

    logger.info("dev-server.readiness.wait", {
      serverName: entry.serverName,
      port,
      timeoutMs,
    });

    while (Date.now() < deadline) {
      if (entry.status !== "starting") return;

      const listening = await deps.checkPortListening(port);
      if (listening) {
        if (entry.status !== "starting") return;
        cleanupTimer(entry);
        logger.info("dev-server.readiness.ready", {
          serverName: entry.serverName,
          port,
        });
        transitionTo(entry, "running", { port, remoteUrl: null });
        logger.info("dev-server.running", {
          serverName: entry.serverName,
          port,
        });

        classifyEntrySource(entry, port).catch((err) => {
          logger.warn("dev-server.source.classify_error", {
            serverName: entry.serverName,
            port,
            error: getErrorMessage(err),
          });
        });

        deferredRemoteUrlRegister(entry, port).catch((err) => {
          logger.warn("dev-server.remote_url_deferred_error", {
            serverName: entry.serverName,
            port,
            error: getErrorMessage(err),
          });
        });
        return;
      }

      await new Promise((r) => setTimeout(r, READINESS_POLL_INTERVAL_MS));
    }

    if (entry.status !== "starting") return;
    cleanupTimer(entry);
    logger.warn("dev-server.readiness.timeout", {
      serverName: entry.serverName,
      port,
      timeoutMs,
    });
    transitionTo(entry, "error", {
      errorMessage: `Readiness timeout (${Math.round(timeoutMs / 1000)}s): port ${port} never started listening.`,
    });
    if (entry._pid) {
      try {
        process.kill(-entry._pid, "SIGTERM");
      } catch {
        // already exited
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
    startMode?: DevServerStartMode;
  }): Promise<void> {
    const { projectPath, sessionName, serverName, command, worktreePath } =
      params;
    const startMode: DevServerStartMode = params.startMode ?? {
      type: "stdout-cc-port",
    };
    const registry = getRegistry();
    const key = makeKey(projectPath, sessionName, serverName);

    const existing = registry.get(key);
    if (
      existing &&
      (existing.status === "starting" || existing.status === "running")
    ) {
      throw new Error(`Server "${serverName}" is already ${existing.status}`);
    }

    const env = buildChildEnv();
    if (startMode.type === "cc-assigned") {
      const portStr = String(startMode.port);
      env.CC_ASSIGNED_PORT = portStr;
      env.PORT = portStr;
      for (const alias of startMode.envAliases ?? []) {
        env[alias] = portStr;
      }
    }

    const spawnCwd =
      startMode.type === "cc-assigned" && startMode.cwd
        ? startMode.cwd
        : worktreePath;

    const child = timedSpawn(command, [], {
      shell: true,
      detached: true,
      cwd: spawnCwd,
      stdio: "pipe",
      env,
      eventPrefix: "dev-server",
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
      worktreePath,
      source: null,
      ownedByThisSession: false,
      ownerPid: null,
      _process: child,
      _pid: child.pid ?? null,
      _startupTimer: null,
    };

    registry.set(key, entry);

    // Auto-start liveness poller when first server is registered
    deps.livenessStart();

    if (startMode.type === "cc-assigned") {
      logger.info("dev-server.start.cc_assigned_port", {
        serverName,
        command,
        worktreePath,
        cwd: spawnCwd,
        port: startMode.port,
        envAliases: startMode.envAliases ?? [],
        readinessType: startMode.readiness.type,
        readinessTimeoutMs: startMode.readiness.timeoutMs,
        pid: child.pid,
      });
    } else {
      logger.info("dev-server.start.stdout_protocol", {
        serverName,
        command,
        worktreePath,
        pid: child.pid,
      });
    }

    logger.info("dev-server.start", {
      serverName,
      command,
      worktreePath,
      pid: child.pid,
    });

    broadcastStatus(entry);

    // Line-buffer stdout for CC_PORT detection (only stdout-cc-port mode)
    let stdoutBuffer = "";
    let portFound = false;
    const detectsCcPort = startMode.type === "stdout-cc-port";

    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutBuffer += chunk.toString();
      const lines = stdoutBuffer.split("\n");
      stdoutBuffer = lines.pop() ?? "";

      for (const line of lines) {
        appendOutput(entry, line);

        if (!detectsCcPort) continue;

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

          classifyEntrySource(entry, port).catch((err) => {
            logger.warn("dev-server.source.classify_error", {
              serverName,
              port,
              error: getErrorMessage(err),
            });
          });

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

    if (startMode.type === "cc-assigned") {
      const assignedPort = startMode.port;
      const readinessTimeoutMs = startMode.readiness.timeoutMs;
      runCcAssignedReadinessProbe({
        entry,
        port: assignedPort,
        timeoutMs: readinessTimeoutMs,
      }).catch((err) => {
        logger.warn("dev-server.readiness.error", {
          serverName,
          port: assignedPort,
          error: getErrorMessage(err),
        });
      });
    }

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
        const output = entry.recentOutput.slice(-10).join("\n");
        const reason =
          startMode.type === "cc-assigned"
            ? `port ${startMode.port} ever listening`
            : "reporting CC_PORT";
        transitionTo(entry, "error", {
          errorMessage: `Process exited (code=${code}, signal=${signal}) before ${reason}.\n${output}`,
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
            // Wrap synchronously: deps may have been torn down by test teardown
            // by the time this exit handler fires for an orphaned child, so
            // calling readConfig() itself may throw rather than reject.
            Promise.resolve()
              .then(() => deps.readConfig())
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

    // Startup timeout — only for stdout-cc-port mode. cc-assigned mode owns
    // its own readiness timeout per config.
    if (startMode.type !== "stdout-cc-port") return;

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
      source: entry.source,
      ownedByThisSession: entry.ownedByThisSession,
    });

    if (entry.source === "external-adopted") {
      logger.info("dev-server.cleanup.stop_adopted", {
        serverName,
        port: entry.port,
        ownerPid: entry.ownerPid,
        worktreePath: entry.worktreePath,
      });
    }

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

    // Fallback: kill any LISTENING process on the port that escaped the
    // process group (e.g. processes that called setsid() themselves).
    // Only kill PIDs whose cwd verifies them as belonging to this session
    // worktree — never broad port kills that could hit browser clients.
    let stopWarning: string | null = null;
    if (entry.port) {
      const result = await killListeningProcessForPort({
        port: entry.port,
        worktreePath: entry.worktreePath,
      });
      if (result.skipped.length > 0) {
        const skippedDescriptions = result.skipped
          .map(
            (s) =>
              `pid=${s.pid} reason=${s.reason}${s.cwd ? ` cwd=${s.cwd}` : ""}`,
          )
          .join("; ");
        stopWarning = `Listener(s) on port ${entry.port} could not be verified as belonging to this session worktree (${entry.worktreePath}); refused to signal them. Skipped: ${skippedDescriptions}`;
      }
    }

    if (stopWarning) {
      entry.errorMessage = stopWarning;
      logger.warn("dev-server.cleanup.ownership_failed", {
        serverName,
        port: entry.port,
        worktreePath: entry.worktreePath,
        source: entry.source,
        warning: stopWarning,
      });
    }
    entry.ownedByThisSession = false;
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

  /**
   * Classify port ownership via the canonical service and kill the listener
   * only when it is verified as owned by this session worktree (or the
   * configured app cwd). Refuses to signal anything classified as `conflict`
   * or `unknown` — those become entries in `skipped`.
   *
   * Never kills by raw port lookup — that historically matched client
   * connections (browsers, curl, etc.) and could SIGTERM unrelated processes.
   */
  async function killListeningProcessForPort(params: {
    port: number;
    worktreePath: string;
    allowedCwd?: string;
  }): Promise<{
    killed: number[];
    skipped: Array<{ pid: number; reason: string; cwd?: string }>;
  }> {
    const { port, worktreePath, allowedCwd } = params;
    const killed: number[] = [];
    const skipped: Array<{ pid: number; reason: string; cwd?: string }> = [];

    logger.info("dev-server.stop.listener_lookup", { port, worktreePath });

    const ownership = await deps.classifyPortOwnership({
      port,
      worktreePath,
      allowedCwd: allowedCwd ?? null,
    });

    if (ownership.status === "available") {
      logger.info("dev-server.stop.listener_lookup", { port, found: 0 });
      return { killed, skipped };
    }

    if (ownership.status === "unknown") {
      logger.warn("dev-server.stop.unverified_owner", {
        port,
        worktreePath,
        reason: ownership.reason,
        ownership: "unknown",
      });
      skipped.push({
        pid: 0,
        reason: `ownership_unknown: ${ownership.reason}`,
      });
      logger.warn("dev-server.stop.kill_skipped", {
        port,
        worktreePath,
        skipped,
      });
      return { killed, skipped };
    }

    if (ownership.status === "conflict") {
      const skip: { pid: number; reason: string; cwd?: string } = {
        pid: ownership.pid,
        reason: "cwd_not_owned",
      };
      if (ownership.cwd !== null) skip.cwd = ownership.cwd;
      logger.warn("dev-server.stop.unverified_owner", {
        port,
        pid: ownership.pid,
        cwd: ownership.cwd,
        worktreePath,
        allowedCwd: allowedCwd ?? null,
        reason: "cwd_not_owned",
        ownership: "conflict",
      });
      skipped.push(skip);
      logger.warn("dev-server.stop.kill_skipped", {
        port,
        worktreePath,
        skipped,
      });
      return { killed, skipped };
    }

    const { pid, cwd } = ownership;
    logger.info("dev-server.stop.listener_verified", { port, pid, cwd });

    const sentTerm = deps.sendSignal(pid, "SIGTERM");
    logger.info("dev-server.stop.kill_signal", {
      port,
      pid,
      signal: "SIGTERM",
      delivered: sentTerm,
    });

    const deadline = Date.now() + deps.killGraceMs;
    while (Date.now() < deadline) {
      if (!deps.isProcessAlive(pid)) break;
      await new Promise((r) => setTimeout(r, 50));
    }

    if (deps.isProcessAlive(pid)) {
      const sentKill = deps.sendSignal(pid, "SIGKILL");
      logger.info("dev-server.stop.kill_signal", {
        port,
        pid,
        signal: "SIGKILL",
        delivered: sentKill,
      });
    }

    killed.push(pid);
    return { killed, skipped };
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
function isPortAlive(port: number): Promise<boolean> {
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

function defaultSendSignal(pid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(pid, signal);
    return true;
  } catch {
    return false;
  }
}

function defaultIsProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Best-effort read of /proc/<pid>/stat or `ps -o pgid=` to recover the listener's pgid. */
function readProcessGroupId(pid: number): number | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf-8");
    const idx = stat.lastIndexOf(")");
    if (idx >= 0) {
      const fields = stat.slice(idx + 2).split(" ");
      const pgid = parseInt(fields[2] ?? "", 10);
      if (!isNaN(pgid)) return pgid;
    }
  } catch {
    // /proc unavailable (macOS) or permission error — fall through to ps.
  }

  try {
    const out = execSync(`ps -o pgid= -p ${pid}`, {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const pgid = parseInt(out.trim(), 10);
    return isNaN(pgid) ? null : pgid;
  } catch {
    return null;
  }
}

async function defaultClassifyServerSource(input: {
  listenerPid: number;
  spawnedPid: number | null;
}): Promise<DevServerSource> {
  if (input.spawnedPid === null) return "external-adopted";
  if (input.listenerPid === input.spawnedPid) return "cc-started";
  const pgid = readProcessGroupId(input.listenerPid);
  return pgid === input.spawnedPid ? "cc-started" : "external-adopted";
}

// ============================================================
// Default singleton exports (backward-compatible)
// ============================================================

const defaultRegistry = createDevServerRegistry();

export const startServer = defaultRegistry.startServer;
export const stopServer = defaultRegistry.stopServer;
export const stopAllForSession = defaultRegistry.stopAllForSession;
export const getSessionServers = defaultRegistry.getSessionServers;
export const getServer = defaultRegistry.getServer;

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
