import os from "node:os";
import { createLogger } from "./logging";

const logger = createLogger("network");

/** Cached LAN IP (null = not yet resolved, string = IP, false = unavailable) */
let cachedLanIp: string | null | false = null;

/**
 * Resolve the machine's LAN IP address.
 * Returns the first non-loopback IPv4 address, or null if none found.
 * Caches the result for the process lifetime.
 */
export function getLanIp(): string | null {
  if (cachedLanIp === false) return null;
  if (cachedLanIp !== null) return cachedLanIp;

  const interfaces = os.networkInterfaces();
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
}

/**
 * Construct a LAN URL for the given port.
 * Returns `http://<LAN_IP>:<port>` or null if no LAN IP is available.
 */
export function getLanUrl(port: number): string | null {
  const ip = getLanIp();
  if (!ip) return null;
  return `http://${ip}:${port}`;
}

/** Reset cached LAN IP for testing */
export function _resetForTesting(): void {
  cachedLanIp = null;
}
