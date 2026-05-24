import path from "node:path";
import { createLogger } from "../logging";
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
import { getPresetScanHint } from "./presets";
import type {
  DevServerConfig,
  DevServerSource,
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
  source: DevServerSource | null;
  ownedByThisSession: boolean;
  worktreePath: string | null;
  ownerPid: number | null;
}

interface ListDevServersParams {
  projectPath: string;
  sessionName: string;
}

interface EnsureDevServerParams {
  projectPath: string;
  sessionName: string;
  serverName?: string;
  wait?: boolean;
  timeoutMs?: number;
}

interface StopDevServerParams {
  projectPath: string;
  sessionName: string;
  serverName: string;
}

export interface DevServerService {
  list(params: ListDevServersParams): Promise<DevServerStatusItem[]>;
  ensure(params: EnsureDevServerParams): Promise<DevServerStatusItem>;
  stop(params: StopDevServerParams): Promise<DevServerStatusItem | null>;
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
  scanHint?: { basePort: number; rangeSize: number } | null;
  cwd?: string | null;
}

interface ReconcileInput {
  projectPath: string;
  sessionName: string;
  worktreePath: string;
  configuredServers: ReadonlyArray<ReconcileConfiguredServer>;
}

export interface DevServerServiceDeps {
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
  stopServer(input: {
    projectPath: string;
    sessionName: string;
    serverName: string;
  }): Promise<void>;
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
      source: null,
      ownedByThisSession: false,
      worktreePath: null,
      ownerPid: null,
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
    source: entry.source,
    ownedByThisSession: entry.ownedByThisSession,
    worktreePath: entry.worktreePath,
    ownerPid: entry.ownerPid,
  };
}

