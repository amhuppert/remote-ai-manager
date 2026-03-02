/**
 * tracedFetch — browser-side fetch wrapper that adds tracing headers
 * to outgoing requests for end-to-end request correlation.
 *
 * Generates a UUID trace ID via crypto.randomUUID() and attaches
 * X-Trace-Id and X-Action headers to every request.
 */

/**
 * Fetch with automatic tracing headers.
 *
 * @param url - The URL to fetch
 * @param action - A human-readable action name (e.g. "create-session")
 * @param options - Standard fetch RequestInit options
 * @returns The fetch Response
 */
export function tracedFetch(
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

  return fetch(url, {
    ...options,
    headers,
  });
}
