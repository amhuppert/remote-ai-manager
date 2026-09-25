import { type ChildProcess } from "node:child_process";
import { spawn as timedSpawn } from "../shared/exec";
import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import net from "node:net";
import path from "node:path";
import { buildChildEnv } from "../shared/child-env";
import {
  neutralizeAmbientCcEnv,
  type SessionEnv,
} from "@/lib/agent-gateway/session-env";
import {
  captureTraceContext,
  createLogger,
  runAsTrace,
  timed,
  type Logger,
} from "../logging";
import { publishEvent, type PublishFn } from "../events/publication";
import * as defaultTailscale from "../shared/tailscale";
import * as liveness from "./liveness";
import { readConfig as defaultReadConfig } from "../config/loader";
import { getLanUrl as defaultGetLanUrl } from "../shared/network";
import { getProjectDisplayName } from "../projects/resolver";
import { isProjectSentinel } from "@/lib/conversations/project-conversation-scope";
import {
  getGlobalSingleton,
  getGlobalValue,
  setGlobalValue,
} from "../shared/global-singleton";
import { getErrorMessage } from "@/lib/shared/errors";
import { sleep } from "@/lib/shared/sleep";
import { createKeyedMutex } from "@/lib/shared/keyed-mutex";
import {
  defaultPortOwnershipService,
  type PortOwnershipInput,
  type PortOwnershipResult,
} from "./port-ownership";
import type {
  DevServerStatus,
  DevServerStatusEvent,
} from "@/lib/dev-server/schemas";
const logger = createLogger("dev-server");

const GLOBAL_KEY = "__cc_dev_servers" as const;
const OUTPUT_BUFFER_SIZE = 50;
const KILL_GRACE_MS = 5_000;
const TAILSCALE_POLL_INTERVAL_MS = 500;
const TAILSCALE_POLL_TIMEOUT_MS = 30_000;
const PROCESS_GROUP_POLL_INTERVAL_MS = 50;
const LOG_SUBDIR = ".cc/dev-server-logs";

/**
 * Parameters CC uses to spawn a dev server. CC pre-allocates the port,
 * injects it into the child via `CC_ASSIGNED_PORT` / `PORT` (plus any caller-
 * supplied aliases), and waits for a TCP readiness probe before transitioning
 * to `running`.
 */
export interface DevServerStartMode {
  port: number;
  envAliases?: ReadonlyArray<string>;
  cwd?: string;
  readinessTimeoutMs: number;
}

/**
 * Build the child env for a dev-server spawn. A dev server is an
 * identity-creating boundary — it boots as its own CC instance and records its
 * OWN server URL — so the parent server's ambient CC_* (server URL, API token,
 * workflow ids) is blanked first: `resolveServerBaseUrl` treats an inherited
 * `CC_SERVER_URL` as authoritative, so leaking it makes the instance
 * mis-identify as the parent and its startup self-probe mismatch. The assigned
 * port is written AFTER neutralization because `CC_ASSIGNED_PORT` is itself
 * CC_-prefixed and would otherwise be blanked. Pure over its inputs (copies
 * `baseEnv`) so it is unit-testable without spawning.
 */
export function buildDevServerEnv(
  baseEnv: SessionEnv,
  startMode: Pick<DevServerStartMode, "port" | "envAliases">,
): NodeJS.ProcessEnv {
  const env = neutralizeAmbientCcEnv({ ...baseEnv });
  const portStr = String(startMode.port);
  env.CC_ASSIGNED_PORT = portStr;
  env.PORT = portStr;
  for (const alias of startMode.envAliases ?? []) {
    env[alias] = portStr;
  }
  // Structurally a valid process env; the cast only satisfies Next's
  // readonly-NODE_ENV augmentation of ProcessEnv (SessionEnv omits it).
  return env as NodeJS.ProcessEnv;
}

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
  /**
   * Absolute path of the on-disk log file capturing this spawn's stdout/stderr.
   * Truncated on every start. Lines are prefixed with `[OUT] ` / `[ERR] `.
   */
  logFilePath: string;
  /** Internal: child process handle (not exposed via API) */
  _process: ChildProcess | null;
  /** Internal: PID of the process group leader (for group kills after shell exits) */
  _pid: number | null;
  /** Internal: write stream for the log file. Closed on process exit/error. */
  _logStream: WriteStream | null;
  /** Internal: leftover partial line from the last stdout chunk. */
  _stdoutRemainder: string;
  /** Internal: leftover partial line from the last stderr chunk. */
  _stderrRemainder: string;
}

