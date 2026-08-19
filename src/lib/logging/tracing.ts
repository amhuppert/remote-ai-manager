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
import type { ApiError } from "@/lib/api/errors";
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

export interface WithTracingOptions {
  /**
   * Map a thrown error to a domain-shaped error Response (e.g. a 409 with a
   * domain code). Return undefined to fall through to the generic
   * `internal_error` 500 envelope.
   */
  mapError?(error: unknown): Response | undefined;
  /**
   * The handler may deliberately hold the request open until server state
   * changes. Its duration then measures the caller's chosen wait budget, not
   * server work, so it must never escalate to the slow-request warning that
   * latency analysis over the request log depends on.
   */
  longPoll?: boolean;
}

/**
 * Marker stamped on every handler `withTracing` returns. A route export cannot
 * be statically proven wrapped — most route shells re-export a handler wrapped
 * inside a lib module — so the architecture test that asserts every API route
 * export went through the tracing net checks for this symbol at runtime instead
 * (`route-tracing.architecture.test.ts`). The property is non-enumerable and
 * symbol-keyed, so it is invisible to JSON, spreads, and `for..in` — it changes
 * nothing about how the handler runs.
 */
export const WITH_TRACING_MARKER: unique symbol = Symbol(
  "cc.logging.withTracing.wrapped",
);

/**
 * True when `value` is a handler produced by `withTracing` (carries the
 * `WITH_TRACING_MARKER`). Narrow enough that an ordinary function — even one
 * that merely calls a wrapped handler — is not mistaken for a wrapped one.
 */
export function isWithTracingWrapped(value: unknown): boolean {
  return (
    typeof value === "function" &&
    (value as unknown as { [WITH_TRACING_MARKER]?: unknown })[
      WITH_TRACING_MARKER
    ] === true
  );
}

function buildErrorResponse(
  err: unknown,
  mapError: WithTracingOptions["mapError"],
): Response {
  if (mapError) {
    try {
      const mapped = mapError(err);
      if (mapped) return mapped;
    } catch (mapperErr) {
      logger.warn("request.error_mapper_failed", {
        error: getErrorMessage(mapperErr),
      });
    }
  }
  const envelope: ApiError = {
    error: getErrorMessage(err),
    code: "internal_error",
  };
  return Response.json(envelope, { status: 500 });
}

/**
 * Wrap a Next.js API route handler with tracing instrumentation.
 *
 * - Extracts X-Trace-Id from request header (generates UUID if absent)
 * - Extracts X-Action from request header
 * - Extracts projectName/sessionName from URL params (keys "name" and "session")
 * - Initializes ALS trace context for handler duration
 * - Logs request start (info) and completion (info / warn by duration; debug for SSE)
 * - Adds X-Trace-Id and Server-Timing to response header
 * - Catches unhandled errors, logs with full context, and returns a shaped
 *   `ApiError` envelope: the per-domain `mapError` response when one is
 *   supplied and matches, otherwise a generic `internal_error` 500
 */
export function withTracing<
  C extends RouteContext | undefined = DefaultRouteContext,
>(
  handler: (request: Request, context: C) => Promise<Response>,
  options?: WithTracingOptions,
): (request: Request, context: C) => Promise<Response> {
  const wrapped = async (request: Request, context: C): Promise<Response> => {
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
      requestPath: url.pathname,
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
          const longPoll = options?.longPoll === true;
          const level =
            !longPoll && durationMs >= getSlowRequestMs() ? "warn" : "info";
          const completeFields = {
            method: request.method,
            path: url.pathname,
            status: response.status,
            durationMs,
            ...(longPoll ? { longPoll: true } : {}),
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
        const errorResponse = buildErrorResponse(err, options?.mapError);
        logger.error("request.error", {
          method: request.method,
          path: url.pathname,
          status: errorResponse.status,
          durationMs,
          error: getErrorMessage(err),
          stack: err instanceof Error ? err.stack : undefined,
        });
        errorResponse.headers.set("x-trace-id", traceId);
        return errorResponse;
      }
    });
  };

  // Stamp the wrapper so the architecture test can prove, at runtime, that this
  // export went through tracing. Non-enumerable + symbol-keyed keeps it out of
  // every normal property view; the handler behaves exactly as before.
  Object.defineProperty(wrapped, WITH_TRACING_MARKER, {
    value: true,
    enumerable: false,
    writable: false,
    configurable: false,
  });
  return wrapped;
}
