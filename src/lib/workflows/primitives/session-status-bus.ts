/**
 * SessionStatusBus — adapter that wires the generic StatusBus primitive to the
 * existing per-session SSE broadcast wire.
 *
 * The primitive bus ({@link createStatusBus}) exposes a typed envelope shape
 * (`scope`, `scopeId`, `status`, `timestamp`, `payload`) for in-process
 * subscribers. CC's UI consumers, however, already speak raw `SSEEvent`s
 * (conversation-status, graph-workflow-task-status, job-status, etc.) and the
 * existing transport in `sse-broadcaster.ts` also accepts `SSEEvent`. To
 * preserve the on-the-wire contract that consumers depend on, this adapter
 * forwards `envelope.payload` (i.e. the original `SSEEvent`) to the broadcast
 * wire rather than the envelope itself.
 *
 * `resolveSessionStatusScope` derives the scope, scopeId, and lifecycle status
 * from a known SSE event, so feature publishers can keep emitting their
 * fine-grained event schemas while the primitive layer assigns a coherent
 * scope envelope around each one.
 */
import type { SSEEvent } from "@/types";
import {
  createStatusBus,
  type StatusBus,
  type StatusBusBroadcastFn,
  type StatusBusDeliveryOutcome,
  type StatusBusEnvelope,
  type StatusBusLifecycleStatus,
  type StatusBusLogger,
} from "./status-bus";

/**
 * Scopes the session-level SSE adapter recognizes.
 *
 * The legacy feature scopes (`conversation`, `debug`, `graph_workflow`,
 * `merge_job`, `notification`) are derived by `resolveSessionStatusScope`
 * from each feature's typed SSE event. The two scoped-status scopes
 * (`collaboration`, `workflow`) are carried directly on the wire via
 * the `scoped-status` SSE event so primitive-native workflows can
 * publish lifecycle/status without having to define a feature-specific
 * SSE event for each one.
 *
 * `collaboration` is the dedicated scope for Collaboration Mode runs.
 * `workflow` is the generic catch-all for future primitive-native
 * workflows that publish lifecycle status through the same envelope
 * shape (`scopeId` = workflow id, `status` = lifecycle state, optional
 * `reason` tag, free-form `payload`). New primitive-native workflows
 * SHOULD reuse the `workflow` scope unless they have UI semantics that
 * justify a dedicated scope name.
 */
export type SessionStatusScope =
  | "conversation"
  | "debug"
  | "graph_workflow"
  | "merge_job"
  | "notification"
  | "collaboration"
  | "workflow"
  | "dev-server";

export interface SessionStatusScopeResolution {
  scope: SessionStatusScope;
  scopeId: string;
  status: StatusBusLifecycleStatus;
}

const FALLBACK_SCOPE_ID = "unknown";

function pickString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function mapConversationStatus(raw: unknown): StatusBusLifecycleStatus {
  if (raw === "running") return "running";
  if (raw === "awaiting" || raw === "waiting_for_input") return "paused";
  return "running";
}

function mapJobStatus(raw: unknown): StatusBusLifecycleStatus {
  if (raw === "completed") return "completed";
  if (raw === "failed") return "failed";
  if (raw === "conflicts") return "paused";
  return "running";
}

function mapGraphWorkflowStatus(raw: unknown): StatusBusLifecycleStatus {
  if (raw === "completed") return "completed";
  if (raw === "failed") return "failed";
  if (raw === "halted" || raw === "paused") return "paused";
  return "running";
}

function mapTaskStatus(raw: unknown): StatusBusLifecycleStatus {
  if (raw === "completed") return "completed";
  if (raw === "failed") return "failed";
  if (raw === "skipped") return "completed";
  if (raw === "paused" || raw === "blocked") return "paused";
  return "running";
}

const SCOPED_STATUS_RECOGNIZED_SCOPES: ReadonlySet<SessionStatusScope> =
  new Set([
    "conversation",
    "debug",
    "graph_workflow",
    "merge_job",
    "notification",
    "collaboration",
    "workflow",
    "dev-server",
  ]);

function mapDevServerStatus(raw: unknown): StatusBusLifecycleStatus {
  if (raw === "running") return "running";
  if (raw === "starting") return "running";
  if (raw === "stopped") return "completed";
  if (raw === "error") return "failed";
  return "running";
}

function narrowScopedStatusScope(raw: unknown): SessionStatusScope {
  if (
    typeof raw === "string" &&
    SCOPED_STATUS_RECOGNIZED_SCOPES.has(raw as SessionStatusScope)
  ) {
    return raw as SessionStatusScope;
  }
  return "workflow";
}

function narrowLifecycleStatus(raw: unknown): StatusBusLifecycleStatus {
  if (
    raw === "running" ||
    raw === "paused" ||
    raw === "completed" ||
    raw === "failed"
  ) {
    return raw;
  }
  return "running";
}

