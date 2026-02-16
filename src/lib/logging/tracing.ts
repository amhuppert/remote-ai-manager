/**
 * withTracing — higher-order function wrapping Next.js API route handlers
 * with request-scoped tracing instrumentation.
 *
 * Extracts X-Trace-Id and X-Action from request headers, sets up
 * AsyncLocalStorage trace context, and logs request lifecycle events.
 */

import { randomUUID } from "node:crypto";
import { runWithTrace, type TraceContext } from "./context";
import { createLogger } from "./logger";

const logger = createLogger("tracing");

type RouteHandler = (
  request: Request,
  context: { params: Promise<Record<string, string>> },
) => Promise<Response>;

/**
 * Wrap a Next.js API route handler with tracing instrumentation.
 *
 * - Extracts X-Trace-Id from request header (generates UUID if absent)
 * - Extracts X-Action from request header
 * - Extracts projectName/sessionName from URL params (keys "name" and "session")
 * - Initializes ALS trace context for handler duration
 * - Logs request start and completion at info level
 * - Adds X-Trace-Id to response header
 * - Catches unhandled errors, logs with full context, re-throws
 */
export function withTracing(handler: RouteHandler): RouteHandler {
  return async (request, context) => {
    const start = Date.now();
    const url = new URL(request.url);

    // Extract trace headers
    const traceId = request.headers.get("x-trace-id") ?? randomUUID();
    const action = request.headers.get("x-action") ?? undefined;

    // Extract project/session from URL params if available
    let projectName: string | undefined;
    let sessionName: string | undefined;
    try {
      const params = await context.params;
      projectName = params["name"];
      sessionName = params["session"]
        ? decodeURIComponent(params["session"])
        : undefined;
    } catch {
      // No params or params resolution failed — not all routes have params
    }

    const traceContext: TraceContext = {
      traceId,
      action,
      projectName,
      sessionName,
    };

    return runWithTrace(traceContext, async () => {
      logger.info("request.start", {
        method: request.method,
        path: url.pathname,
      });

      try {
        const response = await handler(request, context);

        const durationMs = Date.now() - start;
        logger.info("request.complete", {
          method: request.method,
          path: url.pathname,
          status: response.status,
          durationMs,
        });

        // Add trace ID to response headers
        response.headers.set("x-trace-id", traceId);
        return response;
      } catch (err) {
        const durationMs = Date.now() - start;
        logger.error("request.error", {
          method: request.method,
          path: url.pathname,
          durationMs,
          error: err instanceof Error ? err.message : String(err),
          stack: err instanceof Error ? err.stack : undefined,
        });
        throw err;
      }
    });
  };
}
