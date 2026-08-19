import path from "node:path";
import net from "node:net";
import { createLogger, timed } from "../logging";
import type { Logger } from "../logging";
import * as registry from "./registry";
import type { DevServerEntry, DevServerStartMode } from "./registry";
import { reconcileSessionDevServers } from "./reconciliation";
import { readRepoConfig } from "../projects/repo-config";
import { getSession } from "../state-store";
import {
  normalizeDevServerConfig,
  type NormalizedDevServerConfig,
} from "./config";
import {
  defaultPortSelectionService,
  type PortSelectionInput,
  type PortSelectionResult,
} from "./port-selection";
import {
  createTailscaleServeReconciler,
  type BackendReachableProbeResult,
} from "./tailscale-cleanup";
import { createTailscaleService } from "../shared/tailscale";
import { readConfig as readGlobalConfig } from "../config/loader";
import { getErrorMessage } from "@/lib/shared/errors";
import { sleep } from "@/lib/shared/sleep";
import type {
  DevServerConfig,
  DevServerStatus,
} from "@/lib/dev-server/schemas";
const logger = createLogger("dev-server-service");

const DEFAULT_TIMEOUT_MS = 60_000;
const POLL_INTERVAL_MS = 250;

export interface DevServerStatusItem {
  serverName: string;
  command: string;
  status: DevServerStatus;
  port: number | null;
  localUrl: string | null;
  remoteUrl: string | null;
  startedAt: string | null;
  errorMessage: string | null;
  recentOutput: string[];
  ownedByThisSession: boolean;
  worktreePath: string | null;
  ownerPid: number | null;
  logFilePath: string | null;
}

interface ListDevServersParams {
  projectPath: string;
  sessionName: string;
  /** Override the resolved worktree (graph-workflow lane). Defaults to the session worktree. */
  worktreePath?: string;
}

interface EnsureDevServerParams {
  projectPath: string;
  sessionName: string;
  serverName?: string;
  wait?: boolean;
  timeoutMs?: number;
  /** Override the resolved worktree (graph-workflow lane). Defaults to the session worktree. */
  worktreePath?: string;
}

interface AwaitReadyDevServerParams {
  projectPath: string;
  sessionName: string;
  serverName: string;
  timeoutMs?: number;
  /** Override the resolved worktree (graph-workflow lane). Defaults to the session worktree. */
  worktreePath?: string;
}

interface StopDevServerParams {
  projectPath: string;
  sessionName: string;
  serverName: string;
  /** Override the resolved worktree (graph-workflow lane). Defaults to the session worktree. */
  worktreePath?: string;
}

interface StopUnmanagedParams {
  projectPath: string;
  sessionName: string;
  serverName: string;
  port: number;
}

export interface StopUnmanagedResult {
  killed: number[];
  skipped: Array<{ pid: number; reason: string; cwd?: string }>;
}

export interface DevServerService {
  list(params: ListDevServersParams): Promise<DevServerStatusItem[]>;
  /**
   * Records intent and initiates the spawn — the durable-acceptance boundary.
   * Returns the current status item once the spawn is initiated; it does NOT
   * await readiness. Post-boundary readiness is observed via `awaitReady`
   * (the CLI/tool blocking path) or the registry's readiness probe, which
   * broadcasts `dev-server-status` over SSE. `wait: true` composes `awaitReady`
   * for callers that need the blocking semantics.
   */
  ensure(params: EnsureDevServerParams): Promise<DevServerStatusItem>;
  /**
   * Post-boundary readiness observation: polls until the named server reaches
   * `running`, errors, or the timeout elapses. Separated from `ensure` so the
   * accept path structurally cannot await readiness.
   */
  awaitReady(params: AwaitReadyDevServerParams): Promise<DevServerStatusItem>;
  stop(params: StopDevServerParams): Promise<DevServerStatusItem | null>;
  stopUnmanaged(params: StopUnmanagedParams): Promise<StopUnmanagedResult>;
}

interface DevServerServiceSessionLookup {
  worktreePath: string;
}

interface DevServerServiceRepoConfig {
  devServers?: DevServerConfig[];
}

interface ReconcileConfiguredServer {
  name: string;
  command: string;
}

