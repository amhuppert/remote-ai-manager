import { z } from "zod";

// ============================================================
// Graph plan review record (#69 change 5)
//
// A terminal verdict bound to the exact plan revision it judged. Only terminal
// states are representable — there is no draft and no canceled verdict —
// because the incident this record exists for is a canceled, artifact-less
// review presented as a completed verdict. A review that did not conclude
// simply has no row.
//
// The record is advisory: nothing here checks that the reviewer conversation
// exists or that a hash corresponds to a stored plan. Both would be new
// fail-closed paths on a mechanism whose whole point is to record, not to
// refuse.
// ============================================================

/** The canonical digest shape `workingDefinitionHash` emits. */
export const PLAN_DEFINITION_HASH_PATTERN = /^sha256:[a-f0-9]{64}$/;

export const graphPlanReviewVerdictSchema = z.enum([
  "approved",
  "changes_requested",
]);

export const graphPlanReviewSchema = z
  .object({
    id: z.string().min(1),
    /**
     * The reviewed revision's identity: `workingDefinitionHash` over the
     * canonical definition. Storing the digest rather than a plan id is what
     * lets a later submission ask "is this still the bytes that were judged?"
     * with one comparison.
     */
    definitionHash: z.string().regex(PLAN_DEFINITION_HASH_PATTERN, {
      message:
        "definitionHash must be a canonical sha256 digest: 'sha256:' followed by 64 lowercase hex characters",
    }),
    /**
     * The reviewing conversation's id. `cctl conversation read` and the
     * compaction commands resolve the owning project and session from a bare
     * conversation id, so the id alone is the complete reference. Shape only —
     * an existence check at record time would refuse a review over a lookup.
     */
    reviewerConversationId: z.string().min(1),
    verdict: graphPlanReviewVerdictSchema,
    /** The findings artifact text; `null` only for an approved verdict. */
    findings: z.string().nullable(),
    reviewedAt: z.iso.datetime(),
  })
  .strict()
  .superRefine((record, ctx) => {
    if (record.verdict !== "changes_requested") return;
    if (record.findings !== null && record.findings.trim().length > 0) return;
    ctx.addIssue({
      code: "custom",
      path: ["findings"],
      message:
        "a changes_requested verdict must carry its findings artifact; a verdict without the artifact that justifies it is the shape this record exists to make unrepresentable",
    });
  });
export type GraphPlanReview = z.infer<typeof graphPlanReviewSchema>;
