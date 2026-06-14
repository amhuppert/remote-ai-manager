/**
 * Best-effort SSE event broadcast for route handlers.
 *
 * Lifecycle mutations publish a dedicated SSE event after the underlying state
 * change has already succeeded, so a malformed event or a broadcast failure
 * must never fail the request. This helper builds the event and broadcasts it
 * inside one try/catch, swallowing any failure with a structured warn. The
 * `build` thunk runs inside the guard so a schema-validation throw is caught
 * alongside a transport throw.
 */

import type { Logger } from "@/lib/logging";
import type { SSEEvent } from "@/lib/api/sse-events";
import type { BroadcastFn } from "./broadcaster";

export interface BroadcastEventOptions {
  broadcast: BroadcastFn;
  /** Builds the event to broadcast; runs inside the failure guard. */
  build(): SSEEvent;
  logger: Pick<Logger, "warn">;
  /** Structured-log event name emitted when the broadcast fails. */
  failureEvent: string;
  /** Context fields merged into the failure warn. */
  context: Record<string, unknown>;
}

export function broadcastEvent(options: BroadcastEventOptions): void {
  try {
    options.broadcast(options.build());
  } catch (err) {
    options.logger.warn(options.failureEvent, {
      ...options.context,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
