import { z } from "zod";
import { permitRefSchema } from "@/lib/control/schemas";
import { agentProfileRefSchema } from "@/lib/agent-profiles/schemas";
import { backendModelSelectionSchema } from "@/lib/agent-backends/schemas";
import { ownerRefSchema } from "@/lib/intents/schemas";
import { agentBackendSchema } from "@/lib/shared/schemas";
import { workspaceScopeSchema } from "@/lib/workspace/schemas";
import { imagePayloadSchema } from "@/lib/images/schemas";
import {
  documentFeedbackPayloadSchema,
  notepadFeedbackPayloadSchema,
} from "@/lib/conversations/message-content-schemas";
import { queuedDeliveryMetadataSchema } from "@/lib/workflows/conversation/turn-spec";

/**
 * A turn a supervisor asks a seat conversation to take. Requesters may carry
 * their own labels; Conversation reads only these fields.
 */
export const seatTurnRequestSchema = z
  .object({
    kind: z.enum(["work", "capture_output", "review", "advise"]),
    workspace: z
      .object({
        projectPath: z.string().min(1),
        sessionName: z.string().min(1),
        worktreePath: z.string().min(1),
        access: z.enum(["write", "stable_read", "observe"]),
        scope: workspaceScopeSchema,
      })
      .passthrough(),
    seat: z
      .object({
        contextId: z.string().min(1),
        assignmentId: z.string().min(1),
        role: z.enum(["implementer", "reviewer"]),
        assignment: z
          .object({
            id: z.string().min(1),
            profile: agentProfileRefSchema,
            focus: z.string().optional(),
            backend: agentBackendSchema,
            modelSelection: backendModelSelectionSchema,
          })
          .passthrough(),
        replacement: z.number().int().min(0),
        canAsk: z.boolean(),
      })
      .passthrough(),
    message: z.string().min(1),
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

/** An interactive conversation the core runs instead of the conversation actor. */
export const interactiveEnrollmentRecordSchema = z
  .object({
    conversationId: z.string().min(1),
    projectPath: z.string().min(1),
    sessionName: z.string().min(1),
    enrolledAt: z.string().min(1),
  })
  .strict();
export type InteractiveEnrollmentRecord = z.infer<typeof interactiveEnrollmentRecordSchema>;

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

export const attemptRecordSchema = z
  .object({
    attemptId: z.string().min(1),
    conversationId: z.string().min(1),
    cause: z.string().min(1),
    state: attemptStateSchema,
    /** `not_admitted` when the permit closed before admission; otherwise the report. */
    outcome: z
      .union([
        seatTurnReportSchema,
        z.object({ notAdmitted: z.string() }).strict(),
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
