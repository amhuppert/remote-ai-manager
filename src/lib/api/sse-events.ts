import type { CommandsChangedEvent } from "@/lib/commands/schemas";
import type { SubscriptionsChangedEvent } from "@/lib/subscriptions/controls-schemas";
import type { BundleTransferEvent } from "@/lib/tickets/bundle-transfer-schemas";
import { z } from "zod";
import type {
  ConversationBackgroundActivityEvent,
  ConversationCustodyEvent,
  ConversationStatusEvent,
  MessageAppendedEvent,
  MessageUpdatedEvent,
  ConversationCreatedEvent,
  ConversationProfileChangedEvent,
  ConversationRenamedEvent,
  ConversationArchivedEvent,
  ConversationDeletedEvent,
  ConversationUnreadEvent,
  ConversationUsageUpdatedEvent,
  AskQuestionEvent,
  MessageQueuedEvent,
  ConversationOpenEvent,
  MessageQueueUpdatedEvent,
} from "@/lib/conversations/schemas";
import type { ConversationCheckpointUpdatedEvent } from "@/lib/conversation-checkpoints/events";
import type { JobStatusEvent } from "@/lib/jobs/schemas";
import type {
  NotificationCreatedEvent,
  NotificationUpdatedEvent,
} from "@/lib/notifications/schemas";
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
import type { SessionAlignmentUpdatedEvent } from "@/lib/session-alignment/schemas";
import type { RunTemplateChangedEvent } from "@/lib/run-templates/schemas";
import type { ContextArtifactStatusEvent } from "@/lib/context-artifacts/schemas";
import type { TicketChangedEvent } from "@/lib/tickets/schemas";
import type { RunChangedEvent } from "@/lib/runs/event-schemas";
import type { NotepadChangedEvent } from "@/lib/notepads/schemas";
import type { MemoryChangedEvent } from "@/lib/memory/schemas";
import type { AgentProfileLibraryChangedEvent } from "@/lib/agent-profiles/schemas";
import type { ValidationRunEvent } from "@/lib/validation/schemas";

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

const specEventIdentityShape = {
  projectPath: z.string().min(1),
  specId: z.string().min(1),
  specSlug: z.string().min(1),
  occurredAt: z.string().min(1),
  kind: z.string().min(1),
};

export const specChangedEventSchema = z
  .object({
    type: z.literal("spec-changed"),
    ...specEventIdentityShape,
    revisionId: z.string().min(1).optional(),
    elementIds: z.array(z.string().min(1)).optional(),
  })
  .strict();
export type SpecChangedEvent = z.infer<typeof specChangedEventSchema>;

export const specRevisionChangedEventSchema = z
  .object({
    type: z.literal("spec-revision-changed"),
    ...specEventIdentityShape,
    revisionId: z.string().min(1),
    elementIds: z.array(z.string().min(1)).optional(),
  })
  .strict();

export const specApprovalChangedEventSchema = z
  .object({
    type: z.literal("spec-approval-changed"),
    ...specEventIdentityShape,
    revisionId: z.string().min(1).optional(),
    subjectId: z.string().min(1).optional(),
  })
  .strict();

export const specAttentionChangedEventSchema = z
  .object({
    type: z.literal("spec-attention-changed"),
    ...specEventIdentityShape,
    attentionId: z.string().min(1),
    active: z.boolean(),
  })
  .strict();

export const specSseEventSchema = z.discriminatedUnion("type", [
  specChangedEventSchema,
  specRevisionChangedEventSchema,
  specApprovalChangedEventSchema,
  specAttentionChangedEventSchema,
]);
export type SpecSseEvent = z.infer<typeof specSseEventSchema>;

/** SSE event type */
export type SSEEvent =
  | SubscriptionsChangedEvent
  | ConversationStatusEvent
  | MessageAppendedEvent
  | MessageUpdatedEvent
  | ConversationCreatedEvent
  | ConversationRenamedEvent
  | ConversationArchivedEvent
  | ConversationDeletedEvent
  | ConversationUnreadEvent
  | ConversationUsageUpdatedEvent
  | ConversationProfileChangedEvent
  | ConversationBackgroundActivityEvent
  | ConversationCustodyEvent
  | AskQuestionEvent
  | JobStatusEvent
  | NotificationCreatedEvent
  | NotificationUpdatedEvent
  | MessageQueuedEvent
  | ConversationOpenEvent
  | MessageQueueUpdatedEvent
  | DevServerStatusEvent
  | DebugModeStatusEvent
  | DebugLogReceivedEvent
  | McpConfigUpdatedEvent
  | McpToolsUpdatedEvent
  | AgentCapabilitiesUpdatedEvent
  | CommandsChangedEvent
  | AgentCapabilitiesDiscoveryUpdatedEvent
  | ScopedStatusEvent
  | SpawnResultEvent
  | SessionAlignmentUpdatedEvent
  | ContextArtifactStatusEvent
  | ConversationCheckpointUpdatedEvent
  | TicketChangedEvent
  | RunChangedEvent
  | RunTemplateChangedEvent
  | BundleTransferEvent
  | NotepadChangedEvent
  | MemoryChangedEvent
  | AgentProfileLibraryChangedEvent
  | SpecSseEvent
  | ValidationRunEvent;
