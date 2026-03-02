import { createLogger } from "./logging";
import { broadcast } from "./sse-broadcaster";
import * as tailscale from "./tailscale";
import { readConfig } from "./config";
import { isPortAlive } from "./dev-server-registry";
import type { DevServerEntry } from "./dev-server-registry";
import type { DevServerStatusEvent } from "@/types";

const logger = createLogger("dev-server");
const GLOBAL_KEY = "__cc_dev_server_liveness" as const;
const POLL_INTERVAL_MS = 5_000;

function getTimerId(): ReturnType<typeof setTimeout> | null {
  const g = globalThis as unknown as Record<string, unknown>;
  return (g[GLOBAL_KEY] as ReturnType<typeof setTimeout> | null) ?? null;
}

function setTimerId(id: ReturnType<typeof setTimeout> | null): void {
  const g = globalThis as unknown as Record<string, unknown>;
  g[GLOBAL_KEY] = id;
}

async function poll(): Promise<void> {
  const g = globalThis as unknown as Record<string, unknown>;
  const registryMap = g["__cc_dev_servers"] as
    | Map<string, DevServerEntry>
    | undefined;

  if (!registryMap || registryMap.size === 0) {
    stop();
    return;
  }

  for (const [, entry] of registryMap) {
    if (entry.status === "running" && entry.port) {
      const alive = await isPortAlive(entry.port);
      if (!alive) {
        logger.warn("dev-server.liveness_dead", {
          serverName: entry.serverName,
          port: entry.port,
        });

        // Clean up Tailscale registration if enabled
        readConfig()
          .then((config) => {
            if (config.tailscaleEnabled) {
              tailscale.unregister(entry.port!).catch(() => {});
            }
          })
          .catch(() => {});

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
}
