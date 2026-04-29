/**
 * StatusBus primitive.
 *
 * Publishes scoped live status events over the existing in-process broadcast
 * transport without redefining feature payload schemas. Every published event
 * shares a small outer envelope (`scope`, `scopeId`, `status`, `timestamp`,
 * `payload`) so subscribers can filter by scope while feature adapters keep
 * their existing fine-grained payload shapes (conversation status, graph
 * workflow context status, validation result, merge job status, etc.).
 *
 * Design constraints from the composable workflow primitives spec:
 *  - The bus wraps, but does not replace, `sse-broadcaster`. The broadcast
 *    function is injected so this primitive remains delivery-only and stays
 *    decoupled from any specific transport singleton.
 *  - Status delivery failures must be observable via structured logs but must
 *    not corrupt the owning workflow's state, so `publish` never throws when
 *    the underlying transport throws — it logs and reports the delivery
 *    outcome instead.
 *  - Feature payloads pass through unchanged so existing UI consumers keep
 *    receiving the granular event detail they already depend on.
 */

import { z } from "zod";

export const STATUS_BUS_LIFECYCLE_STATUSES = [
  "running",
  "paused",
  "completed",
  "failed",
] as const;

export const statusBusLifecycleStatusSchema = z.enum(
  STATUS_BUS_LIFECYCLE_STATUSES,
);
export type StatusBusLifecycleStatus = z.infer<
  typeof statusBusLifecycleStatusSchema
>;

export const statusBusEnvelopeSchema = z.object({
  scope: z.string().min(1),
  scopeId: z.string().min(1),
  status: statusBusLifecycleStatusSchema,
  timestamp: z.string().min(1),
  payload: z.unknown(),
});
export type StatusBusEnvelope = z.infer<typeof statusBusEnvelopeSchema>;

export interface StatusBusPublishInput {
  scope: string;
  scopeId: string;
  status: StatusBusLifecycleStatus;
  payload: unknown;
}

export interface StatusBusDeliveryOutcome {
  delivered: boolean;
  error?: Error;
}

export type StatusBusBroadcastFn = (event: StatusBusEnvelope) => void;

export type StatusBusSubscriber = (envelope: StatusBusEnvelope) => void;

export interface StatusBusLogger {
  warn(event: string, fields: Record<string, unknown>): void;
}

export interface StatusBusDeps {
  broadcast: StatusBusBroadcastFn;
  now?: () => string;
  logger?: StatusBusLogger;
}

export interface StatusBus {
  publish(input: StatusBusPublishInput): StatusBusDeliveryOutcome;
  /**
   * Register an in-process subscriber that receives the full scoped envelope
   * (`scope`, `scopeId`, `status`, `timestamp`, `payload`). Subscribers are
   * notified independently of wire delivery: a wire failure does not suppress
   * subscriber notification, and a subscriber failure does not suppress wire
   * delivery or other subscribers. Returns a handle that unregisters the
   * subscriber when called.
   */
  subscribe(subscriber: StatusBusSubscriber): () => void;
}

const noopLogger: StatusBusLogger = {
  warn: () => {},
};

function describePayloadShape(payload: unknown): string {
  if (payload === null || payload === undefined) return typeof payload;
  if (Array.isArray(payload)) return "array";
  if (typeof payload !== "object") return typeof payload;
  const typeField = (payload as { type?: unknown }).type;
  if (typeof typeField === "string" && typeField.length > 0) {
    return `object:${typeField}`;
  }
  return "object";
}

export function createStatusBus(deps: StatusBusDeps): StatusBus {
  const now = deps.now ?? (() => new Date().toISOString());
  const logger = deps.logger ?? noopLogger;
  const broadcast = deps.broadcast;
  const subscribers = new Set<StatusBusSubscriber>();

  function notifySubscribers(envelope: StatusBusEnvelope): void {
    for (const subscriber of subscribers) {
      try {
        subscriber(envelope);
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        logger.warn("status-bus.subscriber_failed", {
          scope: envelope.scope,
          scopeId: envelope.scopeId,
          status: envelope.status,
          payloadShape: describePayloadShape(envelope.payload),
          error: error.message,
        });
      }
    }
  }

  return {
    publish(input) {
      const envelope: StatusBusEnvelope = statusBusEnvelopeSchema.parse({
        scope: input.scope,
        scopeId: input.scopeId,
        status: input.status,
        timestamp: now(),
        payload: input.payload,
      });

      notifySubscribers(envelope);

      try {
        broadcast(envelope);
        return { delivered: true };
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        logger.warn("status-bus.delivery_failed", {
          scope: envelope.scope,
          scopeId: envelope.scopeId,
          status: envelope.status,
          payloadShape: describePayloadShape(envelope.payload),
          error: error.message,
        });
        return { delivered: false, error };
      }
    },
    subscribe(subscriber) {
      subscribers.add(subscriber);
      return () => {
        subscribers.delete(subscriber);
      };
    },
  };
}
