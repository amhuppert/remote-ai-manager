/**
 * Request-scoped trace context using AsyncLocalStorage.
 *
 * Provides automatic propagation of trace IDs, action names,
 * and session identifiers through the async call chain without
 * modifying existing function signatures.
 */

import { AsyncLocalStorage } from "node:async_hooks";

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
