import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getErrorMessage } from "@/lib/errors";
import { createLogger } from "./logging";

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

export const defaultTailscaleDeps: TailscaleDeps = {
  execFileAsync: promisify(execFile),
};

export interface TailscaleService {
  getHostname(): Promise<string | null>;
  register(port: number): Promise<string | null>;
  unregister(port: number): Promise<void>;
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
  };
}

/* ------------------------------------------------------------------ */
/*  Default singleton (backward-compatible module-level exports)      */
/* ------------------------------------------------------------------ */

const defaultService = createTailscaleService();

export async function getHostname(): Promise<string | null> {
  return defaultService.getHostname();
}

export async function register(port: number): Promise<string | null> {
  return defaultService.register(port);
}

export async function unregister(port: number): Promise<void> {
  return defaultService.unregister(port);
}
