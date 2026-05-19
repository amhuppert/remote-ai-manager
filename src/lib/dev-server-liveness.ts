import { createLogger } from "./logging";
import type { BroadcastFn } from "./sse-broadcaster";
import { publishSessionStatus } from "./workflows/primitives/default-session-status-bus";
import * as tailscale from "./tailscale";
import { readConfig } from "./config";
import { defaultPortOwnershipService } from "./dev-server-port-ownership";
import type {
  PortOwnershipInput,
  PortOwnershipResult,
} from "./dev-server-port-ownership";
import { getGlobalValue, setGlobalValue } from "./global-singleton";
import type { DevServerEntry } from "./dev-server-registry";
import type { DevServerStatusEvent } from "@/types";

const logger = createLogger("dev-server");
const GLOBAL_KEY = "__cc_dev_server_liveness" as const;
const POLL_INTERVAL_MS = 5_000;

// ============================================================
// Dependency Injection (setDeps pattern)
// ============================================================

export interface LivenessDeps {
  broadcast: BroadcastFn;
  unregister(port: number): Promise<void>;
  classifyPortOwnership(
    input: PortOwnershipInput,
  ): Promise<PortOwnershipResult>;
}

let _deps: LivenessDeps | null = null;

const defaultLivenessBroadcast: BroadcastFn = (event) => {
  publishSessionStatus(event);
};

function getDeps(): LivenessDeps {
  if (!_deps) {
    _deps = {
      broadcast: defaultLivenessBroadcast,
      unregister: tailscale.unregister,
      classifyPortOwnership: defaultPortOwnershipService.classifyPort,
    };
  }
  return _deps;
}

export function setLivenessDeps(deps: LivenessDeps): void {
  _deps = deps;
}

export function _resetLivenessDepsForTesting(): void {
  _deps = null;
}

// ============================================================
// Timer management
// ============================================================

function getTimerId(): ReturnType<typeof setTimeout> | null {
  return getGlobalValue<ReturnType<typeof setTimeout>>(GLOBAL_KEY) ?? null;
}

function setTimerId(id: ReturnType<typeof setTimeout> | null): void {
  setGlobalValue(GLOBAL_KEY, id);
}

async function poll(): Promise<void> {
  const d = getDeps();
  const registryMap =
    getGlobalValue<Map<string, DevServerEntry>>("__cc_dev_servers");

  if (!registryMap || registryMap.size === 0) {
    stop();
    return;
  }

  for (const [, entry] of registryMap) {
    if (entry.status === "running" && entry.port) {
      const result = await d.classifyPortOwnership({
        port: entry.port,
        worktreePath: entry.worktreePath,
      });

      // Unknown classification is never treated as dead — could be a flake
      // in `ss`/`lsof` or a permission glitch. Phase 2 contract: unknown is
      // never safe to act on destructively.
      if (result.status === "unknown") {
        logger.warn("dev-server.liveness_unknown", {
          serverName: entry.serverName,
          port: entry.port,
          reason: result.reason,
        });
        continue;
      }

      if (result.status !== "owned") {
        logger.warn("dev-server.liveness_dead", {
          serverName: entry.serverName,
          port: entry.port,
          ownership: result.status,
        });

        // Clean up Tailscale registration if enabled
        readConfig()
          .then((config) => {
            if (config.tailscaleEnabled) {
              d.unregister(entry.port!).catch(() => {});
            }
          })
          .catch(() => {});

        // Transition to stopped
        entry.status = "stopped";
        entry._process = null;
        entry.ownedByThisSession = false;

        const event: DevServerStatusEvent = {
          type: "dev-server-status",
          projectName: entry.projectPath,
          sessionName: entry.sessionName,
          serverName: entry.serverName,
          status: "stopped",
          port: entry.port,
          remoteUrl: null,
          errorMessage: null,
          source: entry.source,
          ownedByThisSession: entry.ownedByThisSession,
          worktreePath: entry.worktreePath,
          ownerPid: entry.ownerPid,
        };
        d.broadcast(event);
      }
    }
  }

  // Auto-stop if no active servers remain
  const hasActive = Array.from(registryMap.values()).some(
    (e) => e.status === "running" || e.status === "starting",
  );
  if (!hasActive) {
    stop();
    return;
  }

  // Schedule next poll (setTimeout chain for async safety)
  setTimerId(setTimeout(() => void poll(), POLL_INTERVAL_MS));
}

/** Start the polling loop. Idempotent — calling when already running is a no-op. */
export function start(): void {
  if (getTimerId() !== null) return;
  setTimerId(setTimeout(() => void poll(), POLL_INTERVAL_MS));
}

/** Stop the polling loop. */
export function stop(): void {
  const id = getTimerId();
  if (id !== null) {
    clearTimeout(id);
    setTimerId(null);
  }
}

/** Reset state for testing */
export function _resetForTesting(): void {
  stop();
  _resetLivenessDepsForTesting();
}
