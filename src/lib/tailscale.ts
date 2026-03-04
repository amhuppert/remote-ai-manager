import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getErrorMessage } from "@/lib/errors";
import { createLogger } from "./logging";

const logger = createLogger("tailscale");
const execFileAsync = promisify(execFile);

/** Cached Tailscale hostname (null = not yet resolved, string = hostname, false = unavailable) */
let cachedHostname: string | null | false = null;

/**
 * Resolve the machine's Tailscale hostname via `tailscale status --json`.
 * Caches the result for the process lifetime.
 * Returns null if Tailscale is unavailable.
 */
export async function getHostname(): Promise<string | null> {
  if (cachedHostname === false) return null;
  if (cachedHostname !== null) return cachedHostname;

  try {
    const { stdout } = await execFileAsync("tailscale", ["status", "--json"]);
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
    logger.info("tailscale.hostname_resolved", { hostname: cachedHostname });
    return cachedHostname;
  } catch (err) {
    logger.warn("tailscale.hostname_failure", {
      error: getErrorMessage(err),
    });
    cachedHostname = false;
    return null;
  }
}

/**
 * Register a local port with Tailscale Serve over HTTP.
 * Uses `--http=<port>` so each server gets its own origin without path prefixes,
 * which avoids breaking apps that assume they're served from root (e.g. Storybook).
 * HTTPS per-port only works on specific ports (443, 8443, 10000), so HTTP is the
 * only reliable option for arbitrary dev server ports.
 * Returns the constructed remote URL or null on failure.
 */
export async function register(port: number): Promise<string | null> {
  const hostname = await getHostname();
  if (!hostname) return null;

  try {
    await execFileAsync("tailscale", [
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
}

/**
 * Unregister a Tailscale Serve entry for the given port.
 * Errors are logged but never propagated.
 */
export async function unregister(port: number): Promise<void> {
  try {
    await execFileAsync("tailscale", ["serve", `--http=${port}`, "off"]);
    logger.info("tailscale.unregistered", { port });
  } catch (err) {
    logger.warn("tailscale.unregister_failure", {
      port,
      error: getErrorMessage(err),
    });
  }
}

/** Reset cached hostname for testing */
export function _resetForTesting(): void {
  cachedHostname = null;
}
