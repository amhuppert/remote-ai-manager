import { z } from "zod";

// ============================================================
// Plan review WIRE contract (#69 change 5)
//
// Kept apart from `./schemas` so this file stays free of `node:crypto`:
// `./schemas` reaches the builtin through `workingDefinitionHash`, and the
// `cctl` bundle and any future client surface need the response shapes without
// dragging plan validation and hashing along with them.
//
// Every shape here describes an ADVISORY answer. `unreviewed` is an ordinary
// state, not an error — a revision nobody reviewed reads back as unreviewed on
// every surface, and so does a revision whose lookup failed.
// ============================================================

/** The two fields a REVIEWED revision adds; shared by both verdict branches. */
const reviewedAdvisoryFields = {
  reviewerConversationId: z.string().min(1),
  reviewedAt: z.iso.datetime(),
};

/**
 * The minimal advisory the create and replace responses carry: enough to print
 * one line, deliberately without the findings artifact. An author who needs the
 * findings runs `cctl workflow review get --file <plan.json>`, which is also the
 * surface that resolves the reviewer conversation.
 */
export const planReviewAdvisorySchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("unreviewed") }).strict(),
  z
    .object({ state: z.literal("approved"), ...reviewedAdvisoryFields })
    .strict(),
  z
    .object({
      state: z.literal("changes_requested"),
      ...reviewedAdvisoryFields,
    })
    .strict(),
]);
export type PlanReviewAdvisory = z.infer<typeof planReviewAdvisorySchema>;

/**
 * One ready-to-run `cctl` invocation, carrying the emitting helper's own name
 * for it (`compaction-command` / `read-command`) rather than a name this
 * module invents, so the vocabulary has exactly one owner.
 */
export const planReviewReaderCommandSchema = z
  .object({ name: z.string().min(1), command: z.string().min(1) })
  .strict();

/**
 * How to go read the reviewer's own conversation. `resolved: false` is a
 * legitimate answer — a conversation that has been deleted, or that lives in a
 * store this server cannot see, still gets its read command, because a bare id
 * plus a note is strictly more useful than a refusal.
 */
export const planReviewReaderSchema = z
  .object({
    conversationId: z.string().min(1),
    resolved: z.boolean(),
    note: z.string().nullable(),
    commands: z.array(planReviewReaderCommandSchema),
  })
  .strict();
export type PlanReviewReader = z.infer<typeof planReviewReaderSchema>;

/** The reviewed branches of the status answer: the advisory plus the artifact. */
const reviewedStatusFields = {
  ...reviewedAdvisoryFields,
  definitionHash: z.string().min(1),
  /** The findings artifact text; `null` only for an approved verdict. */
  findings: z.string().nullable(),
  reviewer: planReviewReaderSchema,
};

/**
 * The full status answer. `definitionHash` is echoed on every branch — an
 * author revising a plan needs to see WHICH revision the answer is about, and
 * an unreviewed answer without it cannot be told from a mis-submitted body.
 */
export const planReviewStatusSchema = z.discriminatedUnion("state", [
  z
    .object({
      state: z.literal("unreviewed"),
      definitionHash: z.string().min(1),
    })
    .strict(),
  z.object({ state: z.literal("approved"), ...reviewedStatusFields }).strict(),
  z
    .object({ state: z.literal("changes_requested"), ...reviewedStatusFields })
    .strict(),
]);
export type PlanReviewStatus = z.infer<typeof planReviewStatusSchema>;

export const planReviewStatusResponseSchema = z
  .object({ status: planReviewStatusSchema })
  .strict();

export const planReviewRecordResponseSchema = z
  .object({
    id: z.string().min(1),
    definitionHash: z.string().min(1),
    verdict: z.enum(["approved", "changes_requested"]),
    reviewerConversationId: z.string().min(1),
    reviewedAt: z.iso.datetime(),
  })
  .strict();

// ============================================================
// The acknowledgement gate (#69 change 5 extension)
//
// The ONLY blocking behavior review machinery has: create and replace refuse
// the exact revision a changes-requested review rejected until the caller says,
// by hash, that they have seen that review. Everything else stays advisory —
// an unreviewed or approved revision is never gated, and a lookup that fails
// skips the gate entirely.
//
// The gate clears itself: repairing the plan changes its canonical hash, so a
// repaired successor is a different revision with no verdict against it.
// ============================================================

/** The stable refusal code create and replace emit; `cctl` branches on it. */
export const REVIEW_CHANGES_REQUESTED_UNACKNOWLEDGED_CODE =
  "review-changes-requested-unacknowledged";

/** The request field carrying the acknowledged revision hash. */
export const planReviewAcknowledgementRequestSchema = z.object({
  acknowledgeReviewHash: z.string().min(1).optional(),
});

/**
 * Stands in for the caller's own plan file in the server-built findings
 * command. The server never sees the path the plan was read from, so it emits
 * the invocation shape with an explicit placeholder the caller replaces.
 */
export const PLAN_FILE_PLACEHOLDER = "<plan.json>";

/** How a refused caller reads the findings that justify the verdict. */
export function planReviewFindingsCommand(
  planFilePath: string = PLAN_FILE_PLACEHOLDER,
): string {
  return `cctl workflow review get --file ${planFilePath}`;
}

/**
 * The refusal payload. It carries the whole verdict header plus the way to the
 * findings, because the refused caller is usually an agent with no access to
 * the reviewing conversation: a bare "no" would leave it guessing at what to
 * change.
 */
export const planReviewAcknowledgementRefusalSchema = z
  .object({
    /** The submitted revision — also the value that clears the gate. */
    definitionHash: z.string().min(1),
    verdict: z.literal("changes_requested"),
    reviewerConversationId: z.string().min(1),
    reviewedAt: z.iso.datetime(),
    findingsCommand: z.string().min(1),
  })
  .strict();
export type PlanReviewAcknowledgementRefusal = z.infer<
  typeof planReviewAcknowledgementRefusalSchema
>;
