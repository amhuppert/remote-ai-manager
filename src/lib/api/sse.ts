/**
 * Client-side SSE transport: the one sanctioned way to attach typed listeners
 * to the shared `/api/events` EventSource.
 *
 * Every frame on the wire carries the broadcaster's transport envelope
 * (`_sentAt` stamp — see `@/lib/events/sse-envelope`). `addSseListener` strips
 * the envelope via `parseSseEventData` before schema validation; several
 * domain event schemas are `.strict()` and would silently reject a stamped
 * frame, dropping the event and leaving the UI stale for the whole turn.
 *
 * SSE reactions are best-effort by contract: a malformed frame or a throwing
 * handler must never break the shared EventSource dispatch for other
 * listeners, so failures are swallowed here in one place instead of in
 * per-domain try/catch blocks.
 */

import type { z } from "zod";
import { getErrorMessage } from "@/lib/shared/errors";
import {
  createClientLogger,
  type ClientLogger,
} from "@/lib/logging/client-logger";
import {
  parseSseEventData,
  readSseEnvelopeSentAt,
} from "@/lib/events/sse-envelope";

const defaultLogger = createClientLogger("api.sse");

/**
 * The narrow slice of `EventSource` this transport actually consumes: the
 * ability to register a per-type message listener (and, for
 * {@link instrumentSseEventSource}, to reassign that method to wrap it). A real
 * `EventSource` satisfies this structurally, so production callers pass one
 * unchanged; a test double can implement this port directly instead of forcing
 * an `as unknown as EventSource` cast.
 */
export interface SseEventTarget {
  addEventListener(type: string, listener: (event: MessageEvent) => void): void;
}

/**
 * Registers a schema-validated listener for one SSE event type. The handler
 * only ever sees payloads that parsed against `schema`; malformed frames,
 * schema mismatches, and handler throws are dropped so a bad frame never
 * breaks the shared EventSource dispatch for other listeners.
 *
 * A dropped frame is not silent: each failure path emits a structured,
 * payload-free warn (event type + failure reason only — never the frame body,
 * which can carry conversation content) so stale-client incidents stay
 * traceable (data-fetching-and-sse steering §"invalid frames are logged and
 * dropped"). The logger is injectable for tests; production uses the module
 * client logger.
 */
export function addSseListener<T>(
  es: SseEventTarget,
  type: string,
  schema: z.ZodType<T>,
  handler: (data: T) => void,
  logger: ClientLogger = defaultLogger,
): void {
  es.addEventListener(type, (event: MessageEvent) => {
    let parsedData: unknown;
    try {
      parsedData = parseSseEventData(event.data);
    } catch {
      logger.warn("sse.frame_parse_failed", { eventType: type });
      return;
    }

    const parsed = schema.safeParse(parsedData);
    if (!parsed.success) {
      logger.warn("sse.frame_schema_rejected", {
        eventType: type,
        issueCount: parsed.error.issues.length,
      });
      return;
    }

    try {
      handler(parsed.data);
    } catch (err) {
      logger.warn("sse.handler_failed", {
        eventType: type,
        error: getErrorMessage(err),
      });
    }
  });
}

/**
 * SSE per-message instrumentation. The broadcaster embeds `_sentAt` in every
 * event envelope so we can compute transportMs (sentAt→received wall-clock
 * delta — clock-skew sensitive) and handlerMs (cache invalidation / store
 * mutation cost) per message. Wrapped at the EventSource layer so every
 * listener picks it up without modification.
 */
const SSE_LOG_HANDLER_MS_THRESHOLD = 1;
const SSE_LOG_TRANSPORT_MS_THRESHOLD = 50;

export function instrumentSseEventSource(es: SseEventTarget): void {
  const originalAdd = es.addEventListener.bind(es);
  const instrumentedAdd = ((
    type: string,
    listener: (event: MessageEvent) => void,
  ) => {
    const wrapped = (event: MessageEvent) => {
      const sentAt = readSseEnvelopeSentAt(event.data);
      const start = performance.now();
      try {
        listener(event);
      } finally {
        const handlerMs = Math.round(performance.now() - start);
        const transportMs = sentAt != null ? Date.now() - sentAt : null;
        if (
          handlerMs >= SSE_LOG_HANDLER_MS_THRESHOLD ||
          (transportMs != null && transportMs >= SSE_LOG_TRANSPORT_MS_THRESHOLD)
        ) {
          console.debug("sse.message", {
            eventType: type,
            transportMs,
            handlerMs,
          });
        }
      }
    };
    originalAdd(type, wrapped as EventListener);
  }) as typeof es.addEventListener;
  es.addEventListener = instrumentedAdd;
}
