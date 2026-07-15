/**
 * Typed SSE publication — THE production entry point onto the SSE wire
 * (consolidated plan §3.4 first bullet, Blocker 5 resolved design §5.2.1).
 *
 * One module owns, for every `SSEEvent`:
 *  - the broadcaster adapter (lazily resolved so the transport singleton is
 *    not bootstrapped until first use, with a test override seam),
 *  - per-event tracing under the root `sse:broadcast:<type>` so wire +
 *    subscriber work aggregates per event type in Speedscope,
 *  - the lifecycle projection hook: events in the enumerated lifecycle set
 *    (`lifecycle-projection.ts`) additionally notify in-process
 *    `subscribeLifecycle` subscribers with a scoped envelope; every other
 *    event is wire-only,
 *  - the best-effort mutation policy (`publishEventBestEffort`): a mutation's
 *    follow-up publish must never fail the request.
 *
 * Publication never throws: transport failure yields
 * `{ delivered: false, error }` plus a structured warn.
 *
 * Only this module and the SSE route transport may import the raw
 * broadcaster (architecture-seams/no-raw-broadcaster-import); everything
 * else publishes through here or takes a `PublishFn` via dependency
 * injection.
 */
import type { ScopedStatusEvent, SSEEvent } from "@/lib/api/sse-events";
import { createLogger, runAsTrace, type Logger } from "@/lib/logging";
import {
  createStatusBus,
  type StatusBus,
  type StatusBusDeliveryOutcome,
  type StatusBusLifecycleStatus,
  type StatusBusSubscriber,
} from "./status-bus";
import { projectLifecycle } from "./lifecycle-projection";
import { getErrorMessage } from "@/lib/shared/errors";

const logger = createLogger("sse.publication");

export type PublishOutcome =
  | { delivered: true; error?: never }
  | { delivered: false; error: Error };

/** DI slot for publication — replaces the raw transport's `BroadcastFn` in
 *  deps interfaces so injected fakes report delivery outcomes the same way
 *  production does. */
export type PublishFn = (event: SSEEvent) => PublishOutcome;

let testBroadcastOverride: ((event: SSEEvent) => void) | null = null;
let cachedBus: StatusBus | null = null;

function wireBroadcast(event: SSEEvent): void {
  if (testBroadcastOverride) {
    testBroadcastOverride(event);
    return;
  }
  const sseBroadcaster: { broadcast: (event: SSEEvent) => void } =
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require("@/lib/events/broadcaster");
  sseBroadcaster.broadcast(event);
}

function getBus(): StatusBus {
  if (!cachedBus) {
    // The StatusBus envelope carries the original SSEEvent as `payload`; the
    // wire keeps receiving the raw event (not the envelope) so existing UI
    // consumers keep their on-the-wire contract.
    cachedBus = createStatusBus({
      broadcast: (envelope) => {
        wireBroadcast(envelope.payload as SSEEvent);
      },
      logger,
    });
  }
  return cachedBus;
}

/**
 * The two message-stream events fire once per streamed SDK message on the
 * transcript hot path — the highest-frequency publishers in the system. They
 * are wire-only (no lifecycle projection, no subscriber work to aggregate),
 * so minting a fresh UUID trace root per event would burden the stream loop
 * for no attributable work; they publish without a trace scope (Blocker 5
 * design perf caveat).
 */
const UNTRACED_HOT_PATH_TYPES: ReadonlySet<SSEEvent["type"]> = new Set([
  "message-appended",
  "message-updated",
]);

function deliver(event: SSEEvent): PublishOutcome {
  try {
    const projection = projectLifecycle(event);
    if (projection) {
      const outcome: StatusBusDeliveryOutcome = getBus().publish({
        scope: projection.scope,
        scopeId: projection.scopeId,
        status: projection.status,
        payload: event,
      });
      if (outcome.delivered) return { delivered: true };
      return {
        delivered: false,
        error:
          outcome.error ??
          new Error("Status bus reported failed delivery without an error"),
      };
    }
    wireBroadcast(event);
    return { delivered: true };
  } catch (err) {
    // The projection/envelope path can throw before the bus's own transport
    // guard (e.g. the envelope schema rejects an empty scopeId that a lifecycle
    // source schema still admits), and a runtime caller can construct an event
    // that bypasses static validation. Both must resolve to a delivery
    // outcome, never an escaping throw — publishEvent's "never throws" contract
    // has to hold for schema-valid-shaped events too.
    const error = err instanceof Error ? err : new Error(String(err));
    logger.warn("sse.publication.delivery_failed", {
      eventType: event.type,
      error: error.message,
    });
    return { delivered: false, error };
  }
}

/**
 * Publish an SSE event: fresh root trace `sse:broadcast:<type>` (so wire +
 * subscriber work aggregates per event type regardless of caller), lifecycle
 * projection to in-process subscribers when the event is in the enumerated
 * lifecycle set, then wire broadcast. Never throws.
 */
