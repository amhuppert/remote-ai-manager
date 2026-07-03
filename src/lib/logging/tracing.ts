/**
 * withTracing — higher-order function wrapping Next.js API route handlers
 * with request-scoped tracing instrumentation.
 *
 * Extracts X-Trace-Id and X-Action from request headers, sets up
 * AsyncLocalStorage trace context, and logs request lifecycle events.
 *
 * Also emits a `Server-Timing: total;dur=<ms>` response header so the
 * browser's Network panel (and `tracedFetch` on the client) can read the
 * server-side duration without an extra round trip.
 *
 * SSE responses (`content-type: text/event-stream`) are tagged with
 * `streaming: true` and `durationMs: null` so connection lifetime never
 * dominates the slow-request sort — per-message timing for SSE lives in
 * `sse-broadcaster.ts`.
 */

import { randomUUID } from "node:crypto";
import { runWithTrace, type TraceContext } from "./context";
import { getErrorMessage } from "@/lib/shared/errors";
import { createLogger } from "./logger";

const logger = createLogger("tracing");

const DEFAULT_SLOW_REQUEST_MS = 500;
let cachedSlowRequestMs: number | undefined;

function getSlowRequestMs(): number {
  if (cachedSlowRequestMs === undefined) {
    const raw = process.env["CC_REQUEST_SLOW_MS"];
    const parsed = raw ? Number.parseInt(raw, 10) : NaN;
    cachedSlowRequestMs =
      Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_SLOW_REQUEST_MS;
  }
  return cachedSlowRequestMs;
}

/** Reset cached env-var reads (testing only). */
export function _resetTracingForTesting(): void {
  cachedSlowRequestMs = undefined;
}

function isStreamingResponse(response: Response): boolean {
  const contentType = response.headers.get("content-type") ?? "";
  return contentType.startsWith("text/event-stream");
}

/** Catch-all segments ([...slug]) resolve to string[]; plain segments to string. */
type RouteParams = Record<string, string | string[]>;

type RouteContext = { params: Promise<RouteParams> };

/**
 * Default for unannotated inline handlers: plain-segment routes only see
 * string params, so their contextual type stays string-valued. Catch-all
 * routes annotate their context and infer C from the annotation instead.
 */
type DefaultRouteContext = { params: Promise<Record<string, string>> };

/**
 * Wrap a Next.js API route handler with tracing instrumentation.
 *
 * - Extracts X-Trace-Id from request header (generates UUID if absent)
 * - Extracts X-Action from request header
 * - Extracts projectName/sessionName from URL params (keys "name" and "session")
 * - Initializes ALS trace context for handler duration
 * - Logs request start (info) and completion (info / warn by duration; debug for SSE)
 * - Adds X-Trace-Id and Server-Timing to response header
 * - Catches unhandled errors, logs with full context, re-throws
 */
export function withTracing<
  C extends RouteContext | undefined = DefaultRouteContext,
>(
  handler: (request: Request, context: C) => Promise<Response>,
): (request: Request, context: C) => Promise<Response> {
  return async (request, context) => {
    const start = Date.now();
    const url = new URL(request.url);

    // Extract trace headers
    const traceId = request.headers.get("x-trace-id") ?? randomUUID();
    const action = request.headers.get("x-action") ?? undefined;

    // Extract project/session/conversation from URL params if available
    let projectName: string | undefined;
    let sessionName: string | undefined;
    let conversationId: string | undefined;
    try {
      const params: RouteParams = context ? await context.params : {};
      const nameParam = params["name"];
      projectName = typeof nameParam === "string" ? nameParam : undefined;
      const sessionParam = params["session"];
      sessionName =
        typeof sessionParam === "string" && sessionParam !== ""
          ? decodeURIComponent(sessionParam)
          : undefined;
      const conversationParam = params["conversationId"];
      conversationId =
        typeof conversationParam === "string" && conversationParam !== ""
          ? decodeURIComponent(conversationParam)
          : undefined;
    } catch {
      // No params or params resolution failed — not all routes have params
    }

    const traceContext: TraceContext = {
      traceId,
      action,
      projectName,
      sessionName,
      conversationId,
    };

    return runWithTrace(traceContext, async () => {
      logger.info("request.start", {
        method: request.method,
        path: url.pathname,
      });

      try {
        const response = await handler(request, context);

        const durationMs = Date.now() - start;
        const streaming = isStreamingResponse(response);

        if (streaming) {
          logger.debug("request.complete", {
            method: request.method,
            path: url.pathname,
            status: response.status,
            streaming: true,
            durationMs: null,
          });
        } else {
          const level = durationMs >= getSlowRequestMs() ? "warn" : "info";
          const completeFields = {
            method: request.method,
            path: url.pathname,
            status: response.status,
            durationMs,
          };
          if (level === "warn") {
            logger.warn("request.complete", completeFields);
          } else {
            logger.info("request.complete", completeFields);
          }
          response.headers.set("Server-Timing", `total;dur=${durationMs}`);
        }

        // Add trace ID to response headers
        response.headers.set("x-trace-id", traceId);
        return response;
      } catch (err) {
        const durationMs = Date.now() - start;
        logger.error("request.error", {
          method: request.method,
          path: url.pathname,
          durationMs,
          error: getErrorMessage(err),
          stack: err instanceof Error ? err.stack : undefined,
        });
        throw err;
      }
    });
  };
}
