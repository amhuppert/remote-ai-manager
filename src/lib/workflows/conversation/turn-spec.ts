import { z } from "zod";
import {
  agentBackendIdShapeSchema,
  agentSessionRefSchema,
} from "@/lib/shared/schemas";
import { backendModelSelectionSchema } from "@/lib/agent-backends/schemas";
import {
  executionIntentSchema,
  taskExecutionProfileSchema,
} from "@/lib/agent-backends/execution-admission";
import { fsWritePolicySchema } from "@/lib/agent-backends/task";
import { imagePayloadSchema } from "@/lib/images/schemas";
import {
  documentFeedbackPayloadSchema,
  notepadFeedbackPayloadSchema,
} from "@/lib/conversations/message-content-schemas";
import {
  transcriptMessageOriginSchema,
  conversationRoleSchema,
} from "@/lib/conversations/schemas";
import { conversationTargetSchema } from "@/lib/conversations/conversation-target";
import {
  outputSchemaInputSchema,
  portableMcpConfigInputSchema,
} from "@/lib/workflows/primitives/agent-call-vocabulary";
import type { WorkflowLaneIdentity } from "@/lib/agent-backends/conversation";
import type { ConversationToolingOverrides } from "@/lib/agent-backends/types";
import type { AgentProfileNotResolvableError } from "@/lib/agent-profiles/library-service";
import type { SettledConversationTurn } from "./turn-result";

// ============================================================
// Context
// ============================================================

/** Structured-output contract attached to a turn (JSON Schema transported by
 *  the backend adapter and enforced by the shared post-turn gate). Shared by
 *  both ActiveTurn variants so callers don't have to branch on `kind` when only
 *  the output format matters. */
export const structuredOutputFormatSchema = z.object({
  type: z.literal("json_schema"),
  schema: outputSchemaInputSchema,
});
export type StructuredOutputFormat = z.infer<
  typeof structuredOutputFormatSchema
>;

/** Marks a turn as a queued next-turn delivery: the claimed queue rows it
 *  delivers and the delivery attempt that claimed them, so the executor can
 *  confirm acceptance and mark those rows delivered under the same attempt. */
export const queuedDeliveryMetadataSchema = z.object({
  messageIds: z.array(z.string()),
  deliveryAttemptId: z.string(),
});
export type QueuedDeliveryMetadata = z.infer<
  typeof queuedDeliveryMetadataSchema
>;

const executionFields = {
  promptText: z.string(),
  backend: agentBackendIdShapeSchema,
  /** Override the complete model selection on this turn. */
  modelSelection: backendModelSelectionSchema.nullable().default(null),
  // `outputFormat` is intentionally opt-in. Regular user-facing chat is
  // free-form markdown by design — requiring a JSON schema would prevent the
  // streaming chat response the UI renders. Workflow callers (debug mode,
  // validator, collaboration round responses) opt into the backend-neutral
  // structured-output pipeline; everyone else gets unconstrained text.
  outputFormat: structuredOutputFormatSchema.optional(),
  /**
   * Server-derived filesystem-write envelope for this implementer turn, composed
   * by the graph-workflow implementer runner from the context's authored
   * placement. Claimed onto the active turn rather than re-read from the event
   * at dispatch, for the same reason {@link TaskRunActive.fsWritePolicy} is: a
   * turn that lost its policy between claim and dispatch would run
   * unrestricted. Absent for every turn outside an owning or read-only
   * graph-workflow context.
   */
  /**
   * Server-derived filesystem-write envelope for the turn. Its PRESENCE is what
   * marks the turn as a write-restricted (validator) lane at the dispatch site,
   * so it is claimed onto the active turn rather than read from the event
   * later — a turn that lost it between claim and dispatch would run
   * unrestricted.
   */
  /**
   * Server-derived filesystem-write envelope for this turn. Set only by the
   * graph-workflow implementer runner, which composes it from the context's
   * authored placement before any dispatch decision; every other caller leaves
   * it unset, so an ordinary conversation keeps its unrestricted worktree.
   * Carried onto the claimed turn, so the turn that runs is the one the
   * envelope was composed for.
   */
  /**
   * Server-derived filesystem-write envelope for this turn (see
   * FsWritePolicy). Composed by the caller from the turn's lane role
   * and carried unchanged to the runner. Validators and graph output-capture
   * turns always supply one; omitting it leaves the turn unrestricted.
   */
  fsWritePolicy: fsWritePolicySchema.optional(),
};

