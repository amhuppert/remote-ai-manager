import os from "node:os";
import { createLogger } from "./logging";

const logger = createLogger("network");

/* ------------------------------------------------------------------ */
/*  DI factory                                                         */
/* ------------------------------------------------------------------ */

export interface NetworkDeps {
  networkInterfaces: () => NodeJS.Dict<os.NetworkInterfaceInfo[]>;
}

export const defaultNetworkDeps: NetworkDeps = {
  networkInterfaces: () => os.networkInterfaces(),
};

export interface NetworkService {
  getLanIp(): string | null;
  getLanUrl(port: number): string | null;
}

export function createNetworkService(
  deps: NetworkDeps = defaultNetworkDeps,
): NetworkService {
  /** Cached LAN IP (null = not yet resolved, string = IP, false = unavailable) */
  let cachedLanIp: string | null | false = null;

  return {
    getLanIp(): string | null {
      if (cachedLanIp === false) return null;
      if (cachedLanIp !== null) return cachedLanIp;

      const interfaces = deps.networkInterfaces();
      for (const entries of Object.values(interfaces)) {
        if (!entries) continue;
        for (const entry of entries) {
          if (entry.family === "IPv4" && !entry.internal) {
            cachedLanIp = entry.address;
            logger.info("network.lan_ip_resolved", { ip: cachedLanIp });
            return cachedLanIp;
          }
        }
      }

      logger.warn("network.no_lan_ip", {});
      cachedLanIp = false;
      return null;
    },

    getLanUrl(port: number): string | null {
      const ip = this.getLanIp();
      if (!ip) return null;
      return `http://${ip}:${port}`;
    },
  };
}

/* ------------------------------------------------------------------ */
/*  Default singleton (backward-compatible module-level exports)      */
/* ------------------------------------------------------------------ */

const defaultService = createNetworkService();

export function getLanIp(): string | null {
  return defaultService.getLanIp();
}

export function getLanUrl(port: number): string | null {
  return defaultService.getLanUrl(port);
}
