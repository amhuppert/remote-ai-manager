/**
 * The server's own base URL, recorded once at boot. CC has no runtime URL
 * awareness elsewhere (config/loader.ts resolves paths only); the env
 * contract (CC_SERVER_URL) and future agent-facing features read it from
 * here instead of re-deriving it per call site.
 *
 * The URL is stored on globalThis, not in a module-local variable: Next.js
 * bundles instrumentation (which records it at boot) separately from the
 * route-handler runtime (which reads it when spawning a session's env), so a
 * module-local value recorded in one graph reads back as null in the other.
 */

import {
  deleteGlobalValue,
  getGlobalValue,
  setGlobalValue,
} from "@/lib/shared/global-singleton";

const SERVER_BASE_URL_KEY = "__cc_server_base_url";

export function resolveServerBaseUrl(
  env: Record<string, string | undefined>,
): string {
  const port = env["PORT"] || "3000";
  return `http://127.0.0.1:${port}`;
}

/** Record the base URL at boot from the PORT env. Returns the recorded URL. */
export function recordServerBaseUrl(
  env: Record<string, string | undefined> = process.env,
): string {
  const url = resolveServerBaseUrl(env);
  setGlobalValue(SERVER_BASE_URL_KEY, url);
  return url;
}

/** The base URL recorded at boot, or null if startup has not run yet. */
export function getServerBaseUrl(): string | null {
  return getGlobalValue<string>(SERVER_BASE_URL_KEY) ?? null;
}

export function _resetServerBaseUrlForTesting(): void {
  deleteGlobalValue(SERVER_BASE_URL_KEY);
}