export const conversationTurnSpecSchema = z
  .object({
    ...executionFields,
    kind: z.literal("conversation_turn").default("conversation_turn"),
    images: z.array(imagePayloadSchema).default([]),
    autonomous: z.boolean().default(false),
    /**
     * Opt-in: hold this turn open until its in-flight waitable background tasks
     * settle (or the wait times out). Set only by the graph-workflow implementer
     * runner; unset for every other turn so behavior is unchanged.
     */
    /**
     * Opt-in: hold this turn open until its in-flight waitable background tasks
     * settle (or the wait times out). Forwarded to the backend turn input. Set
     * only by the graph-workflow implementer runner.
     */
    /**
     * Opt-in: hold the turn open after the agent yields until its in-flight
     * waitable background tasks settle (or the wait times out). Set only by the
     * graph-workflow implementer runner; every other caller (interactive chat,
     * planner/validator/collab turns) leaves it unset so behavior is unchanged.
     */
    waitForBackgroundTasks: z.boolean().optional(),
    /** Set only for auto-drained queued next-turn deliveries; unset for normal
     *  user-initiated turns. */
    /** Set only for auto-drained queued next-turn deliveries; forwarded so the
     *  executor can confirm acceptance and mark the claimed queue rows delivered.
     *  Unset for normal user-initiated turns. */
    queuedDelivery: queuedDeliveryMetadataSchema.optional(),
    /** Structured document-review feedback carried with this turn. When set, the
     *  user-turn transcript records a `document_feedback` block and the
     *  agent-facing prompt text is derived from it when no explicit text was
     *  supplied. Unset for every non-feedback turn. */
    /** Structured document-review feedback for this turn. When set, the user-turn
     *  transcript records a `document_feedback` block and the agent-facing prompt
     *  text is derived from it when `promptText` is empty. Unset otherwise. */
    /**
     * Structured document-review feedback to record on the user turn. When set,
     * the turn's transcript carries a `document_feedback` block and the
     * agent-facing prompt text is derived from it when `promptText` is empty.
     * Unset for every non-feedback send.
     */
    documentFeedback: documentFeedbackPayloadSchema.optional(),
    /** Notepad comment dispatches carried with this turn, one per notepad. Each
     *  records its own `notepad_feedback` transcript block and contributes its
     *  derived prose when no explicit text was supplied. Unset otherwise. */
    /** Notepad comment dispatches for this turn, one per notepad. Each records a
     *  `notepad_feedback` block and contributes derived prose when `promptText`
     *  is empty. Unset otherwise. */
    /**
     * Notepad comment dispatches to record on the user turn. Each records a
     * `notepad_feedback` block and contributes its derived prose when
     * `promptText` is empty. Unset for every non-dispatch send.
     */
    notepadFeedback: z
      .array(notepadFeedbackPayloadSchema)
      .readonly()
      .optional(),
    /** Effective ask-user-questions availability for this turn (resolved toggle
     *  AND lane-can-ask). Set only by graph-workflow runners; selects the enabled
     *  asking-questions session-instruction variant. Unset for every other turn. */
    /** Effective ask-user-questions availability for this turn (resolved toggle
     *  AND lane-can-ask). Selects the enabled asking-questions session-instruction
     *  variant. Set only by graph-workflow runners; unset for every other turn. */
    /**
     * Effective ask-user-questions availability for this turn: the resolved
     * per-context toggle AND the lane holding a real conversation. Set only by
     * the graph-workflow runners; when true the session instructions select the
     * enabled asking-questions variant. Every other caller leaves it unset, so
     * non-workflow conversations keep the default autonomous-denied guidance.
     */
    askUserQuestionsEnabled: z.boolean().optional(),
  })
  .strict();

