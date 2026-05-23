import { createLogger } from "./logging";
import type { BroadcastFn } from "./sse-broadcaster";
import { publishSessionStatus } from "./workflows/primitives/default-session-status-bus";
import {
  defaultPortOwnershipService,
  type PortOwnershipInput,
  type PortOwnershipResult,
  type ScanRangeInput,
  type ScanRangeMatch,
} from "./dev-server-port-ownership";
import { getGlobalSingleton } from "./global-singleton";
import {
  getPresetScanHint,
  type DevServerScanHint,
} from "./dev-server-presets";
import type { DevServerEntry } from "./dev-server-registry";
import type { DevServerStatusEvent } from "@/types";

const logger = createLogger("dev-server");

const REGISTRY_GLOBAL_KEY = "__cc_dev_servers" as const;

// ============================================================
// Public types
// ============================================================

export interface DevServerReconciliationDeps {
  classifyPortOwnership(
    input: PortOwnershipInput,
  ): Promise<PortOwnershipResult>;
  /**
   * Batched scan-range lookup used by adoption: returns the first listener in
   * `[basePort, basePort + rangeSize)` whose process cwd belongs to this
   * session's worktree, or `{ status: "none" }` when nothing matches. A single
   * call replaces what was previously one subprocess invocation per scanned
   * port — critical so adoption doesn't block the Node.js event loop for
   * tens of seconds on every dev-server status fetch.
   */
  findOwnedListenerInRange(input: ScanRangeInput): Promise<ScanRangeMatch>;
  /**
   * Return the scan range CC should sweep when looking for an externally
   * started listener for `serverName`, or null when no strategy is known.
   * Custom servers without explicit configuration must return null so the
   * reconciler does not guess.
   */
  resolveScanStrategy(serverName: string): DevServerScanHint | null;
  broadcast: BroadcastFn;
  getRegistry(): Map<string, DevServerEntry>;
}

interface ReconcileConfiguredServer {
  name: string;
  command: string;
  /**
   * Optional explicit scan range for this server. Wins over `resolveScanStrategy`
   * when present, letting custom (non-preset) servers participate in adoption
   * without having to register a global strategy.
   */
  scanHint?: DevServerScanHint | null;
  /**
   * Optional working directory for this server, relative to the worktree.
   * Threaded into port-ownership classification as `allowedCwd` so processes
   * running in subdirectories of the worktree are still treated as owned.
   */
  cwd?: string | null;
}

export interface ReconcileInput {
  projectPath: string;
  sessionName: string;
  worktreePath: string;
  configuredServers: ReadonlyArray<ReconcileConfiguredServer>;
}

// ============================================================
// Service factory
// ============================================================

