import { z } from "zod";
import { permitRefSchema } from "@/lib/control/schemas";
import { agentProfileRefSchema } from "@/lib/agent-profiles/schemas";
import { backendModelSelectionSchema } from "@/lib/agent-backends/schemas";
import { ownerRefSchema } from "@/lib/intents/schemas";
import { agentBackendSchema } from "@/lib/shared/schemas";
import { turnWorkspaceSchema } from "@/lib/workspace/schemas";
import { imagePayloadSchema } from "@/lib/images/schemas";
import {
  documentFeedbackPayloadSchema,
  notepadFeedbackPayloadSchema,
} from "@/lib/conversations/message-content-schemas";
import {
  queuedDeliveryMetadataSchema,
  taskTurnRequestSchema,
} from "@/lib/conversation-core/turn/turn-spec";

/** Who works a seat: its profile, focus, backend and model. One shape for contracts and turn requests. */
export const seatAssignmentSchema = z
  .object({
    id: z.string().trim().min(1),
    profile: agentProfileRefSchema,
    focus: z.string().trim().min(1).optional(),
    backend: agentBackendSchema,
    modelSelection: backendModelSelectionSchema,
  })
  .strict();
export type SeatAssignment = z.infer<typeof seatAssignmentSchema>;

/** The seat a turn is for: its Context, assignment and incarnation; the executor spawns its conversation on first use. */
export const seatRefSchema = z
  .object({
    contextId: z.string().min(1),
    assignmentId: z.string().min(1),
    role: z.enum(["implementer", "reviewer"]),
    assignment: seatAssignmentSchema,
    conversationId: z.string().min(1).nullable(),
    replacement: z.number().int().min(0),
    /** Whether the seat may ask its owner a question. */
    canAsk: z.boolean(),
  })
  .strict();
export type SeatRef = z.infer<typeof seatRefSchema>;

/** A frozen document a work order carries: copied from its artifact to `path` in the seat's working directory before the turn. */
export const workOrderDocumentSchema = z
  .object({ artifactId: z.string().min(1), path: z.string().min(1) })
  .strict();
export type WorkOrderDocument = z.infer<typeof workOrderDocumentSchema>;

/**
 * A turn a supervisor asks a seat conversation to take. Requesters may carry
 * their own labels; Conversation reads only these fields.
 */

export const seatTurnRequestSchema = z
  .object({
    kind: z.enum(["work", "capture_output", "review", "advise"]),
    workspace: turnWorkspaceSchema,
    seat: seatRefSchema,
    message: z.string().min(1),
    documents: z.array(workOrderDocumentSchema).default([]),
    outputSchema: z.record(z.string(), z.unknown()).optional(),
    timeoutMs: z.number().int().min(0).nullable(),
  })
  .passthrough();
export type SeatTurnRequest = z.infer<typeof seatTurnRequestSchema>;

/** A person's message to an interactive conversation the core runs, or a queued batch of them. */
export const userTurnRequestSchema = z
  .object({
    kind: z.literal("user_message"),
    text: z.string(),
    images: z.array(imagePayloadSchema).optional(),
    documentFeedback: documentFeedbackPayloadSchema.optional(),
    notepadFeedback: z.array(notepadFeedbackPayloadSchema).optional(),
    modelSelection: backendModelSelectionSchema.optional(),
    /** The backend the sender chose; adopted only by a conversation that has not run yet. */
    backend: agentBackendSchema.optional(),
    inputOrigin: z.enum(["user", "generated"]),
    /** Rows of the conversation's message queue this turn delivers; the queue owns them until accepted. */
    queuedDelivery: queuedDeliveryMetadataSchema.optional(),
    /** Run with no person attending (an optimistic session's kickoff): it asks nothing and the charter does not apply. */
    autonomous: z.boolean().optional(),
  })
  .strict()
  .refine(
    (request) =>
      request.text.trim().length > 0 ||
      (request.images?.length ?? 0) > 0 ||
      request.documentFeedback !== undefined ||
      (request.notepadFeedback?.length ?? 0) > 0,
    { message: "A message needs text, an image or feedback" },
  );
export type UserTurnRequest = z.infer<typeof userTurnRequestSchema>;

/** The settled outcome of a seat turn, as every requester consumes it. */
export const seatTurnReportSchema = z
  .object({
    status: z.enum(["succeeded", "failed", "cancelled", "interrupted"]),
    conversationId: z.string().min(1),
    finalText: z.string().nullable(),
    structuredOutput: z.unknown(),
    /** The bounded capture/repair protocol ended without a valid value. */
    outputIssue: z.string().nullable(),
    /** The turn ended by asking its owner a question. */
    openQuestionId: z.string().nullable(),
    failure: z.string().nullable(),
  })
  .strict();
