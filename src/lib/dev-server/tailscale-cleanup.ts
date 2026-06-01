import { createLogger } from "../logging";
import { getErrorMessage } from "@/lib/shared/errors";
import type { TailscaleServeRegistration } from "../shared/tailscale";

const logger = createLogger("dev-server");

export interface BackendReachableProbeResult {
  reachable: boolean;
  reason?: string;
}

export interface TailscaleServeReconcilerDeps {
  listServeRegistrations(): Promise<TailscaleServeRegistration[]>;
  /**
   * Attempt a short-lived TCP connect to `127.0.0.1:<port>` (the proxy target
   * of a CC-shaped serve entry). A refused/timeout connection means the dev
   * server backing this registration is gone — the entry is an orphan that
   * outlived its CC owner.
   *
   * We intentionally do NOT use a bind-probe here: tailscaled itself binds
   * specific tailnet addresses on the same port, which conflicts with wildcard
   * bind-probes on macOS — so a bind-probe would say "in use" for every active
   * tailscale serve entry and never let us clean orphans.
   */
  probeBackendReachable(port: number): Promise<BackendReachableProbeResult>;
  unregisterServe(port: number): Promise<void>;
  /**
   * Honor the project's tailscale-enabled flag. When disabled, reconciliation
   * is a no-op so we never tear down serve entries that look CC-shaped but
   * actually belong to whatever other tool the user has configured.
   */
  tailscaleEnabled(): Promise<boolean>;
}

export interface TailscaleServeReconcileResult {
  removed: number[];
  retained: number[];
  skipped: "disabled" | null;
}

export function createTailscaleServeReconciler(
  deps: TailscaleServeReconcilerDeps,
) {
  return {
    /**
     * One-shot reconciliation: list CC-shaped serve entries, connect-probe the
     * `localhost:<port>` backend, and unregister entries whose backend is
     * unreachable (the dev server crashed/exited and left the serve entry
     * behind). Never throws — every step is best-effort.
     */
    async reconcileOrphans(): Promise<TailscaleServeReconcileResult> {
      if (!(await deps.tailscaleEnabled())) {
        return { removed: [], retained: [], skipped: "disabled" };
      }

      const entries = await deps.listServeRegistrations();
      if (entries.length === 0) {
        return { removed: [], retained: [], skipped: null };
      }

      const removed: number[] = [];
      const retained: number[] = [];
      for (const entry of entries) {
        const probe = await deps.probeBackendReachable(entry.port);
        if (probe.reachable) {
          retained.push(entry.port);
          continue;
        }

        try {
          await deps.unregisterServe(entry.port);
          logger.info("dev-server.tailscale.orphan_removed", {
            port: entry.port,
            proxyTarget: entry.proxyTarget,
            reason: probe.reason,
          });
          removed.push(entry.port);
        } catch (err) {
          // Surface as retained so callers can see reconciliation didn't fully
          // clear the port — but don't propagate; the worst case is the next
          // ensure() still trips EADDRINUSE and the user gets the same error.
          logger.warn("dev-server.tailscale.orphan_remove_failed", {
            port: entry.port,
            error: getErrorMessage(err),
          });
          retained.push(entry.port);
        }
      }

      logger.info("dev-server.tailscale.reconcile_done", {
        removedCount: removed.length,
        retainedCount: retained.length,
      });
      return { removed, retained, skipped: null };
    },
  };
}