export function resolveSessionStatusScope(
  event: SSEEvent | { type: string; [key: string]: unknown },
): SessionStatusScopeResolution {
  const e = event as { type: string; [key: string]: unknown };
  switch (e.type) {
    case "conversation-status": {
      return {
        scope: "conversation",
        scopeId: pickString(e.conversationId) ?? FALLBACK_SCOPE_ID,
        status: mapConversationStatus(e.status),
      };
    }
    case "ask-question": {
      return {
        scope: "conversation",
        scopeId: pickString(e.conversationId) ?? FALLBACK_SCOPE_ID,
        status: "paused",
      };
    }
    case "message-queued": {
      return {
        scope: "conversation",
        scopeId: pickString(e.conversationId) ?? FALLBACK_SCOPE_ID,
        status: "running",
      };
    }
    case "debug-mode-status":
    case "debug-log-received": {
      return {
        scope: "debug",
        scopeId: pickString(e.conversationId) ?? FALLBACK_SCOPE_ID,
        status: "running",
      };
    }
    case "graph-workflow-status": {
      return {
        scope: "graph_workflow",
        scopeId: pickString(e.executionId) ?? FALLBACK_SCOPE_ID,
        status: mapGraphWorkflowStatus(e.workflowStatus),
      };
    }
    case "graph-workflow-context-status": {
      return {
        scope: "graph_workflow",
        scopeId: pickString(e.executionId) ?? FALLBACK_SCOPE_ID,
        status: "running",
      };
    }
    case "graph-workflow-task-status": {
      return {
        scope: "graph_workflow",
        scopeId: pickString(e.executionId) ?? FALLBACK_SCOPE_ID,
        status: mapTaskStatus(e.status),
      };
    }
    case "graph-workflow-validation-result":
    case "graph-workflow-circuit-breaker":
    case "graph-workflow-shared-documents-updated": {
      return {
        scope: "graph_workflow",
        scopeId: pickString(e.executionId) ?? FALLBACK_SCOPE_ID,
        status: "running",
      };
    }
    case "job-status": {
      const scopeId = pickString(e.jobId) ?? FALLBACK_SCOPE_ID;
      return {
        scope: "merge_job",
        scopeId,
        status: mapJobStatus(e.status),
      };
    }
    case "session-finished": {
      const scopeId =
        pickString(e.branchName) ??
        pickString(e.sessionName) ??
        FALLBACK_SCOPE_ID;
      return {
        scope: "merge_job",
        scopeId,
        status: "completed",
      };
    }
    case "notification-created": {
      const notification = (e.notification ?? {}) as { id?: unknown };
      return {
        scope: "notification",
        scopeId: pickString(notification.id) ?? FALLBACK_SCOPE_ID,
        status: "completed",
      };
    }
    case "notification-updated": {
      return {
        scope: "notification",
        scopeId: pickString(e.id) ?? FALLBACK_SCOPE_ID,
        status: "completed",
      };
    }
    case "dev-server-status": {
      const projectName = pickString(e.projectName);
      const sessionName = pickString(e.sessionName);
      const serverName = pickString(e.serverName);
      const scopeId =
        projectName && sessionName && serverName
          ? `${projectName}/${sessionName}/${serverName}`
          : FALLBACK_SCOPE_ID;
      return {
        scope: "dev-server",
        scopeId,
        status: mapDevServerStatus(e.status),
      };
    }
    case "scoped-status": {
      // The `scoped-status` SSE event already carries scope/scopeId/status as
      // first-class fields. Pass them through after narrowing to the
      // recognized scope set so the adapter never produces a scope outside
      // the documented union; unknown scopes fall back to the generic
      // `workflow` scope so future primitive-native workflows can publish
      // status without an adapter change.
      return {
        scope: narrowScopedStatusScope(e.scope),
        scopeId: pickString(e.scopeId) ?? FALLBACK_SCOPE_ID,
        status: narrowLifecycleStatus(e.status),
      };
    }
    default: {
      return {
        scope: "conversation",
        scopeId: FALLBACK_SCOPE_ID,
        status: "running",
      };
    }
  }
}

export interface SessionStatusBusDeps {
  broadcast: (event: SSEEvent) => void;
  now?: () => string;
  logger?: StatusBusLogger;
}

export type SessionStatusBus = StatusBus;

export function createSessionStatusBus(
  deps: SessionStatusBusDeps,
): SessionStatusBus {
  const wireBroadcast: StatusBusBroadcastFn = (envelope: StatusBusEnvelope) => {
    deps.broadcast(envelope.payload as SSEEvent);
  };
  return createStatusBus({
    broadcast: wireBroadcast,
    now: deps.now,
    logger: deps.logger,
  });
}

export interface PublishScopedStatusOptions {
  bus: StatusBus;
}

export function publishScopedStatus(
  event: SSEEvent,
  options: PublishScopedStatusOptions,
): StatusBusDeliveryOutcome {
  const { scope, scopeId, status } = resolveSessionStatusScope(event);
  return options.bus.publish({
    scope,
    scopeId,
    status,
    payload: event,
  });
}
