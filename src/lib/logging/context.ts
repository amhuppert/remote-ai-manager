/**
 * Request-scoped trace context using AsyncLocalStorage.
 *
 * Provides automatic propagation of trace IDs, action names,
 * and session identifiers through the async call chain without
 * modifying existing function signatures.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

/** Trace context stored per-request in AsyncLocalStorage */
export interface TraceContext {
  traceId: string;
  action?: string;
  projectName?: string;
  sessionName?: string;
  conversationId?: string;
}

const traceStore = new AsyncLocalStorage<TraceContext>();

/**
 * Run a callback within a trace context.
 * All async operations within the callback automatically inherit
 * the trace context via AsyncLocalStorage.
 */
export function runWithTrace<T>(context: TraceContext, fn: () => T): T {
  return traceStore.run(context, fn);
}

/**
 * Read the current trace context.
 * Returns undefined when called outside a traced context
 * (e.g., background cleanup, startup code).
 */
export function getTraceContext(): TraceContext | undefined {
  return traceStore.getStore();
}

/**
 * Snapshot the current trace context for later replay across an async boundary
 * (e.g., capturing a request's trace at dispatch time so a fire-and-forget job
 * can re-enter it via `runAsTrace(..., snapshot)`).
 * Returns `null` when called outside a traced context.
 */
export function captureTraceContext(): TraceContext | null {
  const current = traceStore.getStore();
  return current ? { ...current } : null;
}

/**
 * Run `fn` inside a trace scope. When `inherit` is provided, reuses its
 * `traceId` and identifier fields (replacing `action`); otherwise mints a
 * fresh `traceId`. Use this at every background entrypoint (jobs, pollers,
 * workflow execution, SDK turns, SSE broadcasts) so all `timed()` calls
 * during the unit of work share a `traceId` for hotspot aggregation.
 */
export function runAsTrace<T>(
  action: string,
  fn: () => T,
  inherit?: TraceContext | null,
): T {
  const context: TraceContext = inherit
    ? { ...inherit, action }
    : { traceId: randomUUID(), action };
  return traceStore.run(context, fn);
}
