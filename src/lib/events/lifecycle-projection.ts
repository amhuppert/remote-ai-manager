/**
 * Lifecycle projection — the closed, exhaustively-typed mapping from SSE
 * events to in-process lifecycle envelopes (consolidated plan §3.4, Blocker 5
 * resolved design §5.2.2).
 *
 * Only the events enumerated in {@link LIFECYCLE_EVENT_TYPES} project to a
 * lifecycle envelope; every other `SSEEvent` is wire-only and returns `null`.
 * There is deliberately NO fallback that manufactures a
 * `conversation/unknown/running` envelope for unrecognized events — scope
 * resolution by post-hoc inference over an open union cannot be correct, so
 * an event either has an explicit projection here or none at all.
 *
 * Inclusion criterion: the event reports the state of a durable unit of work
 * with a non-manufactured status mapping. The two `debug-*` events are
 * retained solely because the debug-adapter and section-6-2 parity suites pin
 * `scope: "debug"` envelopes protecting the debug-eviction migration; when
 * those parity pins retire, drop `debug-log-received` (pure activity) from
 * the set.
 */
import type { SSEEvent, ScopedStatusEvent } from "@/lib/api/sse-events";
import type { DevServerStatusEvent } from "@/lib/dev-server/schemas";
import type { JobStatusEvent } from "@/lib/jobs/schemas";
import { createLogger } from "@/lib/logging";
import { assertNever } from "@/lib/shared/assert-never";
import type { StatusBusLifecycleStatus } from "./status-bus";

const logger = createLogger("sse.lifecycle-projection");

export const LIFECYCLE_EVENT_TYPES = [
  "conversation-status",
  "ask-question",
  "job-status",
  "dev-server-status",
  "debug-mode-status",
  "debug-log-received",
  "scoped-status",
] as const;

export type LifecycleEventType = (typeof LIFECYCLE_EVENT_TYPES)[number];

export type LifecycleSSEEvent = Extract<SSEEvent, { type: LifecycleEventType }>;

/**
 * Scopes the lifecycle projection produces.
 *
 * The feature scopes (`conversation`, `debug`, `graph_workflow`, `merge_job`,
 * `dev-server`) are derived from each feature's typed SSE event. The
 * scoped-status scopes (`collaboration`, `workflow`, `notification`) are
 * carried directly on the wire via the `scoped-status` SSE event so
 * primitive-native workflows can publish lifecycle status without defining a
 * feature-specific SSE event.
 *
 * `collaboration` is the dedicated scope for Collaboration Mode runs.
 * `workflow` is the generic catch-all for future primitive-native workflows
 * (`scopeId` = workflow id, `status` = lifecycle state). New primitive-native
 * workflows SHOULD reuse the `workflow` scope unless they have UI semantics
 * that justify a dedicated scope name.
 */
export type LifecycleScope =
  | "conversation"
  | "debug"
  | "merge_job"
  | "notification"
  | "collaboration"
  | "workflow"
  | "dev-server";

export interface LifecycleProjection {
  scope: LifecycleScope;
  scopeId: string;
  status: StatusBusLifecycleStatus;
}

const LIFECYCLE_EVENT_TYPE_SET: ReadonlySet<string> = new Set(
  LIFECYCLE_EVENT_TYPES,
);

function isLifecycleEvent(event: SSEEvent): event is LifecycleSSEEvent {
  return LIFECYCLE_EVENT_TYPE_SET.has(event.type);
}

function mapConversationStatus(
  status: "running" | "awaiting" | "waiting_for_input",
): StatusBusLifecycleStatus {
  switch (status) {
    case "running":
      return "running";
    case "awaiting":
    case "waiting_for_input":
      return "paused";
    default:
      return assertNever(status);
  }
}

function mapJobStatus(
  status: JobStatusEvent["status"],
): StatusBusLifecycleStatus {
  switch (status) {
    case "running":
      return "running";
    case "conflicts":
    case "ready-to-land":
      return "paused";
    case "completed":
    case "discarded":
      return "completed";
    case "failed":
      return "failed";
    default:
      return assertNever(status);
  }
}

function mapDevServerStatus(
  status: DevServerStatusEvent["status"],
): StatusBusLifecycleStatus {
  switch (status) {
    case "starting":
    case "running":
      return "running";
    case "stopped":
      return "completed";
    case "error":
      return "failed";
    default:
      return assertNever(status);
  }
}

const SCOPED_STATUS_RECOGNIZED_SCOPES: ReadonlySet<LifecycleScope> = new Set([
  "conversation",
  "debug",
  "merge_job",
  "notification",
  "collaboration",
  "workflow",
  "dev-server",
] satisfies LifecycleScope[]);

/**
 * `ScopedStatusEvent.scope` is an open string on the wire (additive scopes by
 * design); the projection narrows to the recognized set so it never produces
 * a scope outside the documented union. Unknown scopes fall back to the
 * generic `workflow` scope with a structured warn so a typo'd scope from a
 * future primitive-native workflow is observable.
 */
function narrowScopedStatusScope(event: ScopedStatusEvent): LifecycleScope {
  if (SCOPED_STATUS_RECOGNIZED_SCOPES.has(event.scope as LifecycleScope)) {
    return event.scope as LifecycleScope;
  }
  logger.warn("sse.lifecycle_projection.unknown_scope", {
    scope: event.scope,
    scopeId: event.scopeId,
    status: event.status,
  });
  return "workflow";
}

/**
 * Project an SSE event to its lifecycle envelope fields, or `null` for
 * wire-only events. The switch is exhaustive over {@link LifecycleSSEEvent}
 * (`assertNever`), so adding a type to {@link LIFECYCLE_EVENT_TYPES} without
 * a projection is a compile error.
 */
export function projectLifecycle(event: SSEEvent): LifecycleProjection | null {
  if (!isLifecycleEvent(event)) return null;
  switch (event.type) {
    case "conversation-status":
      return {
        scope: "conversation",
        scopeId: event.conversationId,
        status: mapConversationStatus(event.status),
      };
    case "ask-question":
      return {
        scope: "conversation",
        scopeId: event.conversationId,
        status: "paused",
      };
    case "job-status":
      return {
        scope: "merge_job",
        scopeId: event.jobId,
        status: mapJobStatus(event.status),
      };
    case "dev-server-status":
      return {
        scope: "dev-server",
        scopeId:
          event.scope === "project"
            ? `${event.projectName}/${event.serverName}`
            : `${event.projectName}/${event.sessionName}/${event.serverName}`,
        status: mapDevServerStatus(event.status),
      };
    case "debug-mode-status":
    case "debug-log-received":
      return {
        scope: "debug",
        scopeId: event.conversationId,
        status: "running",
      };
    case "scoped-status":
      return {
        scope: narrowScopedStatusScope(event),
        scopeId: event.scopeId,
        status: event.status,
      };
    default:
      return assertNever(event);
  }
}