function broadcastEntryStatus(
  entry: DevServerEntry,
  broadcast: PublishFn,
): void {
  // Client query keys are addressed by project NAME while the registry keys
  // entries by path. The resolver builds the path as join(baseDir, name), so
  // the trailing segment is the name the SSE reaction must invalidate with.
  // Project-root entries are keyed by the internal project sentinel, which
  // stays off the wire: they publish the project scope with no session name.
  const event: DevServerStatusEvent = {
    type: "dev-server-status",
    ...(isProjectSentinel(entry.sessionName)
      ? { scope: "project" as const }
      : { scope: "session" as const, sessionName: entry.sessionName }),
    projectName: getProjectDisplayName(entry.projectPath),
    serverName: entry.serverName,
    status: entry.status,
    port: entry.port,
    remoteUrl: entry.remoteUrl,
    errorMessage: entry.errorMessage,
    ownedByThisSession: entry.ownedByThisSession,
    worktreePath: entry.worktreePath,
    ownerPid: entry.ownerPid,
    logFilePath: entry.logFilePath,
  };
  broadcast(event);
}

export interface DevServerTransitionExtra {
  errorMessage?: string | null;
  port?: number;
  remoteUrl?: string | null;
}

/**
 * Single transition owner for a dev-server entry's status. Every status
 * change — registry lifecycle, liveness poller, reconciliation — routes
 * through here so the entry mutation and the status broadcast can never
 * diverge.
 */
export function transitionEntryTo(
  entry: DevServerEntry,
  status: DevServerStatus,
  broadcast: PublishFn,
  extra?: DevServerTransitionExtra,
): void {
  const previousStatus = entry.status;
  entry.status = status;
  if (extra?.errorMessage !== undefined)
    entry.errorMessage = extra.errorMessage;
  if (extra?.port !== undefined) entry.port = extra.port;
  if (extra?.remoteUrl !== undefined) entry.remoteUrl = extra.remoteUrl;
  logger.debug("dev-server.status_transition", {
    serverName: entry.serverName,
    sessionName: entry.sessionName,
    from: previousStatus,
    to: status,
  });
  broadcastEntryStatus(entry, broadcast);
}

// ============================================================
// Dependency Injection
// ============================================================

export interface DevServerRegistryDeps {
  /**
   * Logger for registry events and `timed()` spans. Defaults to the module
   * logger; injected in tests to read the emitted structured fields.
   */
  logger?: Logger;
  broadcast: PublishFn;
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
}

const defaultRegistryBroadcast: PublishFn = publishEvent;

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
};

// ============================================================
// Factory
// ============================================================

