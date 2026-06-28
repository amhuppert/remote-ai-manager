import { z } from "zod";
import { registerTrustedSchema } from "@/lib/shared/parse-trusted";
import { agentBackendSchema } from "@/lib/shared/schemas";
import { conversationStatusSchema } from "@/lib/conversations/schemas";

/** A comment is either queued (`pending`) or already delivered (`sent`). */
export const commentStatusSchema = z.enum(["pending", "sent"]);
export type CommentStatus = z.infer<typeof commentStatusSchema>;

/**
 * The full anchor recorded for a commented passage. Scope is a SINGLE rendered
 * block: one `sectionId` + one `line`, with `charStart`/`charEnd` offsets into
 * that block's text. Cross-block selections are rejected upstream and never
 * reach this model, so there is no end-block identity (deferred, Out of
 * Boundary). `prefix`/`suffix` are stored with the anchor and are unused by v1
 * exact-match re-anchoring; `docRevision` is the content hash at creation.
 * Effect-free (registerTrustedSchema): no refinements, so it stays a
 * plain ZodObject the persistence durability harness can introspect.
 */
export const commentAnchorSchema = registerTrustedSchema(
  z.object({
    sectionId: z.string(),
    headingLabel: z.string(),
    line: z.number().int().positive(),
    charStart: z.number().int().nonnegative(),
    charEnd: z.number().int().nonnegative(),
    quote: z.string(),
    prefix: z.string(),
    suffix: z.string(),
    docRevision: z.string(),
  }),
  "commentAnchorSchema",
);
export type CommentAnchor = z.infer<typeof commentAnchorSchema>;

/**
 * A durably-persisted, document-scoped comment. Identity is the document
 * (`projectPath`, `sessionName`, `docPath`) — never a conversation. `sentAt` is
 * an explicit `string | null` so a never-sent comment is distinguishable from a
 * dropped field on round-trip. Persisted via the document-comments repo; the
 * derived `stale`/`reanchor` fields are computed on read and are NOT part of
 * this stored shape.
 */
export const documentCommentSchema = registerTrustedSchema(
  z.object({
    id: z.string(),
    projectPath: z.string(),
    sessionName: z.string(),
    docPath: z.string(),
    anchor: commentAnchorSchema,
    note: z.string(),
    status: commentStatusSchema,
    createdAt: z.string(),
    updatedAt: z.string(),
    sentAt: z.string().nullable(),
  }),
  "documentCommentSchema",
);
export type DocumentComment = z.infer<typeof documentCommentSchema>;

/**
 * POST body to create a comment. The owning scope (`projectPath`,
 * `sessionName`) is taken from the route — NOT the body — so a client cannot
 * write a comment into another project/session. `docPath` is validated and
 * normalized against the session worktree at the route boundary.
 */
export const createDocumentCommentRequestSchema = z.object({
  docPath: z.string(),
  anchor: commentAnchorSchema,
  note: z.string(),
});
export type CreateDocumentCommentRequest = z.infer<
  typeof createDocumentCommentRequestSchema
>;

/**
 * PATCH body to update a comment's note and/or status. Both fields optional;
 * the route owns the `sentAt`/`updatedAt` bookkeeping that follows a status
 * change (a status flip is not client-supplied beyond the enum value).
 */
export const updateDocumentCommentRequestSchema = z.object({
  note: z.string().optional(),
  status: commentStatusSchema.optional(),
});
export type UpdateDocumentCommentRequest = z.infer<
  typeof updateDocumentCommentRequestSchema
>;

/**
 * Universal document identity across viewing surfaces (reference docs + Kiro
 * specs), keyed by a normalized worktree-relative `docPath`.
 */
export const documentRefSchema = z.object({
  projectName: z.string(),
  sessionName: z.string(),
  docPath: z.string(),
  title: z.string(),
});
export type DocumentRef = z.infer<typeof documentRefSchema>;

/**
 * The chosen send destination. Carries the FULL routing identity because the
 * picker lists conversations cross-project while prompt/queue routes are
 * project/session-scoped — a bare conversation id cannot route a send. Derived
 * from the `ConversationListItem` the picker already holds.
 */
export const documentFeedbackTargetSchema = z.object({
  projectName: z.string(),
  projectPath: z.string(),
  sessionName: z.string(),
  conversationId: z.string(),
  backend: agentBackendSchema,
  status: conversationStatusSchema,
});
export type DocumentFeedbackTarget = z.infer<
  typeof documentFeedbackTargetSchema
>;

/**
 * The feedback item/payload schemas are defined in the leaf content-block module
 * (`message-content-schemas`) so the transcript's `document_feedback` block can
 * reference them without an import cycle. They remain part of the
 * document-comments domain surface and are re-exported here for its consumers.
 */
export {
  documentFeedbackItemSchema,
  documentFeedbackPayloadSchema,
  type DocumentFeedbackItem,
  type DocumentFeedbackPayload,
} from "@/lib/conversations/message-content-schemas";