interface ReconcileInput {
  projectPath: string;
  sessionName: string;
  worktreePath: string;
  configuredServers: ReadonlyArray<ReconcileConfiguredServer>;
}

export interface DevServerServiceDeps {
  /**
   * Logger for the service's own events and per-phase `timed()` spans.
   * Defaults to the module logger; injected in tests to capture spans.
   */
  logger?: Logger;
  getSession(
    projectPath: string,
    sessionName: string,
  ): Promise<DevServerServiceSessionLookup | null>;
  readRepoConfig(
    worktreePath: string,
  ): Promise<DevServerServiceRepoConfig | null>;
  reconcileSessionDevServers(input: ReconcileInput): Promise<void>;
  getSessionServers(input: {
    projectPath: string;
    sessionName: string;
  }): DevServerEntry[];
  getServer(input: {
    projectPath: string;
    sessionName: string;
    worktreePath: string;
    serverName: string;
  }): DevServerEntry | undefined;
  startServer(input: {
    projectPath: string;
    sessionName: string;
    serverName: string;
    command: string;
    worktreePath: string;
    startMode?: DevServerStartMode;
  }): Promise<void>;
  selectPort?(input: PortSelectionInput): Promise<PortSelectionResult>;
  /**
   * One-shot reconciliation of stale `tailscale serve` entries from a prior
   * CC process that exited without unregistering. Runs lazily before the
   * first port selection per CC process. Optional — when omitted, no
   * reconciliation is attempted (used in tests that don't need it).
   */
  reconcileTailscaleServeOrphans?(): Promise<void>;
  stopServer(input: {
    projectPath: string;
    sessionName: string;
    worktreePath: string;
    serverName: string;
  }): Promise<void>;
  killListeningProcessForPort(input: {
    port: number;
    worktreePath: string;
    allowedCwd?: string;
  }): Promise<{
    killed: number[];
    skipped: Array<{ pid: number; reason: string; cwd?: string }>;
  }>;
  sleep(ms: number): Promise<void>;
  now(): number;
}

export class SessionNotFoundError extends Error {
  readonly code = "SESSION_NOT_FOUND";
  constructor(projectPath: string, sessionName: string) {
    super(`Session "${sessionName}" not found in project "${projectPath}"`);
    this.name = "SessionNotFoundError";
  }
}

export class NoDevServersConfiguredError extends Error {
  readonly code = "NO_DEV_SERVERS_CONFIGURED";
  constructor() {
    super(
      "No dev servers are configured for this project. Add a `devServers` entry to CommandCenter.json.",
    );
    this.name = "NoDevServersConfiguredError";
  }
}

export class AmbiguousDevServerError extends Error {
  readonly code = "AMBIGUOUS_DEV_SERVER";
  constructor(public readonly availableNames: string[]) {
    super(
      `Multiple dev servers are configured (${availableNames.join(", ")}); pass a name to select one.`,
    );
    this.name = "AmbiguousDevServerError";
  }
}

export class UnknownDevServerError extends Error {
  readonly code = "UNKNOWN_DEV_SERVER";
  constructor(public readonly serverName: string) {
    super(
      `Dev server "${serverName}" is not configured in CommandCenter.json.`,
    );
    this.name = "UnknownDevServerError";
  }
}

export class DevServerStartFailedError extends Error {
  readonly code = "DEV_SERVER_START_FAILED";
  constructor(
    public readonly serverName: string,
    public readonly errorMessage: string | null,
    public readonly recentOutput: string[],
  ) {
    super(
      `Dev server "${serverName}" failed to start: ${errorMessage ?? "unknown error"}`,
    );
    this.name = "DevServerStartFailedError";
  }
}

export class UnmanagedDevServerDetectedError extends Error {
  readonly code = "UNMANAGED_DEV_SERVER_DETECTED";
  constructor(
    public readonly serverName: string,
    public readonly port: number,
    public readonly pid: number,
    public readonly cwd: string,
  ) {
    super(
      `An unmanaged process (pid ${pid}, cwd ${cwd}) is already listening on port ${port} in this worktree. Stop it before starting dev server "${serverName}".`,
    );
    this.name = "UnmanagedDevServerDetectedError";
  }
}

