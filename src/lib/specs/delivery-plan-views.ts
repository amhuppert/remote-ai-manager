import { z } from "zod";

import { workflowSemanticDefinitionSchema } from "@/lib/workflow-graph/definition-schemas";
import {
  deliveryPlanApprovalSchema,
  deliveryPlanCandidateIdentitySchema,
  deliveryPlanDispositionSchema,
  deliveryPlanDocumentSchema,
} from "./delivery-plan";
import {
  actorProvenanceSchema,
  deliveryPlanAttemptStatusSchema,
  resolvedGateDialSchema,
  specGateAdmissionBasisSchema,
} from "./schemas";
import { deliveryPlanDocumentDiffSchema } from "./delivery-plan-diff";
import { lintFindingSchema } from "./view-schemas";

/**
 * The wire contract for the `spec plan` verbs. The service returns it and the
 * CLI parses it, so a server and a CLI of different builds disagree loudly
 * rather than rendering a half-understood receipt.
 *
 * There is one view for reads and mutations alike: what a caller needs to know
 * after an edit is the same thing `spec plan status` reports, plus what the
 * write moved. Two shapes would be two chances for the propose refusal and the
 * status tier to disagree about whether the plan is proposable.
 */

const nonNegativeInt = z.number().int().nonnegative();

export const deliveryPlanHealthViewSchema = z
  .object({
    total: nonNegativeInt,
    blocking: nonNegativeInt,
    counts: z.array(
      z
        .object({
          severity: lintFindingSchema.shape.severity,
          count: z.number().int().positive(),
        })
        .strict(),
    ),
    /** Every finding, severity-ranked. Read surfaces cap; the wire does not. */
    findings: z.array(lintFindingSchema),
  })
  .strict();
export type DeliveryPlanHealthView = z.infer<
  typeof deliveryPlanHealthViewSchema
>;

export const deliveryPlanAttemptViewSchema = z
  .object({
    id: z.string().min(1),
    specSlug: z.string().min(1),
    status: deliveryPlanAttemptStatusSchema,
    /** Compare-and-swap token an edit must carry. */
    draftRevision: z.number().int().positive(),
    pinnedRevisionId: z.string().min(1),
    deltaBasisExecutionId: z.string().min(1).nullable(),
    proposedSnapshotId: z.string().min(1).nullable(),
    /** The live proposal's identity; null while the attempt is a draft. */
    planHash: z.string().min(1).nullable(),
    /**
     * The hash of the compiled candidate the live proposal stored — the bytes
     * an approval binds to and a launch runs. Null while drafting, for the same
     * reason `planHash` is: a draft has frozen nothing.
     */
    compiledDefinitionHash: z.string().min(1).nullable(),
    /**
     * The row those bytes live in. Carried beside the two hashes because an
     * approval binds all three parts of the candidate identity — a surface
     * that must state what it is approving needs the whole of it
     * (`exact-approval`).
     */
    candidateId: z.string().min(1).nullable(),
    launchedExecutionId: z.string().min(1).nullable(),
    createdAt: z.string().min(1),
    updatedAt: z.string().min(1),
  })
  .strict();
export type DeliveryPlanAttemptView = z.infer<
  typeof deliveryPlanAttemptViewSchema
>;

export const deliveryPlanSnapshotViewSchema = z
  .object({
    id: z.string().min(1),
    draftRevision: z.number().int().positive(),
    planHash: z.string().min(1),
    proposedAt: z.string().min(1),
  })
  .strict();
export type DeliveryPlanSnapshotView = z.infer<
  typeof deliveryPlanSnapshotViewSchema
>;

/**
 * A criterion whose disposition a human still owes an act on. Separate from
 * the lint findings because it is the enumerated worklist a status read is
 * for, while the finding is the sentence that refuses the transition.
 */
export const deliveryPlanUnresolvedViewSchema = z
  .object({
    criterionElementId: z.string().min(1),
    handle: z.string().min(1),
    disposition: deliveryPlanDispositionSchema,
    resolution: z.string().min(1),
  })
  .strict();
export type DeliveryPlanUnresolvedView = z.infer<
  typeof deliveryPlanUnresolvedViewSchema
>;

/**
 * The act this attempt owes next and who performs it. Every status carries
 * one — a plan surface that reports a state without naming its exit is the
 * dead end this workstream exists to remove.
 */
export const deliveryPlanNextActSchema = z
  .object({
    actor: z.enum(["agent", "human"]),
    command: z.string().min(1),
    reason: z.string().min(1),
  })
  .strict();
export type DeliveryPlanNextAct = z.infer<typeof deliveryPlanNextActSchema>;

/**
 * The prelaunch inventory a parked attempt carries. `candidateChanged` and
 * `currentCompiledDefinitionHash` are read-time projections over the two
 * immutable identities, never persisted classifications
 * (`computed-projections`): the parked hash lives on the attempt, the current
 * one is read off the live candidate, and the comparison is made when someone
 * asks. That is what lets a receipt name old AND new hashes after a reopen has
 * already cleared the approval.
 */
