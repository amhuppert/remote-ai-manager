import { z } from "zod";

import type { WorkflowSemanticDefinition } from "@/lib/workflow-graph/definition-schemas";
import { workingDefinitionHash } from "@/lib/workflow-graph/working-definition-hash";
import {
  authoredDeliveryPlanSources,
  isServerOwnedDeliveryPlanDocument,
} from "@/lib/specs/delivery-plan-finalization";

import {
  validateWorkflowPlan,
  type WorkflowPlanIssue,
  type WorkflowPlanValidationOptions,
} from "../plan-validation";

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
//
// Server-side only — `planDefinitionHash` reaches `node:crypto` through
// `workingDefinitionHash`, which no browser bundle can carry.
// ============================================================

/** The canonical digest shape `workingDefinitionHash` emits. */
export const PLAN_DEFINITION_HASH_PATTERN = /^sha256:[a-f0-9]{64}$/;

export const graphPlanReviewVerdictSchema = z.enum([
  "approved",
  "changes_requested",
]);
export type GraphPlanReviewVerdict = z.infer<
  typeof graphPlanReviewVerdictSchema
>;

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

/**
 * The hash, or the reasons the plan could not be hashed. Never throws: every
 * caller is on an advisory path, and a malformed plan is already refused by
 * the validation it shares with create/replace.
 */
export type PlanDefinitionHashResult =
  | { ok: true; hash: string }
  | { ok: false; issues: WorkflowPlanIssue[] };

/**
 * The review identity of an ALREADY-canonical definition — for callers that
 * have run the shared admission and hold its canonical draft, so re-validating
 * to recover the same bytes would be pure waste.
 *
 * Both entry points funnel here so create/replace and the review verb cannot
 * drift into two digests of one revision.
 */
export function canonicalPlanDefinitionHash(
  definition: WorkflowSemanticDefinition,
): string {
  const authored = { ...definition };
  if (definition.origin?.sourceUri.startsWith("spec-plan://")) {
    delete authored.origin;
    delete authored.lockedRegions;
    delete authored.approvalRequired;
    authored.charter = {
      ...definition.charter,
      sourcesOfTruth: authoredDeliveryPlanSources(
        definition.charter.sourcesOfTruth,
      ),
    };
    if (definition.seededDocuments !== undefined)
      authored.seededDocuments = definition.seededDocuments.filter(
        (document) => !isServerOwnedDeliveryPlanDocument(document.relativePath),
      );
  }
  if (authored.seededDocuments?.length === 0) delete authored.seededDocuments;
  return workingDefinitionHash(authored);
}

/**
 * The one place a plan body becomes a review identity. Hashing the CANONICAL
 * definition `validateWorkflowPlan` returns — not the submitted bytes — is
 * what makes the identity stable: key order, and the prose/records spelling of
 * acceptance criteria, are two encodings of one revision, and a review bound
 * to one of them must bind to the other.
 */
export function planDefinitionHash(
  rawBody: unknown,
  options: WorkflowPlanValidationOptions = {},
): PlanDefinitionHashResult {
  const validated = validateWorkflowPlan(rawBody, options);
  if (!validated.ok) return { ok: false, issues: validated.issues };
  return {
    ok: true,
    hash: canonicalPlanDefinitionHash(validated.draft.definition),
  };
}
