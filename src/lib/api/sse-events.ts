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
  MessageQueueUpdatedEvent,
} from "@/lib/conversations/schemas";
import type { JobStatusEvent } from "@/lib/jobs/schemas";
import type {
  NotificationCreatedEvent,
  NotificationUpdatedEvent,
} from "@/lib/notifications/schemas";
import type {
  GraphWorkflowApprovalPendingEvent,
  GraphWorkflowApprovalResolvedEvent,
  GraphWorkflowBatchScheduledEvent,
  GraphWorkflowCharterRegisteredEvent,
  GraphWorkflowCharterUpdatedEvent,
  GraphWorkflowCircuitBreakerEvent,
  GraphWorkflowContextStatusEvent,
  GraphWorkflowJoinStatusEvent,
  GraphWorkflowLaneCommitEvent,
  GraphWorkflowLaneStatusEvent,
  GraphWorkflowLiveEditAppliedEvent,
  GraphWorkflowMergeStatusEvent,
  GraphWorkflowPendingHaltReasonEvent,
  GraphWorkflowSharedDocumentsUpdatedEvent,
  GraphWorkflowStatusEvent,
  GraphWorkflowTaskStatusEvent,
  GraphWorkflowUserInputPendingEvent,
  GraphWorkflowUserInputResolvedEvent,
  GraphWorkflowValidationResultEvent,
} from "@/lib/workflow-graph/event-schemas";
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
import type { ContextArtifactStatusEvent } from "@/lib/context-artifacts/schemas";
import type { TicketChangedEvent } from "@/lib/tickets/schemas";

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
export type SpecRevisionChangedEvent = z.infer<
  typeof specRevisionChangedEventSchema
>;

export const specApprovalChangedEventSchema = z
  .object({
    type: z.literal("spec-approval-changed"),
    ...specEventIdentityShape,
    revisionId: z.string().min(1).optional(),
    subjectId: z.string().min(1).optional(),
  })
  .strict();
export type SpecApprovalChangedEvent = z.infer<
  typeof specApprovalChangedEventSchema
>;

export const specExecutionChangedEventSchema = z
  .object({
    type: z.literal("spec-execution-changed"),
    ...specEventIdentityShape,
    revisionId: z.string().min(1),
    executionId: z.string().min(1),
  })
  .strict();
export type SpecExecutionChangedEvent = z.infer<
  typeof specExecutionChangedEventSchema
>;

export const specEvidenceChangedEventSchema = z
  .object({
    type: z.literal("spec-evidence-changed"),
    ...specEventIdentityShape,
    revisionId: z.string().min(1),
    criterionId: z.string().min(1).optional(),
    taskId: z.string().min(1).optional(),
    executionId: z.string().min(1).optional(),
  })
  .strict();
export type SpecEvidenceChangedEvent = z.infer<
  typeof specEvidenceChangedEventSchema
>;

export const specAttentionChangedEventSchema = z
  .object({
    type: z.literal("spec-attention-changed"),
    ...specEventIdentityShape,
    attentionId: z.string().min(1),
    active: z.boolean(),
  })
  .strict();
export type SpecAttentionChangedEvent = z.infer<
  typeof specAttentionChangedEventSchema
>;

export const specSseEventSchema = z.discriminatedUnion("type", [
  specChangedEventSchema,
  specRevisionChangedEventSchema,
  specApprovalChangedEventSchema,
  specExecutionChangedEventSchema,
  specEvidenceChangedEventSchema,
  specAttentionChangedEventSchema,
]);
export type SpecSseEvent = z.infer<typeof specSseEventSchema>;

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
  | MessageQueueUpdatedEvent
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
  | GraphWorkflowLaneCommitEvent
  | GraphWorkflowJoinStatusEvent
  | GraphWorkflowApprovalPendingEvent
  | GraphWorkflowApprovalResolvedEvent
  | GraphWorkflowUserInputPendingEvent
  | GraphWorkflowUserInputResolvedEvent
  | GraphWorkflowCharterRegisteredEvent
  | GraphWorkflowCharterUpdatedEvent
  | GraphWorkflowLiveEditAppliedEvent
  | DevServerStatusEvent
  | DebugModeStatusEvent
  | DebugLogReceivedEvent
  | McpConfigUpdatedEvent
  | McpToolsUpdatedEvent
  | AgentCapabilitiesUpdatedEvent
  | AgentCapabilitiesDiscoveryUpdatedEvent
  | ScopedStatusEvent
  | SpawnResultEvent
  | SessionAlignmentUpdatedEvent
  | ContextArtifactStatusEvent
  | TicketChangedEvent
  | SpecSseEvent;