export const deliveryPlanPrelaunchViewSchema = z
  .object({
    parkedAt: z.string().min(1),
    parkedBy: actorProvenanceSchema,
    reason: z.string().nullable(),
    approvedAtPark: z.boolean(),
    parkedCandidateId: z.string().min(1),
    parkedPlanHash: z.string().min(1),
    parkedCompiledDefinitionHash: z.string().min(1),
    /** Null when the attempt has since been reopened and not re-proposed. */
    currentCompiledDefinitionHash: z.string().min(1).nullable(),
    candidateChanged: z.boolean(),
  })
  .strict();
export type DeliveryPlanPrelaunchView = z.infer<
  typeof deliveryPlanPrelaunchViewSchema
>;

export const deliveryPlanViewSchema = z
  .object({
    attempt: deliveryPlanAttemptViewSchema,
    approval: deliveryPlanApprovalSchema.nullable(),
    /** Present only once `spec start --park` has held this attempt. */
    prelaunch: deliveryPlanPrelaunchViewSchema.nullable(),
    document: deliveryPlanDocumentSchema,
    health: deliveryPlanHealthViewSchema,
    dispositionCounts: z.array(
      z
        .object({
          disposition: deliveryPlanDispositionSchema,
          count: z.number().int().positive(),
        })
        .strict(),
    ),
    unresolved: z.array(deliveryPlanUnresolvedViewSchema),
    snapshots: z.array(deliveryPlanSnapshotViewSchema),
    nextAct: deliveryPlanNextActSchema,
    /**
     * The wiring ownership resolved per context — the list that renders into
     * the owning context's validator pack, carried here so Studio and the CLI
     * read the same resolution rather than each walking the document.
     */
    wiringByContext: z.array(
      z
        .object({
          contextId: z.string().min(1),
          entries: z.array(z.string().min(1)),
        })
        .strict(),
    ),
  })
  .strict();
export type DeliveryPlanView = z.infer<typeof deliveryPlanViewSchema>;

/**
 * A criterion the legacy plan reached from what are now separate contexts. The
 * import refuses to pick an owner, so the entry names the contenders and the
 * act that settles it.
 */
export const deliveryPlanSplitRequirementSchema = z
  .object({
    criterionElementId: z.string().min(1),
    handle: z.string().min(1),
    contextIds: z.array(z.string().min(1)),
    resolution: z.string().min(1),
  })
  .strict();
export type DeliveryPlanSplitRequirementView = z.infer<
  typeof deliveryPlanSplitRequirementSchema
>;

/**
 * What a seeded open lifted out of a legacy approved evergreen plan, reported
 * once by the act that did it. It is not attempt state: the durable backstop
 * for an unresolved split is the plan lint's `plan/selected-unowned` finding,
 * which every later status read reports on its own.
 */
export const deliveryPlanLegacyImportViewSchema = z
  .object({
    sourceExecutionId: z.string().min(1),
    sourceRevisionId: z.string().min(1),
    contextCount: nonNegativeInt,
    taskCount: nonNegativeInt,
    requiresHumanSplit: z.array(deliveryPlanSplitRequirementSchema),
    /** Anything the import could not carry, stated rather than dropped. */
    notes: z.array(z.string().min(1)),
  })
  .strict();
export type DeliveryPlanLegacyImportView = z.infer<
  typeof deliveryPlanLegacyImportViewSchema
>;

/**
 * What a write left behind: the resulting view plus the health it moved from
 * and the approval it took away. Both are absent on a read, which is exactly
 * the difference between reporting a state and reporting a change.
 */
export const deliveryPlanMutationViewSchema = deliveryPlanViewSchema
  .extend({
    previousHealth: z
      .object({ total: nonNegativeInt, blocking: nonNegativeInt })
      .strict()
      .nullable(),
    invalidatedApproval: z
      .object({
        snapshotId: z.string().min(1),
        planHash: z.string().min(1),
      })
      .strict()
      .nullable(),
    /** Present only on the open that imported a legacy plan. */
    legacyImport: deliveryPlanLegacyImportViewSchema.nullable(),
    /**
     * What the sign-off did to the `execution_start` gate, present only on
     * that act. It is reported rather than inferred from the dial so a receipt
     * can state plainly that no second gate remains: either a human approval
     * was recorded, or policy admitted the gate on its own basis.
     */
    executionStartAdmission: z
      .object({
        dial: resolvedGateDialSchema,
        basis: specGateAdmissionBasisSchema,
        admissionId: z.string().min(1),
        approvalId: z.string().min(1).nullable(),
      })
      .strict()
      .nullable(),
  })
  .strict();
export type DeliveryPlanMutationView = z.infer<
  typeof deliveryPlanMutationViewSchema
>;

/**
 * The request documents, owned here rather than at the route so the CLI's
 * `--file` parse and the server's body parse are literally the same schema.
 */
export const deliveryPlanOpenRequestSchema = z
  .object({ seedFromLast: z.boolean() })
  .strict();