export const taskTurnSpecSchema = z
  .object({
    ...executionFields,
    ...executionIntentSchema.shape,
    kind: z.literal("task_run").default("task_run"),
    executionProfile: taskExecutionProfileSchema.optional(),
    resumeRef: agentSessionRefSchema.nullable().optional(),
    systemInstructions: z.string().optional(),
    tooling: portableMcpConfigInputSchema.optional(),
    timeoutMs: z.number().int().nonnegative().optional(),
    /** When set, persist this validated structured-output string field as the
     *  visible assistant text instead of the backend's schema transport text. */
    /** Persist this validated structured-output string field as the assistant
     *  transcript text, keeping backend transport JSON out of the UI. */
    structuredOutputTextField: z.string().optional(),
    /**
     * Provenance stamp forwarded onto the persisted assistant TranscriptMessage.
     * Workflow callers set `source: "workflow"` so a single JSONL transcript can
     * distinguish workflow-driven turns from user-driven turns without forking
     * the file. Omit on user-driven turns.
     */
    /** Forwarded onto the appended assistant TranscriptMessage so workflow-driven
     *  turns are distinguishable from user-driven turns in the shared JSONL. */
    /**
     * Provenance stamp for the persisted assistant TranscriptMessage. Workflow
     * callers should pass `{ source: "workflow", workflow?: { executionId,
     * nodeId, iterationIndex } }` so the shared JSONL transcript distinguishes
     * workflow-driven turns from user-driven turns. Omit on non-workflow
     * task-runs to leave the entry unmarked.
     */
    origin: transcriptMessageOriginSchema.optional(),
  })
  .strict();

export type ConversationTurnSpec = z.output<typeof conversationTurnSpecSchema>;
export type TaskTurnSpec = z.output<typeof taskTurnSpecSchema>;
export const conversationTurnRequestSchema = conversationTurnSpecSchema.partial(
  { backend: true },
);
export type ConversationTurnRequest = z.input<
  typeof conversationTurnRequestSchema
>;
export const taskTurnRequestSchema = taskTurnSpecSchema
  .partial({
    backend: true,
  })
  .extend({ kind: z.literal("task_run") });
export type TaskTurnRequest = z.input<typeof taskTurnRequestSchema>;
export type TurnSpec = ConversationTurnSpec | TaskTurnSpec;
export type TurnRequest = ConversationTurnRequest | TaskTurnRequest;

export function normalizeTurn(
  request: ConversationTurnRequest,
  backend: TurnSpec["backend"],
): ConversationTurnSpec;
export function normalizeTurn(
  request: TaskTurnRequest,
  backend: TurnSpec["backend"],
): TaskTurnSpec;
export function normalizeTurn(
  request: TurnRequest,
  backend: TurnSpec["backend"],
): TurnSpec {
  return request.kind === "task_run"
    ? taskTurnSpecSchema.parse({
        ...request,
        backend: request.backend ?? backend,
      })
    : conversationTurnSpecSchema.parse({
        ...request,
        backend: request.backend ?? backend,
      });
}

export const conversationAddressSchema = z
  .object({
    projectPath: z.string().min(1),
    target: conversationTargetSchema,
  })
  .strict();
export type ConversationAddress = z.infer<typeof conversationAddressSchema>;

export const conversationBindingSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("durable"),
      address: conversationAddressSchema,
      worktreePath: z.string().min(1).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("ephemeral"),
      address: conversationAddressSchema,
      worktreePath: z.string().min(1),
      backend: agentBackendIdShapeSchema,
      role: conversationRoleSchema,
      transcriptPath: z.string().nullable().optional(),
    })
    .strict(),
]);
export type ConversationBinding = z.infer<typeof conversationBindingSchema>;

export interface ConversationExecutionContext {
  workflowContext?: WorkflowLaneIdentity;
  tooling?: ConversationToolingOverrides;
}

export type TurnCancelReason = "user" | "timeout" | "stalled" | "shutdown";
export interface AdmittedConversationTurn {
  readonly attemptId: string;
  readonly completed: Promise<SettledConversationTurn>;
  cancel(reason: TurnCancelReason): Promise<SettledConversationTurn>;
}

export type TurnAdmissionRefusalCode =
  | "busy"
  | "cancelled"
  | "binding_mismatch"
  | "not_found"
  | "queue_review_required"
  | "profile_refused";
export type TurnAdmissionRefusal =
  | {
      kind: "refused";
      code: Exclude<TurnAdmissionRefusalCode, "profile_refused">;
      message: string;
    }
  | {
      kind: "refused";
      code: "profile_refused";
      message: string;
      error: AgentProfileNotResolvableError;
    };
export type TurnAdmission =
  | { kind: "accepted"; turn: AdmittedConversationTurn }
  | TurnAdmissionRefusal;

export interface ConversationTurnSubmission {
  binding: ConversationBinding;
  turn: TurnRequest;
  executionContext?: ConversationExecutionContext;
  transport?: { streamId: string; emit(event: string, data: unknown): void };
  signal?: AbortSignal;
  waitUntilReady?: boolean;
}