export class DevServerWaitTimeoutError extends Error {
  readonly code = "DEV_SERVER_WAIT_TIMEOUT";
  constructor(
    public readonly serverName: string,
    public readonly timeoutMs: number,
    public readonly lastStatus: DevServerStatus,
  ) {
    super(
      `Dev server "${serverName}" did not reach running state within ${timeoutMs}ms (last status: ${lastStatus}).`,
    );
    this.name = "DevServerWaitTimeoutError";
  }
}

function toStatusItem(
  entry: DevServerEntry | undefined,
  config: NormalizedDevServerConfig,
): DevServerStatusItem {
  if (!entry) {
    return {
      serverName: config.name,
      command: config.command,
      status: "stopped",
      port: null,
      localUrl: null,
      remoteUrl: null,
      startedAt: null,
      errorMessage: null,
      recentOutput: [],
      ownedByThisSession: false,
      worktreePath: null,
      ownerPid: null,
      logFilePath: null,
    };
  }
  return {
    serverName: entry.serverName,
    command: entry.command,
    status: entry.status,
    port: entry.port,
    localUrl: entry.port !== null ? `http://localhost:${entry.port}` : null,
    remoteUrl: entry.remoteUrl,
    startedAt: entry.startedAt,
    errorMessage: entry.errorMessage,
    recentOutput: [...entry.recentOutput],
    ownedByThisSession: entry.ownedByThisSession,
    worktreePath: entry.worktreePath,
    ownerPid: entry.ownerPid,
    logFilePath: entry.logFilePath,
  };
}