export type SeatTurnReport = z.infer<typeof seatTurnReportSchema>;

/** The controller binding a seat conversation records when it is spawned. */
export const seatBindingRecordSchema = z
  .object({
    conversationId: z.string().min(1),
    contextId: z.string().min(1),
    assignmentId: z.string().min(1),
    replacement: z.number().int().min(0),
    role: z.enum(["implementer", "reviewer"]),
    projectPath: z.string().min(1),
    sessionName: z.string().min(1),
    backend: agentBackendSchema,
    createdAt: z.string().min(1),
    updatedAt: z.string().min(1),
  })
  .strict();
export type SeatBindingRecord = z.infer<typeof seatBindingRecordSchema>;

/**
 * Where an interactive conversation the core runs is stored: its project and
 * its storage key (the session, or the project sentinel at project scope).
 */
export const interactiveConversationSchema = z
  .object({
    conversationId: z.string().min(1),
    projectPath: z.string().min(1),
    sessionName: z.string().min(1),
  })
  .strict();
export type InteractiveConversation = z.infer<
  typeof interactiveConversationSchema
>;

/** What a mailbox item asks its conversation to run: a person's message, a workflow's task or a seat's work order. */
export const mailboxRequestSchema = z.discriminatedUnion("kind", [
  userTurnRequestSchema,
  taskTurnRequestSchema,
  seatTurnRequestSchema,
]);
export type MailboxRequest = z.infer<typeof mailboxRequestSchema>;

export const mailboxItemStateSchema = z.enum(["queued", "consumed"]);

export const mailboxItemRecordSchema = z
  .object({
    cause: z.string().min(1),
    conversationId: z.string().min(1),
    /** The supervisor to hint when the turn settles; null for a person's own message. */
    requester: ownerRefSchema.nullable(),
    request: z.unknown(),
    permit: permitRefSchema.nullable(),
    state: mailboxItemStateSchema,
    /** The attempt that consumed the item, once one settled with it. */
    attemptId: z.string().min(1).nullable(),
    createdAt: z.string().min(1),
    updatedAt: z.string().min(1),
  })
  .strict();
export type MailboxItemRecord = z.infer<typeof mailboxItemRecordSchema>;

export const attemptStateSchema = z.enum(["open", "admitted", "settled"]);

/**
 * How a custody (the attempt that holds a turn's runtime while it still owes
 * provider work, design C5b §3) ended: the work was done, the person stopped
 * it, the runtime died, it ran past its bound, the server stopped, or a turn
 * took the runtime over.
 */
export const custodyEndSchema = z.enum([
  "settled",
  "stopped",
  "lost",
  "timed_out",
  "interrupted",
  "handed_over",
  /** Never opened: its session or conversation was closing to background work, so the runtime was released. */
  "refused",
]);
export type CustodyEnd = z.infer<typeof custodyEndSchema>;

/** The cause of the custody attempt that holds the runtime the attempt `turnAttemptId` left owing work. */
export const custodyCause = (turnAttemptId: string): string =>
  `custody:${turnAttemptId}`;

export const isCustodyCause = (cause: string): boolean =>
  cause.startsWith("custody:");

export const attemptRecordSchema = z
  .object({
    attemptId: z.string().min(1),
    conversationId: z.string().min(1),
    cause: z.string().min(1),
    state: attemptStateSchema,
    /** `not_admitted` when the permit closed before admission; a custody's end; otherwise the report. */
    outcome: z
      .union([
        seatTurnReportSchema,
        z.object({ notAdmitted: z.string() }).strict(),
        z
          .object({ kind: z.literal("custody"), end: custodyEndSchema })
          .strict(),
      ])
      .nullable(),
    openedAt: z.string().min(1),
    settledAt: z.string().min(1).nullable(),
  })
  .strict();
export type AttemptRecord = z.infer<typeof attemptRecordSchema>;

export const questionStateSchema = z.enum(["open", "answered", "withdrawn"]);

export const coreQuestionRecordSchema = z
  .object({
    questionId: z.string().min(1),
    conversationId: z.string().min(1),
    attemptId: z.string().min(1),
    /** The asked questions, rendered for the asker's continuation. */
    questionText: z.string(),
    questions: z.unknown(),
    state: questionStateSchema,
    answer: z.string().nullable(),
    createdAt: z.string().min(1),
    answeredAt: z.string().min(1).nullable(),
  })
  .strict();
export type CoreQuestionRecord = z.infer<typeof coreQuestionRecordSchema>;

/** The settled outcome of a wait on a question, as requesters consume it. */
export const questionReportSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("answered"),
      question: z.string(),
      answer: z.string(),
    })
    .strict(),
  z.object({ kind: z.literal("withdrawn") }).strict(),
]);
export type QuestionReport = z.infer<typeof questionReportSchema>;