export function createDevServerReconciler(deps: DevServerReconciliationDeps) {
  function makeKey(
    projectPath: string,
    sessionName: string,
    serverName: string,
  ): string {
    return `${projectPath}::${sessionName}::${serverName}`;
  }

  function buildEvent(entry: DevServerEntry): DevServerStatusEvent {
    return {
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
  }

  async function verifyRunningEntry(entry: DevServerEntry): Promise<void> {
    if (entry.port === null) return;

    const ownership = await deps.classifyPortOwnership({
      port: entry.port,
      worktreePath: entry.worktreePath,
    });

    if (ownership.status === "owned") {
      logger.info("dev-server.reconcile.verified", {
        serverName: entry.serverName,
        port: entry.port,
        pid: ownership.pid,
        worktreePath: entry.worktreePath,
      });
      return;
    }

    // Status reporting must verify live ownership before claiming "running".
    // Any non-owned classification — including unknown — moves the entry out
    // of running. We do NOT kill processes here (liveness owns kill safety);
    // we only report.
    if (ownership.status === "unknown") {
      logger.warn("dev-server.reconcile.conflict", {
        serverName: entry.serverName,
        port: entry.port,
        worktreePath: entry.worktreePath,
        reason: ownership.reason,
        ownership: "unknown",
      });
      entry.status = "error";
      entry.errorMessage = `Could not verify ownership of port ${entry.port} for worktree ${entry.worktreePath}: ${ownership.reason}`;
      entry.ownedByThisSession = false;
      entry._process = null;
      deps.broadcast(buildEvent(entry));
      return;
    }

    if (ownership.status === "conflict") {
      logger.warn("dev-server.reconcile.conflict", {
        serverName: entry.serverName,
        port: entry.port,
        conflictPid: ownership.pid,
        conflictCwd: ownership.cwd,
        worktreePath: entry.worktreePath,
      });
      entry.errorMessage = `Port ${entry.port} is now owned by pid ${ownership.pid}${ownership.cwd ? ` (cwd ${ownership.cwd})` : ""}, which is outside this session's worktree (${entry.worktreePath}).`;
    } else {
      logger.warn("dev-server.reconcile.stale_stopped", {
        serverName: entry.serverName,
        port: entry.port,
        worktreePath: entry.worktreePath,
      });
      entry.errorMessage = null;
    }

    entry.status = "stopped";
    entry.ownedByThisSession = false;
    entry._process = null;
    deps.broadcast(buildEvent(entry));
  }

  async function tryAdoptExternal(params: {
    projectPath: string;
    sessionName: string;
    worktreePath: string;
    serverName: string;
    command: string;
    scanHint: DevServerScanHint | null;
    cwd: string | null;
    existing: DevServerEntry | undefined;
  }): Promise<void> {
    const {
      projectPath,
      sessionName,
      worktreePath,
      serverName,
      command,
      scanHint,
      cwd,
      existing,
    } = params;

    const scan = scanHint ?? deps.resolveScanStrategy(serverName);
    if (!scan) {
      logger.info("dev-server.reconcile.skipped_no_scan_strategy", {
        serverName,
        worktreePath,
      });
      return;
    }

    const match = await deps.findOwnedListenerInRange({
      basePort: scan.basePort,
      rangeSize: scan.rangeSize,
      worktreePath,
      allowedCwd: cwd,
    });

    if (match.status !== "owned") return;

    const registry = deps.getRegistry();
    const key = makeKey(projectPath, sessionName, serverName);
    const adopted: DevServerEntry = {
      serverName,
      projectPath,
      sessionName,
      command,
      status: "running",
      port: match.port,
      remoteUrl: null,
      startedAt: existing?.startedAt ?? new Date().toISOString(),
      errorMessage: null,
      recentOutput: existing?.recentOutput ?? [],
      worktreePath,
      source: "external-adopted",
      ownedByThisSession: true,
      ownerPid: match.pid,
      _process: null,
      _pid: null,
      _startupTimer: null,
    };
    registry.set(key, adopted);

    logger.info("dev-server.reconcile.adopted", {
      serverName,
      port: match.port,
      ownerPid: match.pid,
      worktreePath,
    });

    deps.broadcast(buildEvent(adopted));
  }

  async function reconcile(input: ReconcileInput): Promise<void> {
    const { projectPath, sessionName, worktreePath, configuredServers } = input;

    if (configuredServers.length === 0) return;

    logger.info("dev-server.reconcile.start", {
      projectPath,
      sessionName,
      worktreePath,
      configuredCount: configuredServers.length,
    });

    const registry = deps.getRegistry();

    for (const cfg of configuredServers) {
      const key = makeKey(projectPath, sessionName, cfg.name);
      const existing = registry.get(key);

      if (existing?.status === "running") {
        await verifyRunningEntry(existing);
        continue;
      }

      if (existing?.status === "starting") {
        // CC is mid-spawn — let the start path drive the transition. Touching
        // the entry now would race with the stdout CC_PORT parser.
        continue;
      }

      await tryAdoptExternal({
        projectPath,
        sessionName,
        worktreePath,
        serverName: cfg.name,
        command: cfg.command,
        scanHint: cfg.scanHint ?? null,
        cwd: cfg.cwd ?? null,
        existing,
      });
    }
  }

  return { reconcile };
}

// ============================================================
// Default production reconciler
// ============================================================

function defaultGetRegistry(): Map<string, DevServerEntry> {
  return getGlobalSingleton(
    REGISTRY_GLOBAL_KEY,
    () => new Map<string, DevServerEntry>(),
  );
}

const defaultReconcilerBroadcast: BroadcastFn = (event) => {
  publishSessionStatus(event);
};

const defaultDevServerReconciliationDeps: DevServerReconciliationDeps = {
  classifyPortOwnership: defaultPortOwnershipService.classifyPort,
  findOwnedListenerInRange:
    defaultPortOwnershipService.findOwnedListenerInRange,
  resolveScanStrategy: getPresetScanHint,
  broadcast: defaultReconcilerBroadcast,
  getRegistry: defaultGetRegistry,
};

const defaultReconciler = createDevServerReconciler(
  defaultDevServerReconciliationDeps,
);

/**
 * Reconcile in-memory dev-server runtime state for one session against live
 * port ownership. Verifies running entries, transitions stale ones, and
 * discovers externally started preset servers without requiring Start first.
 */
export function reconcileSessionDevServers(
  input: ReconcileInput,
): Promise<void> {
  return defaultReconciler.reconcile(input);
}