export function publishEvent(event: SSEEvent): PublishOutcome {
  if (UNTRACED_HOT_PATH_TYPES.has(event.type)) {
    return deliver(event);
  }
  return runAsTrace(`sse:broadcast:${event.type}`, () => deliver(event));
}

export interface PublishEventBestEffortOptions {
  /** Builds the event to publish; runs inside the failure guard so a
   *  schema-validation throw is swallowed alongside a transport throw. */
  build(): SSEEvent;
  logger: Pick<Logger, "warn">;
  /** Structured-log event name emitted when the publish fails. */
  failureEvent: string;
  /** Context fields merged into the failure warn. */
  context: Record<string, unknown>;
  /** Injectable publish fn for DI; defaults to {@link publishEvent}. */
  publish?: PublishFn;
}

/**
 * Best-effort publication for mutations: the state change has already
 * succeeded, so a malformed event or a transport failure must never fail the
 * request. Any failure — a `build()` throw, a `publish` throw, or a
 * `delivered: false` outcome — is swallowed with a `failureEvent` +
 * `context` warn.
 */
export function publishEventBestEffort(
  options: PublishEventBestEffortOptions,
): void {
  const publish = options.publish ?? publishEvent;
  const warnFailure = (error: unknown): void => {
    options.logger.warn(options.failureEvent, {
      ...options.context,
      error: getErrorMessage(error),
    });
  };
  try {
    const outcome = publish(options.build());
    if (!outcome.delivered) {
      warnFailure(
        outcome.error ??
          new Error("Publication reported failed delivery without an error"),
      );
    }
  } catch (err) {
    warnFailure(err);
  }
}

export interface PublishScopedStatusInput {
  scope: string;
  scopeId: string;
  status: StatusBusLifecycleStatus;
  projectName: string;
  sessionName: string;
  payload?: unknown;
  reason?: string;
  timestamp?: string;
}

/**
 * Construct and publish a `scoped-status` SSE event.
 *
 * This is the single entry point feature wiring should use to forward
 * primitive-layer lifecycle envelopes (e.g. Collaboration Mode's
 * `scope: "collaboration"`) onto the shared SSE wire. Centralizing the
 * SSEEvent construction here keeps every primitive-native workflow on the
 * same on-the-wire contract and lets subscribers add scope-specific UI
 * handling without modifying any feature publisher.
 *
 * Contract for new primitive-native workflows:
 *  - Use a dedicated `scope` (e.g. `"collaboration"`) only when the UI
 *    needs to dispatch on it; otherwise reuse the generic `"workflow"`
 *    scope and identify the run via `scopeId`.
 *  - `scopeId` MUST be the durable workflow identifier so subscribers
 *    can correlate updates across rounds/iterations.
 *  - `status` is the canonical lifecycle state
 *    (`running` | `paused` | `completed` | `failed`).
 *  - `reason` is optional and SHOULD be a short tag (e.g.
 *    `"max_iterations_exceeded"`); use it for at-a-glance UI without
 *    parsing the payload.
 *  - `payload` is feature-defined and kept `unknown` on the wire; new
 *    workflows do NOT need a publication change to ship their payload.
 *  - `timestamp` defaults to `new Date().toISOString()` when omitted so
 *    callers don't have to thread a clock; tests inject explicit values.
 */
export function publishScopedStatus(
  input: PublishScopedStatusInput,
): PublishOutcome {
  const event: ScopedStatusEvent = {
    type: "scoped-status",
    scope: input.scope,
    scopeId: input.scopeId,
    status: input.status,
    timestamp: input.timestamp ?? new Date().toISOString(),
    projectName: input.projectName,
    sessionName: input.sessionName,
    ...(input.payload !== undefined ? { payload: input.payload } : {}),
    ...(input.reason !== undefined ? { reason: input.reason } : {}),
  };
  return publishEvent(event);
}

/**
 * Subscribe to in-process lifecycle envelopes (`scope`, `scopeId`, `status`,
 * `timestamp`, `payload`) for events in the enumerated lifecycle set; the
 * wire receives the raw `SSEEvent` payload independently. Returns a handle
 * that unregisters the subscriber when called.
 */
export function subscribeLifecycle(
  subscriber: StatusBusSubscriber,
): () => void {
  return getBus().subscribe(subscriber);
}

/** Override the underlying wire transport for tests. */
export function setPublicationBroadcastForTesting(
  broadcast: (event: SSEEvent) => void,
): void {
  testBroadcastOverride = broadcast;
  cachedBus = null;
}

/** Reset the cached bus and any test override. */
export function _resetPublicationForTesting(): void {
  cachedBus = null;
  testBroadcastOverride = null;
}
