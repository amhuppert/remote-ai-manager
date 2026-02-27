import { createLogger } from "./logging";
import { broadcast } from "./sse-broadcaster";
import * as tailscale from "./tailscale";
import * as registryModule from "./dev-server-registry";
import type { DevServerStatusEvent } from "@/types";

const logger = createLogger("dev-server");
const GLOBAL_KEY = "__csm_dev_server_liveness" as const;
const POLL_INTERVAL_MS = 5_000;

function getIntervalId(): ReturnType<typeof setInterval> | null {
  const g = globalThis as unknown as Record<string, unknown>;
  return (g[GLOBAL_KEY] as ReturnType<typeof setInterval> | null) ?? null;
}

function setIntervalId(id: ReturnType<typeof setInterval> | null): void {
  const g = globalThis as unknown as Record<string, unknown>;
  g[GLOBAL_KEY] = id;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ESRCH") {
      return false;
    }
    // EPERM means process exists but we can't signal it — still alive
    return true;
  }
}

function poll(): void {
  // Access the registry's internal state by querying known sessions
  // We need all registered servers — use the globalThis registry directly
  const g = globalThis as unknown as Record<string, unknown>;
  const registryMap = g["__cc_dev_servers"] as
    | Map<string, registryModule.DevServerEntry>
    | undefined;

  if (!registryMap || registryMap.size === 0) {
    stop();
    return;
  }

  for (const [, entry] of registryMap) {
    if (
      (entry.status === "running" || entry.status === "starting") &&
      entry.pid > 0
    ) {
      if (!isProcessAlive(entry.pid)) {
        logger.warn("dev-server.liveness_dead", {
          serverName: entry.serverName,
          pid: entry.pid,
        });

        // Clean up Tailscale registration
        if (entry.port) {
          tailscale.unregister(entry.port).catch(() => {});
        }

        // Transition to stopped
        entry.status = "stopped";
        entry._process = null;

        const event: DevServerStatusEvent = {
          type: "dev-server-status",
          projectName: entry.projectPath,
          sessionName: entry.sessionName,
          serverName: entry.serverName,
          status: "stopped",
          port: entry.port,
          remoteUrl: null,
          errorMessage: null,
          adopted: entry.adopted,
        };
        broadcast(event);
      }
    }
  }

  // Auto-stop if no active servers remain
  const hasActive = Array.from(registryMap.values()).some(
    (e) => e.status === "running" || e.status === "starting",
  );
  if (!hasActive) {
    stop();
  }
}

/** Start the polling loop. Idempotent — calling when already running is a no-op. */
export function start(): void {
  if (getIntervalId() !== null) return;
  const id = setInterval(poll, POLL_INTERVAL_MS);
  setIntervalId(id);
}

/** Stop the polling loop. */
export function stop(): void {
  const id = getIntervalId();
  if (id !== null) {
    clearInterval(id);
    setIntervalId(null);
  }
}

/** Reset state for testing */
export function _resetForTesting(): void {
  stop();
}