export function createDevServerService(
  deps: DevServerServiceDeps,
): DevServerService {
  function resolveScanHint(
    normalized: NormalizedDevServerConfig,
  ): { basePort: number; rangeSize: number } | null {
    if (normalized.port.base !== null) {
      return {
        basePort: normalized.port.base,
        rangeSize: normalized.port.range,
      };
    }
    return getPresetScanHint(normalized.name);
  }

  // Relative cwd values are documented as relative to the session worktree;
  // resolve them here so downstream callers (registry spawn, reconciliation
  // port-ownership checks) receive an absolute path. Absolute values pass
  // through unchanged.
  function resolveCwd(cwd: string | null, worktreePath: string): string | null {
    if (cwd === null) return null;
    return path.resolve(worktreePath, cwd);
  }

  function toReconcileConfig(
    normalized: NormalizedDevServerConfig,
    worktreePath: string,
  ): ReconcileConfiguredServer {
    return {
      name: normalized.name,
      command: normalized.command,
      scanHint: resolveScanHint(normalized),
      cwd: resolveCwd(normalized.cwd, worktreePath),
    };
  }

  async function resolveContext(params: {
    projectPath: string;
    sessionName: string;
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
    const repoConfig = await deps.readRepoConfig(session.worktreePath);
    const configured = (repoConfig?.devServers ?? []).map(
      normalizeDevServerConfig,
    );
    return {
      worktreePath: session.worktreePath,
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
      configuredServers: configured.map((c) =>
        toReconcileConfig(c, worktreePath),
      ),
    });

    const runtime = deps.getSessionServers({
      projectPath: params.projectPath,
      sessionName: params.sessionName,
    });

    logger.info("dev-server.tool.list", {
      projectPath: params.projectPath,
      sessionName: params.sessionName,
      configuredCount: configured.length,
      runtimeCount: runtime.length,
    });

    return configured.map((cfg) => {
      const entry = runtime.find((r) => r.serverName === cfg.name);
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

    await deps.reconcileSessionDevServers({
      projectPath: params.projectPath,
      sessionName: params.sessionName,
      worktreePath,
      configuredServers: [toReconcileConfig(target, worktreePath)],
    });

    let runtime = deps.getServer({
      projectPath: params.projectPath,
      sessionName: params.sessionName,
      serverName: target.name,
    });

    const ownedAndRunning =
      runtime?.status === "running" && runtime.ownedByThisSession;
    if (ownedAndRunning) {
      logger.info("dev-server.tool.ensure", {
        serverName: target.name,
        outcome: "already_running",
        port: runtime!.port,
        source: runtime!.source,
      });
      return toStatusItem(runtime, target);
    }

    const needsStart =
      !runtime ||
      runtime.status === "stopped" ||
      runtime.status === "error" ||
      (runtime.status === "running" && !runtime.ownedByThisSession);

    if (needsStart) {
      const startMode = await resolveStartMode({
        normalized: target,
        worktreePath,
      });

      logger.info("dev-server.tool.ensure", {
        serverName: target.name,
        outcome: "starting",
        priorStatus: runtime?.status ?? "absent",
        startMode: startMode?.type ?? "stdout-cc-port",
      });
      const startInput: {
        projectPath: string;
        sessionName: string;
        serverName: string;
        command: string;
        worktreePath: string;
        startMode?: DevServerStartMode;
      } = {
        projectPath: params.projectPath,
        sessionName: params.sessionName,
        serverName: target.name,
        command: target.command,
        worktreePath,
      };
      if (startMode) startInput.startMode = startMode;
      await deps.startServer(startInput);
      runtime = deps.getServer({
        projectPath: params.projectPath,
        sessionName: params.sessionName,
        serverName: target.name,
      });
    }

    const wait = params.wait ?? true;
    if (!wait) {
      return toStatusItem(runtime, target);
    }

    const timeoutMs = params.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const deadline = deps.now() + timeoutMs;
    let lastStatus: DevServerStatus = runtime?.status ?? "stopped";

    while (true) {
      const current = deps.getServer({
        projectPath: params.projectPath,
        sessionName: params.sessionName,
        serverName: target.name,
      });
      lastStatus = current?.status ?? "stopped";

      if (current?.status === "running" && current.ownedByThisSession) {
        logger.info("dev-server.tool.ensure_wait", {
          serverName: target.name,
          outcome: "running",
          port: current.port,
        });
        return toStatusItem(current, target);
      }

      if (current?.status === "error") {
        logger.warn("dev-server.tool.ensure_error", {
          serverName: target.name,
          errorMessage: current.errorMessage,
        });
        throw new DevServerStartFailedError(target.name, current.errorMessage, [
          ...current.recentOutput,
        ]);
      }

      if (deps.now() >= deadline) {
        logger.warn("dev-server.tool.ensure_error", {
          serverName: target.name,
          reason: "timeout",
          timeoutMs,
          lastStatus,
        });
        throw new DevServerWaitTimeoutError(target.name, timeoutMs, lastStatus);
      }

      await deps.sleep(POLL_INTERVAL_MS);
    }
  }

  async function resolveStartMode(args: {
    normalized: NormalizedDevServerConfig;
    worktreePath: string;
  }): Promise<DevServerStartMode | undefined> {
    const { normalized, worktreePath } = args;
    if (normalized.port.strategy !== "cc-assigned") return undefined;
    if (normalized.port.base === null) return undefined;

    const absoluteCwd = resolveCwd(normalized.cwd, worktreePath);

    const selectPort =
      deps.selectPort ?? defaultPortSelectionService.selectPort;
    const selection = await selectPort({
      basePort: normalized.port.base,
      worktreePath,
      allowedCwd: absoluteCwd,
      maxAttempts: normalized.port.range,
    });

    if (selection.status !== "selected") {
      throw new DevServerStartFailedError(
        normalized.name,
        `Port selection exhausted starting at ${normalized.port.base} (range ${normalized.port.range}).`,
        [],
      );
    }

    const startMode: DevServerStartMode = {
      type: "cc-assigned",
      port: selection.port,
      readiness: {
        type: "tcp",
        timeoutMs: normalized.readiness.timeoutMs,
      },
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
    const { configured } = await resolveContext(params);
    const target = configured.find((s) => s.name === params.serverName);
    if (!target) throw new UnknownDevServerError(params.serverName);

    logger.info("dev-server.tool.stop", {
      projectPath: params.projectPath,
      sessionName: params.sessionName,
      serverName: target.name,
    });

    await deps.stopServer({
      projectPath: params.projectPath,
      sessionName: params.sessionName,
      serverName: target.name,
    });

    const after = deps.getServer({
      projectPath: params.projectPath,
      sessionName: params.sessionName,
      serverName: target.name,
    });
    return toStatusItem(after, target);
  }

  return { list, ensure, stop };
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const defaultDevServerServiceDeps: DevServerServiceDeps = {
  getSession,
  readRepoConfig,
  reconcileSessionDevServers,
  getSessionServers: registry.getSessionServers,
  getServer: registry.getServer,
  startServer: registry.startServer,
  stopServer: registry.stopServer,
  selectPort: defaultPortSelectionService.selectPort,
  sleep: defaultSleep,
  now: () => Date.now(),
};

const defaultService = createDevServerService(defaultDevServerServiceDeps);

export const listDevServers = defaultService.list;
export const ensureDevServer = defaultService.ensure;
export const stopDevServer = defaultService.stop;
