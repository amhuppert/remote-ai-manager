import { z } from "zod";
import type {
  ConversationStatusEvent,
  MessageAppendedEvent,
  MessageUpdatedEvent,
  ConversationCreatedEvent,
  ConversationRenamedEvent,
  ConversationArchivedEvent,
  ConversationUnreadEvent,
  AskQuestionEvent,
  MessageQueuedEvent,
  ConversationOpenEvent,
} from "@/lib/conversations/schemas";
import type { JobStatusEvent } from "@/lib/jobs/schemas";
import type {
  NotificationCreatedEvent,
  NotificationUpdatedEvent,
} from "@/lib/notifications/schemas";
import type {
  GraphWorkflowStatusEvent,
  GraphWorkflowContextStatusEvent,
  GraphWorkflowTaskStatusEvent,
  GraphWorkflowValidationResultEvent,
  GraphWorkflowCircuitBreakerEvent,
  GraphWorkflowSharedDocumentsUpdatedEvent,
  GraphWorkflowPendingHaltReasonEvent,
  GraphWorkflowMergeStatusEvent,
  GraphWorkflowBatchScheduledEvent,
  GraphWorkflowLaneStatusEvent,
  GraphWorkflowJoinStatusEvent,
} from "@/lib/workflows/schemas";
import type { DevServerStatusEvent } from "@/lib/dev-server/schemas";
import type {
  DebugModeStatusEvent,
  DebugLogReceivedEvent,
} from "@/lib/debug-log/schemas";
import type {
  McpConfigUpdatedEvent,
  McpToolsUpdatedEvent,
} from "@/lib/mcp/schemas";
import type {
  AgentCapabilitiesUpdatedEvent,
  AgentCapabilitiesDiscoveryUpdatedEvent,
} from "@/lib/agent-capabilities/schemas";
import type { SpawnResultEvent } from "@/lib/chat-spawning/schemas";

// ============================================================
// Scoped Status SSE Event (StatusBus → SSE bridge)
// ============================================================

/**
 * Generic scoped-status SSE event used by primitive-native workflows
 * (Collaboration Mode and any future workflow built directly on the
 * primitive layer) to bridge in-process `StatusBus` envelopes onto the
 * shared session SSE wire without each feature having to define its
 * own typed SSE event.
 *
 * Contract:
 *  - `scope` identifies the feature family the envelope belongs to
 *    (`"collaboration"`, `"workflow"`, etc.). New scopes are additive
 *    and do not require schema changes — clients filter by the scope
 *    field at runtime.
 *  - `scopeId` is the durable workflow identifier within that scope
 *    (e.g. the collaboration `workflowId`).
 *  - `status` is the StatusBus lifecycle status mapped to one of the
 *    four canonical states.
 *  - `payload` is the original feature-defined envelope payload, kept
 *    `unknown` so each feature can evolve its own internal shape
 *    without redefining the SSE wire contract.
 *  - `reason` is an optional short tag describing why the envelope was
 *    published (e.g. `"max_iterations_exceeded"`); useful for surface
 *    UI without parsing the payload.
 */
export const scopedStatusEventSchema = z.object({
  type: z.literal("scoped-status"),
  scope: z.string().min(1),
  scopeId: z.string().min(1),
  status: z.enum(["running", "paused", "completed", "failed"]),
  timestamp: z.string().min(1),
  projectName: z.string(),
  sessionName: z.string(),
  payload: z.unknown().optional(),
  reason: z.string().optional(),
});
export type ScopedStatusEvent = z.infer<typeof scopedStatusEventSchema>;

/** SSE event type */
export type SSEEvent =
  | ConversationStatusEvent
  | MessageAppendedEvent
  | MessageUpdatedEvent
  | ConversationCreatedEvent
  | ConversationRenamedEvent
  | ConversationArchivedEvent
  | ConversationUnreadEvent
  | AskQuestionEvent
  | JobStatusEvent
  | NotificationCreatedEvent
  | NotificationUpdatedEvent
  | MessageQueuedEvent
  | ConversationOpenEvent
  | GraphWorkflowStatusEvent
  | GraphWorkflowContextStatusEvent
  | GraphWorkflowTaskStatusEvent
  | GraphWorkflowValidationResultEvent
  | GraphWorkflowCircuitBreakerEvent
  | GraphWorkflowSharedDocumentsUpdatedEvent
  | GraphWorkflowPendingHaltReasonEvent
  | GraphWorkflowMergeStatusEvent
  | GraphWorkflowBatchScheduledEvent
  | GraphWorkflowLaneStatusEvent
  | GraphWorkflowJoinStatusEvent
  | DevServerStatusEvent
  | DebugModeStatusEvent
  | DebugLogReceivedEvent
  | McpConfigUpdatedEvent
  | McpToolsUpdatedEvent
  | AgentCapabilitiesUpdatedEvent
  | AgentCapabilitiesDiscoveryUpdatedEvent
  | ScopedStatusEvent
  | SpawnResultEvent;
