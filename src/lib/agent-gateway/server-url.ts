/**
 * The server's own base URL, recorded once at boot. CC has no runtime URL
 * awareness elsewhere (config/loader.ts resolves paths only); the env
 * contract (CC_SERVER_URL) and future agent-facing features read it from
 * here instead of re-deriving it per call site.
 */

export function resolveServerBaseUrl(
  env: Record<string, string | undefined>,
): string {
  const port = env["PORT"] || "3000";
  return `http://127.0.0.1:${port}`;
}

let serverBaseUrl: string | null = null;

/** Record the base URL at boot from the PORT env. Returns the recorded URL. */
export function recordServerBaseUrl(
  env: Record<string, string | undefined> = process.env,
): string {
  serverBaseUrl = resolveServerBaseUrl(env);
  return serverBaseUrl;
}

/** The base URL recorded at boot, or null if startup has not run yet. */
export function getServerBaseUrl(): string | null {
  return serverBaseUrl;
}

export function _resetServerBaseUrlForTesting(): void {
  serverBaseUrl = null;
}
