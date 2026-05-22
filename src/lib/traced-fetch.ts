/**
 * tracedFetch — browser-side fetch wrapper that adds tracing headers
 * to outgoing requests for end-to-end request correlation and captures
 * client-side timing (total, server, network).
 *
 * Generates a UUID trace ID via crypto.randomUUID() and attaches
 * X-Trace-Id and X-Action headers to every request.
 *
 * Logs a `console.debug("api.fetch", ...)` entry per request with:
 *   - totalMs   : round-trip duration on the client
 *   - serverMs  : server processing time parsed from `Server-Timing: total;dur=`
 *   - networkMs : totalMs - serverMs (null when Server-Timing is missing)
 *
 * Correlate with server `cc-debug.log` via the shared `traceId`.
 */

const SERVER_TIMING_TOTAL = /(?:^|,\s*)total;dur=(\d+(?:\.\d+)?)/;

function parseServerMs(header: string | null): number | null {
  if (!header) return null;
  const match = header.match(SERVER_TIMING_TOTAL);
  if (!match || !match[1]) return null;
  const parsed = Number.parseFloat(match[1]);
  return Number.isFinite(parsed) ? Math.round(parsed) : null;
}

function safePathname(url: string): string {
  try {
    return new URL(url, location.origin).pathname;
  } catch {
    return url;
  }
}

/**
 * Fetch with automatic tracing headers and client-side timing capture.
 *
 * @param url - The URL to fetch
 * @param action - A human-readable action name (e.g. "create-session")
 * @param options - Standard fetch RequestInit options
 * @returns The fetch Response
 */
export async function tracedFetch(
  url: string,
  action: string,
  options?: RequestInit,
): Promise<Response> {
  const traceId =
    typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const headers = new Headers(options?.headers);
  headers.set("x-trace-id", traceId);
  headers.set("x-action", action);

  const method = options?.method ?? "GET";
  const pathname = safePathname(url);
  const start = performance.now();

  try {
    const response = await fetch(url, {
      ...options,
      headers,
    });
    const totalMs = Math.round(performance.now() - start);
    const serverMs = parseServerMs(response.headers.get("Server-Timing"));
    const networkMs = serverMs == null ? null : totalMs - serverMs;

    console.debug("api.fetch", {
      traceId,
      action,
      method,
      url: pathname,
      status: response.status,
      totalMs,
      serverMs,
      networkMs,
    });

    return response;
  } catch (err) {
    const totalMs = Math.round(performance.now() - start);
    console.debug("api.fetch.error", {
      traceId,
      action,
      method,
      url: pathname,
      totalMs,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}