/**
 * A plan edit writes the whole document, so its compare-and-swap token rides
 * in the document the way a draft element's `baseElementVersion` does: the
 * caller states the draft revision it read, and an edit against a revision the
 * attempt has moved past is refused rather than silently applied.
 */
export const deliveryPlanEditRequestSchema = z
  .object({
    expectedDraftRevision: z.number().int().positive(),
    document: deliveryPlanDocumentSchema,
  })
  .strict();
export type DeliveryPlanEditRequest = z.infer<
  typeof deliveryPlanEditRequestSchema
>;

export const deliveryPlanReopenRequestSchema = z
  .object({ reason: z.string().min(1) })
  .strict();

/**
 * The sign-off document. It names the candidate the caller read rather than
 * "the current proposal": a sign-off that resolved its own target would
 * approve whatever was proposed last, which is exactly the substitution
 * `exact-approval` refuses.
 */
export const deliveryPlanSignOffRequestSchema =
  deliveryPlanCandidateIdentitySchema;
export type DeliveryPlanSignOffRequest = z.infer<
  typeof deliveryPlanSignOffRequestSchema
>;

/**
 * A context-anchored review note. The anchor is stated by the caller rather
 * than resolved here so a note can be written against a context id the current
 * document no longer carries — which is exactly what an orphan anchor is.
 */
export const deliveryPlanCommentRequestSchema = z
  .object({
    contextId: z.string().min(1).max(120),
    body: z.string().min(1).max(4000),
  })
  .strict();
export type DeliveryPlanCommentRequest = z.infer<
  typeof deliveryPlanCommentRequestSchema
>;

/**
 * Two attempt snapshots compared. The refs carry the draft revision and plan
 * hash of each side so a reader can tell WHICH proposals were compared without
 * a second lookup — a diff labelled only by opaque snapshot ids is a diff
 * nobody can cite.
 */
export const deliveryPlanSnapshotDiffViewSchema = z
  .object({
    from: deliveryPlanSnapshotViewSchema,
    to: deliveryPlanSnapshotViewSchema,
    diff: deliveryPlanDocumentDiffSchema,
  })
  .strict();
export type DeliveryPlanSnapshotDiffView = z.infer<
  typeof deliveryPlanSnapshotDiffViewSchema
>;

/**
 * The criterion one reaffirmation act addresses. Only the id: the basis, the
 * actor and the timestamp are the server's to record, because a client that
 * stated them could attest to a basis it never read.
 */
export const deliveryPlanReaffirmRequestSchema = z
  .object({ criterionElementId: z.string().min(1) })
  .strict();
export type DeliveryPlanReaffirmRequest = z.infer<
  typeof deliveryPlanReaffirmRequestSchema
>;

/**
 * The two preview stages, which are two different questions:
 *
 * - `draft` compiles the editable document as it stands right now, under a
 *   compare-and-swap token so the answer names the revision it read. It is
 *   never approvable — the bytes it shows have no frozen snapshot behind them
 *   and would be gone the moment the author saved again.
 * - `proposed` reads the stored candidate and nothing else. It never
 *   re-materializes, because a preview that recompiles is a preview that can
 *   disagree with the thing a human is about to approve (`exact-approval`).
 */
export const deliveryPlanPreviewStageSchema = z.enum(["draft", "proposed"]);
export type DeliveryPlanPreviewStage = z.infer<
  typeof deliveryPlanPreviewStageSchema
>;

export const deliveryPlanPackManifestViewSchema = z
  .object({
    contextId: z.string().min(1),
    total: nonNegativeInt,
    included: nonNegativeInt,
    omitted: nonNegativeInt,
  })
  .strict();

export const deliveryPlanPreviewViewSchema = z
  .object({
    stage: deliveryPlanPreviewStageSchema,
    attemptId: z.string().min(1),
    specSlug: z.string().min(1),
    draftRevision: z.number().int().positive(),
    pinnedRevisionId: z.string().min(1),
    planHash: z.string().min(1),
    /** Present only for a proposed preview; a draft has frozen nothing. */
    snapshotId: z.string().min(1).nullable(),
    candidateId: z.string().min(1).nullable(),
    compiledDefinitionHash: z.string().min(1),
    approvable: z.boolean(),
    /** Why this preview is or is not the thing an approval would bind to. */
    approvability: z.string().min(1),
    definition: workflowSemanticDefinitionSchema,
    packManifests: z.array(deliveryPlanPackManifestViewSchema),
  })
  .strict();
export type DeliveryPlanPreviewView = z.infer<
  typeof deliveryPlanPreviewViewSchema
>;

export const deliveryPlanPreviewRequestSchema = z
  .object({
    stage: deliveryPlanPreviewStageSchema,
    /**
     * The draft revision the caller read. Optional so an interactive preview
     * stays one command, required in spirit for anything that will act on the
     * bytes it returns.
     */
    expectedDraftRevision: z.number().int().positive().optional(),
  })
  .strict();
export type DeliveryPlanPreviewRequest = z.infer<
  typeof deliveryPlanPreviewRequestSchema
>;
