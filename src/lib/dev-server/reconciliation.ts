import { createLogger } from "../logging";
import { publishEvent, type PublishFn } from "../events/publication";
import {
  defaultPortOwnershipService,
  type PortOwnershipInput,
  type PortOwnershipResult,
} from "./port-ownership";
import { getGlobalSingleton } from "../shared/global-singleton";
import { transitionEntryTo, type DevServerEntry } from "./registry";

const logger = createLogger("dev-server");

const REGISTRY_GLOBAL_KEY = "__cc_dev_servers" as const;

// ============================================================
// Public types
// ============================================================

export interface DevServerReconciliationDeps {
  classifyPortOwnership(
    input: PortOwnershipInput,
  ): Promise<PortOwnershipResult>;
  broadcast: PublishFn;
  getRegistry(): Map<string, DevServerEntry>;
}

interface ReconcileConfiguredServer {
  name: string;
  command: string;
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
    worktreePath: string,
    serverName: string,
  ): string {
    return `${projectPath}::${sessionName}::${worktreePath}::${serverName}`;
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
      entry.ownedByThisSession = false;
      entry._process = null;
      transitionEntryTo(entry, "error", deps.broadcast, {
        errorMessage: `Could not verify ownership of port ${entry.port} for worktree ${entry.worktreePath}: ${ownership.reason}`,
      });
      return;
    }

    let errorMessage: string | null;
    if (ownership.status === "conflict") {
      logger.warn("dev-server.reconcile.conflict", {
        serverName: entry.serverName,
        port: entry.port,
        conflictPid: ownership.pid,
        conflictCwd: ownership.cwd,
        conflictReason: ownership.reason ?? null,
        worktreePath: entry.worktreePath,
      });
      errorMessage =
        ownership.pid === null
          ? `Port ${entry.port} is in use by a process invisible to lsof (likely root-owned, e.g. a stale tailscale serve entry): ${ownership.reason ?? "bind probe failed"}.`
          : `Port ${entry.port} is now owned by pid ${ownership.pid}${ownership.cwd ? ` (cwd ${ownership.cwd})` : ""}, which is outside this session's worktree (${entry.worktreePath}).`;
    } else {
      logger.warn("dev-server.reconcile.stale_stopped", {
        serverName: entry.serverName,
        port: entry.port,
        worktreePath: entry.worktreePath,
      });
      errorMessage = null;
    }

    entry.ownedByThisSession = false;
    entry._process = null;
    transitionEntryTo(entry, "stopped", deps.broadcast, { errorMessage });
  }

  async function reconcile(input: ReconcileInput): Promise<void> {
    const { projectPath, sessionName, configuredServers } = input;

    if (configuredServers.length === 0) return;

    logger.info("dev-server.reconcile.start", {
      projectPath,
      sessionName,
      worktreePath: input.worktreePath,
      configuredCount: configuredServers.length,
    });

    const registry = deps.getRegistry();

    for (const cfg of configuredServers) {
      const key = makeKey(
        projectPath,
        sessionName,
        input.worktreePath,
        cfg.name,
      );
      const existing = registry.get(key);

      if (existing?.status === "running") {
        await verifyRunningEntry(existing);
      }
      // No adoption: entries are only created by explicit start via the
      // service layer, which surfaces unmanaged listeners as a typed error
      // so the user can confirm stopping them before CC takes the port.
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

const defaultReconcilerBroadcast: PublishFn = publishEvent;

const defaultDevServerReconciliationDeps: DevServerReconciliationDeps = {
  classifyPortOwnership: defaultPortOwnershipService.classifyPort,
  broadcast: defaultReconcilerBroadcast,
  getRegistry: defaultGetRegistry,
};

const defaultReconciler = createDevServerReconciler(
  defaultDevServerReconciliationDeps,
);

/**
 * Reconcile in-memory dev-server runtime state for one session against live
 * port ownership. Verifies running entries and transitions stale ones; never
 * discovers or adopts externally started servers.
 */
export function reconcileSessionDevServers(
  input: ReconcileInput,
): Promise<void> {
  return defaultReconciler.reconcile(input);
}
