import { execFile as timedExecFile } from "./exec";
import { getErrorMessage } from "@/lib/shared/errors";
import { createLogger } from "../logging";

const logger = createLogger("tailscale");

/* ------------------------------------------------------------------ */
/*  DI factory                                                         */
/* ------------------------------------------------------------------ */

export interface TailscaleDeps {
  execFileAsync: (
    cmd: string,
    args: string[],
  ) => Promise<{ stdout: string; stderr: string }>;
}

const defaultTailscaleDeps: TailscaleDeps = {
  execFileAsync: (cmd, args) =>
    timedExecFile(cmd, args, { eventPrefix: "tailscale" }),
};

/**
 * A `tailscale serve` registration whose Tailscale-side HTTP listener port
 * matches a `http://localhost:N` proxy target — the exact shape CC produces
 * via `register()`. Asymmetric or non-HTTP entries (user-configured serves,
 * HTTPS, different proxy ports) are filtered out by `listServeRegistrations`
 * so reconciliation only ever touches entries CC could plausibly own.
 */
export interface TailscaleServeRegistration {
  port: number;
  proxyTarget: string;
}

export interface TailscaleService {
  getHostname(): Promise<string | null>;
  register(port: number): Promise<string | null>;
  unregister(port: number): Promise<void>;
  /**
   * Returns the subset of `tailscale serve` entries that match CC's symmetric
   * `--http=N → localhost:N` pattern. Returns `[]` on any error (missing CLI,
   * unparseable JSON, no entries) — listing is best-effort.
   */
  listServeRegistrations(): Promise<TailscaleServeRegistration[]>;
}

/**
 * Extract CC-shaped serve entries from the JSON `tailscale serve status` emits.
 * Pure function — exposed for direct testing without spawning subprocesses.
 *
 * The pattern we recognize: TCP[port].HTTP === true AND some Web["host:port"]
 * entry whose `/` handler proxies to `http://localhost:<same-port>`. This is
 * exactly what `register()` writes, and it's narrow enough that user-configured
 * entries (HTTPS, different proxy ports, non-`/` paths) are never matched.
 */
export function parseServeStatusForCcEntries(
  json: string,
): TailscaleServeRegistration[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== "object") return [];

  const root = parsed as {
    TCP?: Record<string, { HTTP?: boolean }>;
    Web?: Record<string, { Handlers?: Record<string, { Proxy?: string }> }>;
  };

  const httpPorts = new Set<number>();
  for (const [portStr, cfg] of Object.entries(root.TCP ?? {})) {
    if (cfg && cfg.HTTP === true) {
      const port = Number.parseInt(portStr, 10);
      if (Number.isFinite(port) && port > 0) httpPorts.add(port);
    }
  }

  const results: TailscaleServeRegistration[] = [];
  for (const [hostPort, cfg] of Object.entries(root.Web ?? {})) {
    const colonIdx = hostPort.lastIndexOf(":");
    if (colonIdx === -1) continue;
    const port = Number.parseInt(hostPort.slice(colonIdx + 1), 10);
    if (!Number.isFinite(port) || port <= 0) continue;
    if (!httpPorts.has(port)) continue;

    const proxy = cfg?.Handlers?.["/"]?.Proxy;
    if (typeof proxy !== "string") continue;
    if (proxy !== `http://localhost:${port}`) continue;

    results.push({ port, proxyTarget: proxy });
  }
  return results;
}

export function createTailscaleService(
  deps: TailscaleDeps = defaultTailscaleDeps,
): TailscaleService {
  /** Cached Tailscale hostname (null = not yet resolved, string = hostname, false = unavailable) */
  let cachedHostname: string | null | false = null;

  return {
    async getHostname(): Promise<string | null> {
      if (cachedHostname === false) return null;
      if (cachedHostname !== null) return cachedHostname;

      try {
        const { stdout } = await deps.execFileAsync("tailscale", [
          "status",
          "--json",
        ]);
        const status = JSON.parse(stdout) as {
          Self?: { DNSName?: string };
        };
        const dnsName = status.Self?.DNSName;
        if (!dnsName) {
          logger.warn("tailscale.no_dns_name", {});
          cachedHostname = false;
          return null;
        }
        // Strip trailing dot from FQDN
        cachedHostname = dnsName.replace(/\.$/, "");
        logger.info("tailscale.hostname_resolved", {
          hostname: cachedHostname,
        });
        return cachedHostname;
      } catch (err) {
        logger.warn("tailscale.hostname_failure", {
          error: getErrorMessage(err),
        });
        cachedHostname = false;
        return null;
      }
    },

    async register(port: number): Promise<string | null> {
      const hostname = await this.getHostname();
      if (!hostname) return null;

      try {
        await deps.execFileAsync("tailscale", [
          "serve",
          `--http=${port}`,
          "--bg",
          `localhost:${port}`,
        ]);
        const remoteUrl = `http://${hostname}:${port}`;
        logger.info("tailscale.registered", { port, remoteUrl });
        return remoteUrl;
      } catch (err) {
        logger.warn("tailscale.register_failure", {
          port,
          error: getErrorMessage(err),
        });
        return null;
      }
    },

    async unregister(port: number): Promise<void> {
      try {
        await deps.execFileAsync("tailscale", [
          "serve",
          `--http=${port}`,
          "off",
        ]);
        logger.info("tailscale.unregistered", { port });
      } catch (err) {
        logger.warn("tailscale.unregister_failure", {
          port,
          error: getErrorMessage(err),
        });
      }
    },

    async listServeRegistrations(): Promise<TailscaleServeRegistration[]> {
      try {
        const { stdout } = await deps.execFileAsync("tailscale", [
          "serve",
          "status",
          "--json",
        ]);
        return parseServeStatusForCcEntries(stdout);
      } catch (err) {
        logger.warn("tailscale.serve_status_failure", {
          error: getErrorMessage(err),
        });
        return [];
      }
    },
  };
}

/* ------------------------------------------------------------------ */
/*  Default singleton (backward-compatible module-level exports)      */
/* ------------------------------------------------------------------ */

const defaultService = createTailscaleService();

export async function register(port: number): Promise<string | null> {
  return defaultService.register(port);
}

export async function unregister(port: number): Promise<void> {
  return defaultService.unregister(port);
}