export function createDevServerService(
  deps: DevServerServiceDeps,
): DevServerService {
  const log = deps.logger ?? logger;
  // One-shot gate: stale-serve reconciliation runs exactly once per service
  // instance (i.e. once per CC process). The promise is cached so concurrent
  // ensure() calls share it instead of each spawning their own scan.
  let tailscaleReconcileOnce: Promise<void> | null = null;
  async function reconcileTailscaleOnce(): Promise<void> {
    const reconcileOrphans = deps.reconcileTailscaleServeOrphans;
    if (!reconcileOrphans) return;
    if (!tailscaleReconcileOnce) {
      // Span wraps the actual once-per-process scan (the external tailscale
      // CLI), so its cost is attributable even though later ensure() calls
      // await an already-resolved promise for free.
      tailscaleReconcileOnce = timed(
        log,
        "dev-server.ensure.reconcile_tailscale",
        {},
        () => reconcileOrphans(),
      ).catch((err) => {
        log.warn("dev-server.tailscale.reconcile_failed", {
          error: getErrorMessage(err),
        });
      });
    }
    await tailscaleReconcileOnce;
  }

  // Relative cwd values are documented as relative to the session worktree;
  // resolve them here so downstream callers (registry spawn, port-ownership
  // checks) receive an absolute path. Absolute values pass through unchanged.
  function resolveCwd(cwd: string | null, worktreePath: string): string | null {
    if (cwd === null) return null;
    return path.resolve(worktreePath, cwd);
  }

  function toReconcileConfig(
    normalized: NormalizedDevServerConfig,
  ): ReconcileConfiguredServer {
    return {
      name: normalized.name,
      command: normalized.command,
    };
  }

  async function resolveContext(params: {
    projectPath: string;
    sessionName: string;
    worktreePath?: string;
  }): Promise<{
    worktreePath: string;
    configured: NormalizedDevServerConfig[];
  }> {
    const session = await deps.getSession(
      params.projectPath,
      params.sessionName,
    );
    if (!session) {
      throw new SessionNotFoundError(params.projectPath, params.sessionName);
    }
    // A graph-workflow lane conversation runs under the parent session name but
    // in its own worktree; honor that override so the dev server is spawned in
    // and keyed by the lane worktree. Ordinary sessions pass no override.
    const worktreePath = params.worktreePath ?? session.worktreePath;
    const repoConfig = await deps.readRepoConfig(worktreePath);
    const configured = (repoConfig?.devServers ?? []).map(
      normalizeDevServerConfig,
    );
    return {
      worktreePath,
      configured,
    };
  }

  async function list(
    params: ListDevServersParams,
  ): Promise<DevServerStatusItem[]> {
    const { worktreePath, configured } = await resolveContext(params);
    if (configured.length === 0) return [];

    await deps.reconcileSessionDevServers({
      projectPath: params.projectPath,
      sessionName: params.sessionName,
      worktreePath,
      configuredServers: configured.map(toReconcileConfig),
    });

    const runtime = deps.getSessionServers({
      projectPath: params.projectPath,
      sessionName: params.sessionName,
    });

    log.info("dev-server.tool.list", {
      projectPath: params.projectPath,
      sessionName: params.sessionName,
      configuredCount: configured.length,
      runtimeCount: runtime.length,
    });

    return configured.map((cfg) => {
      // Scope to this context's own worktree: a session can hold multiple
      // entries per serverName (parent worktree + graph-workflow lane
      // worktrees), all sharing the session prefix.
      const entry = runtime.find(
        (r) => r.serverName === cfg.name && r.worktreePath === worktreePath,
      );
      return toStatusItem(entry, cfg);
    });
  }

  async function ensure(
    params: EnsureDevServerParams,
  ): Promise<DevServerStatusItem> {
    const { worktreePath, configured } = await resolveContext(params);
    if (configured.length === 0) {
      throw new NoDevServersConfiguredError();
    }

    let target: NormalizedDevServerConfig;
    if (params.serverName !== undefined) {
      const found = configured.find((s) => s.name === params.serverName);
      if (!found) throw new UnknownDevServerError(params.serverName);
      target = found;
    } else if (configured.length === 1) {
      target = configured[0]!;
    } else {
      throw new AmbiguousDevServerError(configured.map((s) => s.name));
    }

    await timed(
      log,
      "dev-server.ensure.reconcile_session",
      { serverName: target.name, sessionName: params.sessionName },
      () =>
        deps.reconcileSessionDevServers({
          projectPath: params.projectPath,
          sessionName: params.sessionName,
          worktreePath,
          configuredServers: [toReconcileConfig(target)],
        }),
    );

    let runtime = deps.getServer({
      projectPath: params.projectPath,
      sessionName: params.sessionName,
      worktreePath,
      serverName: target.name,
    });

    const ownedAndRunning =
      runtime?.status === "running" && runtime.ownedByThisSession;
    if (ownedAndRunning) {
      log.info("dev-server.tool.ensure", {
        serverName: target.name,
        outcome: "already_running",
        port: runtime!.port,
      });
      return toStatusItem(runtime, target);
    }

    const needsStart =
      !runtime ||
      runtime.status === "stopped" ||
      runtime.status === "error" ||
      (runtime.status === "running" && !runtime.ownedByThisSession);

    if (needsStart) {
      // Clear any stale `tailscale serve` entries from a prior CC process
      // before we pick a port — otherwise port-selection sees the port as
      // free (lsof misses root-owned tailscaled), then the spawn dies with
      // EADDRINUSE because the wildcard bind collides with tailscaled's
      // specific-address bind. Runs at most once per CC process.
      await reconcileTailscaleOnce();

      const startMode = await timed(
        log,
        "dev-server.ensure.resolve_start_mode",
        { serverName: target.name },
        () => resolveStartMode({ normalized: target, worktreePath }),
      );

      log.info("dev-server.tool.ensure", {
        serverName: target.name,
        outcome: "starting",
        priorStatus: runtime?.status ?? "absent",
        port: startMode.port,
      });
      await timed(
        log,
        "dev-server.ensure.start_server",
        { serverName: target.name, port: startMode.port },
        () =>
          deps.startServer({
            projectPath: params.projectPath,
            sessionName: params.sessionName,
            serverName: target.name,
            command: target.command,
            worktreePath,
            startMode,
          }),
      );
      runtime = deps.getServer({
        projectPath: params.projectPath,
        sessionName: params.sessionName,
        worktreePath,
        serverName: target.name,
      });
    }

    // Durable-acceptance boundary: intent is recorded and the spawn is
    // initiated. The accept path (wait:false — the START route) returns the
    // current status item here WITHOUT awaiting readiness; readiness is
    // observed post-boundary by the registry's readiness probe, which
    // broadcasts `dev-server-status` over SSE (see sse-reactions.ts). The
    // pre-spawn phases (reconcile, tailscale, port selection) stay before the
    // boundary: port selection surfaces the synchronous unmanaged-listener
    // rejection, and the EADDRINUSE ordering pins the tailscale reconcile
    // ahead of it — so neither can move behind the response here.
    const wait = params.wait ?? true;
    if (!wait) {
      return toStatusItem(runtime, target);
    }

    // wait:true (the CLI/tool blocking path) preserves its semantics by
    // composing the post-boundary readiness observation.
    return pollUntilReady({
      projectPath: params.projectPath,
      sessionName: params.sessionName,
      worktreePath,
      target,
      timeoutMs: params.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    });
  }

  /**
   * Poll registry status until the named server reaches `running` (owned),
   * errors, or the timeout elapses. This is the post-boundary readiness
   * observation extracted out of `ensure` so the accept path never runs it.
   */
  async function pollUntilReady(args: {
    projectPath: string;
    sessionName: string;
    worktreePath: string;
    target: NormalizedDevServerConfig;
    timeoutMs: number;
  }): Promise<DevServerStatusItem> {
    const { projectPath, sessionName, worktreePath, target, timeoutMs } = args;
    return timed(
      log,
      "dev-server.ensure.await_ready",
      { serverName: target.name },
      async () => {
        const startedAt = deps.now();
        const deadline = startedAt + timeoutMs;
        let lastStatus: DevServerStatus =
          deps.getServer({
            projectPath,
            sessionName,
            worktreePath,
            serverName: target.name,
          })?.status ?? "stopped";
        let attempts = 0;

        while (true) {
          attempts++;
          const current = deps.getServer({
            projectPath,
            sessionName,
            worktreePath,
            serverName: target.name,
          });
          lastStatus = current?.status ?? "stopped";

          if (current?.status === "running" && current.ownedByThisSession) {
            log.info("dev-server.tool.ensure_wait", {
              serverName: target.name,
              outcome: "running",
              port: current.port,
              attempts,
              durationMs: deps.now() - startedAt,
            });
            return toStatusItem(current, target);
          }

          if (current?.status === "error") {
            log.warn("dev-server.tool.ensure_error", {
              serverName: target.name,
              errorMessage: current.errorMessage,
            });
            throw new DevServerStartFailedError(
              target.name,
              current.errorMessage,
              [...current.recentOutput],
            );
          }

          if (deps.now() >= deadline) {
            log.warn("dev-server.tool.ensure_error", {
              serverName: target.name,
              reason: "timeout",
              timeoutMs,
              lastStatus,
              attempts,
              durationMs: deps.now() - startedAt,
            });
            throw new DevServerWaitTimeoutError(
              target.name,
              timeoutMs,
              lastStatus,
            );
          }

          await deps.sleep(POLL_INTERVAL_MS);
        }
      },
    );
  }

  async function awaitReady(
    params: AwaitReadyDevServerParams,
  ): Promise<DevServerStatusItem> {
    const { worktreePath, configured } = await resolveContext(params);
    const target = configured.find((s) => s.name === params.serverName);
    if (!target) throw new UnknownDevServerError(params.serverName);
    return pollUntilReady({
      projectPath: params.projectPath,
      sessionName: params.sessionName,
      worktreePath,
      target,
      timeoutMs: params.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    });
  }

  async function resolveStartMode(args: {
    normalized: NormalizedDevServerConfig;
    worktreePath: string;
  }): Promise<DevServerStartMode> {
    const { normalized, worktreePath } = args;
    const absoluteCwd = resolveCwd(normalized.cwd, worktreePath);

    const selectPort =
      deps.selectPort ?? defaultPortSelectionService.selectPort;
    const selection = await selectPort({
      basePort: normalized.port.base,
      worktreePath,
      allowedCwd: absoluteCwd,
      maxAttempts: normalized.port.range,
    });

    if (selection.status === "unmanaged-detected") {
      throw new UnmanagedDevServerDetectedError(
        normalized.name,
        selection.port,
        selection.pid,
        selection.cwd,
      );
    }
    if (selection.status === "exhausted") {
      throw new DevServerStartFailedError(
        normalized.name,
        `Port selection exhausted starting at ${normalized.port.base} (range ${normalized.port.range}).`,
        [],
      );
    }

    const startMode: DevServerStartMode = {
      port: selection.port,
      readinessTimeoutMs: normalized.readinessTimeoutMs,
    };
    if (normalized.port.envAlias) {
      startMode.envAliases = [normalized.port.envAlias];
    }
    if (absoluteCwd) {
      startMode.cwd = absoluteCwd;
    }
    return startMode;
  }

  async function stop(
    params: StopDevServerParams,
  ): Promise<DevServerStatusItem | null> {
    const { worktreePath, configured } = await resolveContext(params);
    const target = configured.find((s) => s.name === params.serverName);
    if (!target) throw new UnknownDevServerError(params.serverName);

    log.info("dev-server.tool.stop", {
      projectPath: params.projectPath,
      sessionName: params.sessionName,
      serverName: target.name,
    });

    await deps.stopServer({
      projectPath: params.projectPath,
      sessionName: params.sessionName,
      worktreePath,
      serverName: target.name,
    });

    const after = deps.getServer({
      projectPath: params.projectPath,
      sessionName: params.sessionName,
      worktreePath,
      serverName: target.name,
    });
    return toStatusItem(after, target);
  }

  async function stopUnmanaged(
    params: StopUnmanagedParams,
  ): Promise<StopUnmanagedResult> {
    const { worktreePath, configured } = await resolveContext(params);
    const target = configured.find((s) => s.name === params.serverName);
    if (!target) throw new UnknownDevServerError(params.serverName);

    const allowedCwd = resolveCwd(target.cwd, worktreePath) ?? undefined;

    log.info("dev-server.tool.stop_unmanaged", {
      projectPath: params.projectPath,
      sessionName: params.sessionName,
      serverName: target.name,
      port: params.port,
      worktreePath,
    });

    const killInput: {
      port: number;
      worktreePath: string;
      allowedCwd?: string;
    } = { port: params.port, worktreePath };
    if (allowedCwd !== undefined) killInput.allowedCwd = allowedCwd;

    return deps.killListeningProcessForPort(killInput);
  }

  return { list, ensure, awaitReady, stop, stopUnmanaged };
}