export function createDevServerRegistry(
  deps: DevServerRegistryDeps = defaultDevServerRegistryDeps,
) {
  const log = deps.logger ?? logger;
  const lifecycleMutex = getGlobalSingleton(
    "__cc_dev_server_lifecycle_mutex",
    createKeyedMutex,
  );

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
    worktreePath: string,
    serverName: string,
  ): string {
    return `${projectPath}::${sessionName}::${worktreePath}::${serverName}`;
  }

  function broadcastStatus(entry: DevServerEntry): void {
    broadcastEntryStatus(entry, deps.broadcast);
  }

  function writeChunkToLog(
    entry: DevServerEntry,
    stream: "stdout" | "stderr",
    chunk: Buffer,
  ): void {
    if (!entry._logStream) return;
    const prefix = stream === "stdout" ? "[OUT]" : "[ERR]";
    const remainderKey =
      stream === "stdout" ? "_stdoutRemainder" : "_stderrRemainder";
    const text = entry[remainderKey] + chunk.toString();
    const lines = text.split("\n");
    entry[remainderKey] = lines.pop() ?? "";
    for (const line of lines) {
      entry._logStream.write(`${prefix} ${line}\n`);
    }
  }

  function flushLogRemainders(entry: DevServerEntry): void {
    if (!entry._logStream) return;
    if (entry._stdoutRemainder.length > 0) {
      entry._logStream.write(`[OUT] ${entry._stdoutRemainder}\n`);
      entry._stdoutRemainder = "";
    }
    if (entry._stderrRemainder.length > 0) {
      entry._logStream.write(`[ERR] ${entry._stderrRemainder}\n`);
      entry._stderrRemainder = "";
    }
  }

  function closeLogStream(entry: DevServerEntry): void {
    if (!entry._logStream) return;
    flushLogRemainders(entry);
    entry._logStream.end();
    entry._logStream = null;
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
    extra?: DevServerTransitionExtra,
  ): void {
    transitionEntryTo(entry, status, deps.broadcast, extra);
  }

  /**
   * Classify the listener owning `port` and update the entry with source,
   * ownerPid, and ownedByThisSession. Runs after the assigned port is
   * listening. Best
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
      log.info("dev-server.source.unverified", {
        serverName: entry.serverName,
        port,
        ownership: ownership.status,
      });
      broadcastStatus(entry);
      return;
    }

    entry.ownerPid = ownership.pid;
    entry.ownedByThisSession = true;

    log.info("dev-server.source.cc_started", {
      serverName: entry.serverName,
      port,
      ownerPid: entry.ownerPid,
      spawnedPid: entry._pid,
    });

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
        log.info("dev-server.lan_url_set", {
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
          log.info("dev-server.tailscale_registered", {
            serverName: entry.serverName,
            port,
            remoteUrl,
          });
        }
        return;
      }

      await sleep(TAILSCALE_POLL_INTERVAL_MS);
    }

    // Timeout — server never started listening. Register anyway so remote URL
    // works if the server starts later (liveness poller will catch actual death).
    if (entry.status === "running") {
      log.warn("dev-server.tailscale_poll_timeout", {
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
   * On timeout, transitions to error.
   */
  async function runCcAssignedReadinessProbe(params: {
    entry: DevServerEntry;
    port: number;
    timeoutMs: number;
  }): Promise<void> {
    const { entry, port, timeoutMs } = params;
    const deadline = Date.now() + timeoutMs;

    log.info("dev-server.readiness.wait", {
      serverName: entry.serverName,
      port,
      timeoutMs,
    });

    while (Date.now() < deadline) {
      if (entry.status !== "starting") return;

      const listening = await deps.checkPortListening(port);
      if (listening) {
        if (entry.status !== "starting") return;
        log.info("dev-server.readiness.ready", {
          serverName: entry.serverName,
          port,
        });
        transitionTo(entry, "running", { port, remoteUrl: null });
        log.info("dev-server.running", {
          serverName: entry.serverName,
          port,
        });

        classifyEntrySource(entry, port).catch((err) => {
          log.warn("dev-server.source.classify_error", {
            serverName: entry.serverName,
            port,
            error: getErrorMessage(err),
          });
        });

        deferredRemoteUrlRegister(entry, port).catch((err) => {
          log.warn("dev-server.remote_url_deferred_error", {
            serverName: entry.serverName,
            port,
            error: getErrorMessage(err),
          });
        });
        return;
      }

      await sleep(READINESS_POLL_INTERVAL_MS);
    }

    if (entry.status !== "starting") return;
    log.warn("dev-server.readiness.timeout", {
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

  function lifecycleKey(params: {
    projectPath: string;
    sessionName: string;
    worktreePath: string;
    serverName: string;
  }): string {
    return makeKey(
      params.projectPath,
      params.sessionName,
      path.resolve(params.worktreePath),
      params.serverName,
    );
  }

  async function startServer(
    params: Parameters<typeof startServerUnlocked>[0],
  ): Promise<void> {
    return lifecycleMutex.run(lifecycleKey(params), () =>
      startServerUnlocked(params),
    );
  }

  /**
   * Start a dev server for a session. Spawns the command with the assigned
   * port injected via `CC_ASSIGNED_PORT`/`PORT`/aliases, polls for TCP
   * readiness, and manages status transitions.
   */
  async function startServerUnlocked(params: {
    projectPath: string;
    sessionName: string;
    serverName: string;
    command: string;
    worktreePath: string;
    startMode: DevServerStartMode;
  }): Promise<void> {
    const {
      projectPath,
      sessionName,
      serverName,
      command,
      worktreePath,
      startMode,
    } = params;
    const registry = getRegistry();
    const key = makeKey(projectPath, sessionName, worktreePath, serverName);

    const existing = registry.get(key);
    if (
      existing &&
      (existing.status === "starting" || existing.status === "running")
    ) {
      throw new Error(`Server "${serverName}" is already ${existing.status}`);
    }

    const env = buildDevServerEnv(buildChildEnv(), startMode);

    const spawnCwd = startMode.cwd ?? worktreePath;

    const child = timedSpawn(command, [], {
      shell: true,
      detached: true,
      cwd: spawnCwd,
      stdio: "pipe",
      env,
      eventPrefix: "dev-server",
    });

    const logFilePath = path.join(
      worktreePath,
      LOG_SUBDIR,
      `${serverName}.log`,
    );
    const logStream = openLogStream(logFilePath, serverName);

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
      ownedByThisSession: false,
      ownerPid: null,
      logFilePath,
      _process: child,
      _pid: child.pid ?? null,
      _logStream: logStream,
      _stdoutRemainder: "",
      _stderrRemainder: "",
    };

    registry.set(key, entry);

    // Auto-start liveness poller when first server is registered
    deps.livenessStart();

    log.info("dev-server.start.cc_assigned_port", {
      serverName,
      command,
      worktreePath,
      cwd: spawnCwd,
      port: startMode.port,
      envAliases: startMode.envAliases ?? [],
      readinessTimeoutMs: startMode.readinessTimeoutMs,
      pid: child.pid,
    });

    log.info("dev-server.start", {
      serverName,
      command,
      worktreePath,
      pid: child.pid,
    });

    broadcastStatus(entry);

    child.stdout?.on("data", (chunk: Buffer) => {
      writeChunkToLog(entry, "stdout", chunk);
      const lines = chunk.toString().split("\n");
      for (const line of lines) {
        if (line.length > 0) appendOutput(entry, line);
      }
    });

    // The probe outlives the request that started the server, so it is its own
    // background unit of work: replay the starting caller's trace so the
    // probe's spans correlate with that request instead of an orphan id, and
    // label the action as the probe rather than whatever initiated the start.
    const startingTrace = captureTraceContext();
    runAsTrace(
      "dev-server.readiness.probe",
      () =>
        timed(
          log,
          "dev-server.readiness.probe",
          { serverName, port: startMode.port },
          () =>
            runCcAssignedReadinessProbe({
              entry,
              port: startMode.port,
              timeoutMs: startMode.readinessTimeoutMs,
            }),
        ),
      startingTrace,
    ).catch((err) => {
      log.warn("dev-server.readiness.error", {
        serverName,
        port: startMode.port,
        error: getErrorMessage(err),
      });
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      writeChunkToLog(entry, "stderr", chunk);
      const lines = chunk.toString().split("\n");
      for (const line of lines) {
        if (line.trim()) appendOutput(entry, line);
      }
    });

    child.on("exit", async (code, signal) => {
      entry._process = null;
      closeLogStream(entry);

      log.info("dev-server.exit", { serverName, code, signal });

      if (entry.status === "starting") {
        const output = entry.recentOutput.slice(-10).join("\n");
        transitionTo(entry, "error", {
          errorMessage: `Process exited (code=${code}, signal=${signal}) before port ${startMode.port} ever listening.\n${output}`,
        });
        log.error("dev-server.error", {
          serverName,
          error: entry.errorMessage,
          recentOutput: entry.recentOutput.slice(-10),
        });
      } else if (entry.status === "running" && entry.port) {
        const alive = await isPortListening(entry.port);
        if (!alive) {
          log.warn("dev-server.unexpected_exit", {
            serverName,
            port: entry.port,
            code,
            signal,
          });
          if (entry.port) {
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
      }
    });

    child.on("error", (err) => {
      entry._process = null;
      closeLogStream(entry);

      log.error("dev-server.error", {
        serverName,
        error: err.message,
      });

      transitionTo(entry, "error", {
        errorMessage: `Failed to spawn process: ${err.message}`,
      });
    });
  }

  async function stopServer(
    params: Parameters<typeof stopServerUnlocked>[0],
  ): Promise<void> {
    return lifecycleMutex.run(lifecycleKey(params), () =>
      stopServerUnlocked(params),
    );
  }

  async function stopCapturedServer(entry: DevServerEntry): Promise<void> {
    return lifecycleMutex.run(lifecycleKey(entry), () =>
      stopServerUnlocked(entry, entry),
    );
  }

  /**
   * Stop a specific dev server.
   * Kills the process group first (shell + all children), then falls back
   * to port-based kill for any orphaned processes.
   */
  async function stopServerUnlocked(
    params: {
      projectPath: string;
      sessionName: string;
      worktreePath: string;
      serverName: string;
    },
    expectedEntry?: DevServerEntry,
  ): Promise<void> {
    const { projectPath, sessionName, worktreePath, serverName } = params;
    const registry = getRegistry();
    const key = makeKey(projectPath, sessionName, worktreePath, serverName);
    const entry = registry.get(key);

    if (!entry) return;
    if (expectedEntry !== undefined && entry !== expectedEntry) {
      log.debug("dev-server.cleanup.superseded", {
        serverName,
        worktreePath,
        sessionName,
      });
      return;
    }
    if (entry.status !== "running" && entry.status !== "starting") return;

    log.info("dev-server.stop", {
      serverName,
      port: entry.port,
      pid: entry._pid,
      ownedByThisSession: entry.ownedByThisSession,
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
      log.warn("dev-server.cleanup.ownership_failed", {
        serverName,
        port: entry.port,
        worktreePath: entry.worktreePath,
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
    await Promise.all(running.map(stopCapturedServer));
  }

  /**
   * Stop all dev servers whose spawn worktree matches `worktreePath`. Used at
   * graph-workflow worktree-teardown boundaries to stop lane dev servers before
   * the worktree directory is removed (stop-before-remove). Best-effort per
   * entry — one failed stop never skips the rest.
   */
  async function stopAllForWorktree(params: {
    projectPath: string;
    worktreePath: string;
  }): Promise<void> {
    await captureStopForWorktree(params)();
  }

  function captureStopForWorktree(params: {
    projectPath: string;
    worktreePath: string;
  }): () => Promise<void> {
    const target = path.resolve(params.worktreePath);
    const matches = Array.from(getRegistry().values()).filter(
      (entry) =>
        entry.projectPath === params.projectPath &&
        path.resolve(entry.worktreePath) === target &&
        (entry.status === "running" || entry.status === "starting"),
    );
    return async () => {
      log.info("dev-server.stop_all_for_worktree", {
        projectPath: params.projectPath,
        worktreePath: params.worktreePath,
        matched: matches.length,
      });
      await Promise.allSettled(matches.map(stopCapturedServer));
    };
  }

  /** Stop all dev servers across all sessions (CC shutdown). */
  async function stopAll(): Promise<void> {
    const registry = getRegistry();
    const entries = Array.from(registry.values()).filter(
      (e) => e.status === "running" || e.status === "starting",
    );
    await Promise.all(entries.map(stopCapturedServer));
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

  /** Runtime state for every registered dev server, across all projects. */
  function getAllServers(): DevServerEntry[] {
    return Array.from(getRegistry().values());
  }

  /** Get runtime state for a specific dev server. */
  function getServer(params: {
    projectPath: string;
    sessionName: string;
    worktreePath: string;
    serverName: string;
  }): DevServerEntry | undefined {
    const registry = getRegistry();
    const key = makeKey(
      params.projectPath,
      params.sessionName,
      params.worktreePath,
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

    log.info("dev-server.stop.listener_lookup", { port, worktreePath });

    const ownership = await deps.classifyPortOwnership({
      port,
      worktreePath,
      allowedCwd: allowedCwd ?? null,
    });

    if (ownership.status === "available") {
      log.info("dev-server.stop.listener_lookup", { port, found: 0 });
      return { killed, skipped };
    }

    if (ownership.status === "unknown") {
      log.warn("dev-server.stop.unverified_owner", {
        port,
        worktreePath,
        reason: ownership.reason,
        ownership: "unknown",
      });
      skipped.push({
        pid: 0,
        reason: `ownership_unknown: ${ownership.reason}`,
      });
      log.warn("dev-server.stop.kill_skipped", {
        port,
        worktreePath,
        skipped,
      });
      return { killed, skipped };
    }

    if (ownership.status === "conflict") {
      // Hidden conflicts (pid: null) come from the bind-probe — we have no PID
      // to signal, so report a sentinel 0 and a reason that surfaces the cause.
      const reason =
        ownership.pid === null
          ? `hidden_owner: ${ownership.reason ?? "bind probe failed"}`
          : "cwd_not_owned";
      const skip: { pid: number; reason: string; cwd?: string } = {
        pid: ownership.pid ?? 0,
        reason,
      };
      if (ownership.cwd !== null) skip.cwd = ownership.cwd;
      log.warn("dev-server.stop.unverified_owner", {
        port,
        pid: ownership.pid,
        cwd: ownership.cwd,
        worktreePath,
        allowedCwd: allowedCwd ?? null,
        reason,
        ownership: "conflict",
      });
      skipped.push(skip);
      log.warn("dev-server.stop.kill_skipped", {
        port,
        worktreePath,
        skipped,
      });
      return { killed, skipped };
    }

    const { pid, cwd } = ownership;
    log.info("dev-server.stop.listener_verified", { port, pid, cwd });

    const sentTerm = deps.sendSignal(pid, "SIGTERM");
    log.info("dev-server.stop.kill_signal", {
      port,
      pid,
      signal: "SIGTERM",
      delivered: sentTerm,
    });

    const deadline = Date.now() + deps.killGraceMs;
    while (Date.now() < deadline) {
      if (!deps.isProcessAlive(pid)) break;
      await sleep(50);
    }

    if (deps.isProcessAlive(pid)) {
      const sentKill = deps.sendSignal(pid, "SIGKILL");
      log.info("dev-server.stop.kill_signal", {
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
    stopAllForWorktree,
    captureStopForWorktree,
    stopAll,
    getSessionServers,
    getAllServers,
    getServer,
    killListeningProcessForPort,
    _resetForTesting,
  };
}

// ============================================================
// Shared Utilities (stateless, no DI needed)
// ============================================================

/**
 * Check whether anything is accepting TCP connections on `127.0.0.1:port`.
 *
 * Used as the readiness probe for newly-started dev servers and as the
 * pre-register gate in `deferredTailscaleRegister`. A bind-probe is NOT a
 * reliable test on macOS: a tcp46 wildcard listener (Next.js dev's default)
 * does not always block a specific `127.0.0.1` bind, so the bind would
 * succeed and the probe would falsely report "no listener" — readiness
 * timeouts even though the server is up.
 */
export function isPortListening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(2000);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("timeout", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("error", () => {
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
    await sleep(PROCESS_GROUP_POLL_INTERVAL_MS);
  }

  // Force-kill remaining processes in the group
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // Already exited
  }
}

function openLogStream(filePath: string, serverName: string): WriteStream {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const stream = createWriteStream(filePath, { flags: "w" });
  stream.on("error", (err) => {
    logger.warn("dev-server.log.write_error", {
      serverName,
      filePath,
      error: err.message,
    });
  });
  return stream;
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

// ============================================================
// Default singleton exports (backward-compatible)
// ============================================================

const defaultRegistry = createDevServerRegistry();

export const startServer = defaultRegistry.startServer;
export const stopServer = defaultRegistry.stopServer;
export const stopAllForSession = defaultRegistry.stopAllForSession;
export const stopAllForWorktree = defaultRegistry.stopAllForWorktree;
export const captureStopForWorktree = defaultRegistry.captureStopForWorktree;
export const getSessionServers = defaultRegistry.getSessionServers;
export const getAllServers = defaultRegistry.getAllServers;
export const getServer = defaultRegistry.getServer;
export const killListeningProcessForPort =
  defaultRegistry.killListeningProcessForPort;

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
