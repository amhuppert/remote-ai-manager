/**
 * Default singleton SessionStatusBus wired to the production sse-broadcaster.
 *
 * This module exposes `publishSessionStatus(event)` as the migration entry
 * point for existing call sites that previously imported `broadcast` from
 * `@/lib/sse-broadcaster` directly. Routing through the bus gives in-process
 * primitive subscribers (StatusBus subscribers) a coherent scope envelope per
 * event while keeping the on-the-wire SSEEvent payload unchanged so existing
 * UI consumers still receive the granular event detail they depend on.
 *
 * The underlying broadcast function is lazily resolved via require() to mirror
 * the existing dynamic-import deferral patterns in conversation-manager and
 * workflows/actions, which avoid bootstrapping the broadcaster until first
 * use.
 */
import type { ScopedStatusEvent, SSEEvent } from "@/types";
import { createLogger } from "@/lib/logging";
import {
  createSessionStatusBus,
  publishScopedStatus,
  type SessionStatusBus,
} from "./session-status-bus";
import type {
  StatusBusDeliveryOutcome,
  StatusBusLifecycleStatus,
  StatusBusSubscriber,
} from "./status-bus";

const logger = createLogger("session-status-bus");

let cachedBus: SessionStatusBus | null = null;
let testBroadcastOverride: ((event: SSEEvent) => void) | null = null;

function defaultBroadcast(event: SSEEvent): void {
  if (testBroadcastOverride) {
    testBroadcastOverride(event);
    return;
  }
  const sseBroadcaster: { broadcast: (event: SSEEvent) => void } =
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require("@/lib/sse-broadcaster");
  sseBroadcaster.broadcast(event);
}

function getDefaultSessionStatusBus(): SessionStatusBus {
  if (!cachedBus) {
    cachedBus = createSessionStatusBus({
      broadcast: defaultBroadcast,
      logger,
    });
  }
  return cachedBus;
}

export function publishSessionStatus(
  event: SSEEvent,
): StatusBusDeliveryOutcome {
  return publishScopedStatus(event, { bus: getDefaultSessionStatusBus() });
}

export interface PublishScopedStatusEventInput {
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
 * Publish a `scoped-status` SSE event through the default session status bus.
 *
 * This is the single entry point feature wiring should use to forward
 * primitive-layer `StatusBus` envelopes (e.g. those emitted by the
 * Collaboration Mode slice with `scope: "collaboration"`) onto the shared
 * SSE wire. Centralizing the SSEEvent construction here keeps every
 * primitive-native workflow on the same on-the-wire contract and lets
 * subscribers add scope-specific UI handling without modifying any
 * feature publisher.
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
 *    workflows do NOT need an adapter extension to ship their payload.
 *  - `timestamp` defaults to `new Date().toISOString()` when omitted so
 *    callers don't have to thread a clock; tests inject explicit values.
 */
export function publishScopedStatusEvent(
  input: PublishScopedStatusEventInput,
): StatusBusDeliveryOutcome {
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
  return publishSessionStatus(event);
}

/**
 * Subscribe to scoped status envelopes published through the default session
 * status bus. The subscriber receives the full envelope (`scope`, `scopeId`,
 * `status`, `timestamp`, `payload`); the wire continues to receive the raw
 * `SSEEvent` payload independently. Returns a handle that unregisters the
 * subscriber when called.
 */
export function subscribeSessionStatus(
  subscriber: StatusBusSubscriber,
): () => void {
  return getDefaultSessionStatusBus().subscribe(subscriber);
}

/** Override the underlying wire transport for tests. */
export function setDefaultSessionStatusBusBroadcastForTesting(
  broadcast: (event: SSEEvent) => void,
): void {
  testBroadcastOverride = broadcast;
  cachedBus = null;
}

/** Reset the cached bus and any test override. */
export function _resetDefaultSessionStatusBusForTesting(): void {
  cachedBus = null;
  testBroadcastOverride = null;
}