function probeBackendReachableViaConnect(
  port: number,
): Promise<BackendReachableProbeResult> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const finish = (result: BackendReachableProbeResult) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(500);
    socket.once("connect", () => finish({ reachable: true }));
    socket.once("timeout", () =>
      finish({ reachable: false, reason: "connect_timeout" }),
    );
    socket.once("error", (err) =>
      finish({
        reachable: false,
        reason: (err as NodeJS.ErrnoException).code ?? err.message,
      }),
    );
    socket.connect(port, "127.0.0.1");
  });
}

const defaultTailscaleService = createTailscaleService();
const defaultTailscaleReconciler = createTailscaleServeReconciler({
  listServeRegistrations: () =>
    defaultTailscaleService.listServeRegistrations(),
  probeBackendReachable: probeBackendReachableViaConnect,
  unregisterServe: (port) => defaultTailscaleService.unregister(port),
  tailscaleEnabled: async () => {
    try {
      const cfg = await readGlobalConfig();
      return cfg.tailscaleEnabled === true;
    } catch {
      return false;
    }
  },
});
async function defaultReconcileTailscaleServeOrphans(): Promise<void> {
  await defaultTailscaleReconciler.reconcileOrphans();
}

export const defaultDevServerServiceDeps: DevServerServiceDeps = {
  getSession,
  readRepoConfig,
  reconcileSessionDevServers,
  getSessionServers: registry.getSessionServers,
  getServer: registry.getServer,
  startServer: registry.startServer,
  stopServer: registry.stopServer,
  killListeningProcessForPort: registry.killListeningProcessForPort,
  selectPort: defaultPortSelectionService.selectPort,
  reconcileTailscaleServeOrphans: defaultReconcileTailscaleServeOrphans,
  sleep,
  now: () => Date.now(),
};

const defaultService = createDevServerService(defaultDevServerServiceDeps);

export const listDevServers = defaultService.list;
export const ensureDevServer = defaultService.ensure;
export const awaitReadyDevServer = defaultService.awaitReady;
export const stopDevServer = defaultService.stop;
export const stopUnmanagedDevServer = defaultService.stopUnmanaged;
