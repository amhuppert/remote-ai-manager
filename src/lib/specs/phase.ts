import { z } from "zod";

import { graphWorkflowTaskStatusSchema } from "@/lib/workflow-graph/definition-schemas";

import {
  specApprovalValiditySchema,
  specAuthoringStageSchema,
  specExecutionStateSchema,
  specRevisionStateSchema,
  specTaskClaimStatusSchema,
} from "./schemas";

export const deliveryCriterionStateSchema = z.enum([
  "pending",
  "proven_and_merged",
  "waived",
]);
export type DeliveryCriterionState = z.infer<
  typeof deliveryCriterionStateSchema
>;

export const deliveryCriterionSchema = z
  .object({ state: deliveryCriterionStateSchema })
  .strict();
export type DeliveryCriterion = z.infer<typeof deliveryCriterionSchema>;

export const specPhaseInputSchema = z
  .object({
    abandoned: z.boolean(),
    revisions: z.array(
      z
        .object({
          state: specRevisionStateSchema,
          authoringStage: specAuthoringStageSchema,
        })
        .strict(),
    ),
    executionStates: z.array(specExecutionStateSchema),
    deliveryCriteria: z.array(deliveryCriterionSchema),
    deliveryPending: z.boolean(),
  })
  .strict();
export type SpecPhaseInput = z.infer<typeof specPhaseInputSchema>;

export const specPhasePrimarySchema = z.enum([
  "abandoned",
  "executing",
  "in_review",
  "draft",
  "delivered",
  "approved",
]);
export type SpecPhasePrimary = z.infer<typeof specPhasePrimarySchema>;

export const authoringFacetSchema = z.enum(["in_review", "draft"]);
export type AuthoringFacet = z.infer<typeof authoringFacetSchema>;

export const specPhaseProjectionSchema = z
  .object({
    primary: specPhasePrimarySchema,
    authoringFacet: authoringFacetSchema.optional(),
    authoringStage: specAuthoringStageSchema.optional(),
  })
  .strict();
export type SpecPhaseProjection = z.infer<typeof specPhaseProjectionSchema>;

export const deliveryDisplaySchema = z
  .object({
    allWaived: z.boolean(),
    provenCount: z.number().int().nonnegative(),
    totalInScope: z.number().int().nonnegative(),
  })
  .strict();
export type DeliveryDisplay = z.infer<typeof deliveryDisplaySchema>;

const requirementCriterionStatusInputSchema = z
  .object({
    covered: z.boolean(),
    proof: z.enum(["pending", "proven", "waived"]),
  })
  .strict();

export const requirementStatusInputSchema = z
  .object({
    approvalValidity: specApprovalValiditySchema.nullable(),
    criteria: z.array(requirementCriterionStatusInputSchema),
  })
  .strict();
export type RequirementStatusInput = z.infer<
  typeof requirementStatusInputSchema
>;

export const requirementStatusSchema = z
  .object({
    approval: z.union([z.literal("unapproved"), specApprovalValiditySchema]),
    coverage: z.enum(["uncovered", "partial", "covered"]),
    proof: z.enum([
      "pending",
      "partial",
      "proven",
      "waived",
      "proven_and_waived",
    ]),
  })
  .strict();
export type RequirementStatus = z.infer<typeof requirementStatusSchema>;

const executionTaskEventSchema = z
  .object({ status: graphWorkflowTaskStatusSchema })
  .strict();

const taskClaimProjectionSchema = z
  .object({
    status: specTaskClaimStatusSchema,
    evidenceIds: z.array(z.string().min(1)),
  })
  .strict();

export const taskWorkStatusInputSchema = z
  .object({
    executionEvents: z.array(executionTaskEventSchema),
    latestClaim: taskClaimProjectionSchema.nullable(),
  })
  .strict();
export type TaskWorkStatusInput = z.infer<typeof taskWorkStatusInputSchema>;

export const taskWorkStatusSchema = z
  .object({
    status: z.union([
      graphWorkflowTaskStatusSchema,
      z.enum(["claimed", "reopened"]),
    ]),
    claimEvidenceIds: z.array(z.string().min(1)),
  })
  .strict();
export type TaskWorkStatus = z.infer<typeof taskWorkStatusSchema>;

export function projectSpecPhase(input: SpecPhaseInput): SpecPhaseProjection {
  const authoringFacet = resolveAuthoringFacet(input.revisions);
  const authoringStage = resolveAuthoringStage(input.revisions);
  if (input.abandoned) {
    return withAuthoringStage({ primary: "abandoned" }, authoringStage);
  }

  const executionActive = input.executionStates.some(
    (state) => state === "definition_review" || state === "running",
  );
  if (executionActive) {
    return withAuthoringStage(
      authoringFacet === undefined
        ? { primary: "executing" }
        : { primary: "executing", authoringFacet },
      authoringStage,
    );
  }

  if (authoringFacet !== undefined) {
    return withAuthoringStage({ primary: authoringFacet }, authoringStage);
  }

  const approvedRevisionExists = input.revisions.some(
    ({ state }) => state === "approved",
  );
  const deliverySatisfied =
    input.deliveryCriteria.length > 0 &&
    input.deliveryCriteria.every(({ state }) => state !== "pending");
  if (approvedRevisionExists && deliverySatisfied && !input.deliveryPending) {
    return withAuthoringStage({ primary: "delivered" }, authoringStage);
  }

  return withAuthoringStage({ primary: "approved" }, authoringStage);
}

export function projectDeliveryDisplay(
  criteria: DeliveryCriterion[],
): DeliveryDisplay {
  return {
    allWaived:
      criteria.length > 0 && criteria.every(({ state }) => state === "waived"),
    provenCount: criteria.filter(({ state }) => state === "proven_and_merged")
      .length,
    totalInScope: criteria.length,
  };
}

export function projectRequirementStatus(
  input: RequirementStatusInput,
): RequirementStatus {
  const coveredCount = input.criteria.filter(({ covered }) => covered).length;
  const provenCount = input.criteria.filter(
    ({ proof }) => proof === "proven",
  ).length;
  const waivedCount = input.criteria.filter(
    ({ proof }) => proof === "waived",
  ).length;

  return {
    approval: input.approvalValidity ?? "unapproved",
    coverage: projectCoverage(coveredCount, input.criteria.length),
    proof: projectProof(provenCount, waivedCount, input.criteria.length),
  };
}

export function projectTaskWorkStatus(
  input: TaskWorkStatusInput,
): TaskWorkStatus {
  if (input.latestClaim?.status === "accepted") {
    return {
      status: "claimed",
      claimEvidenceIds: [...input.latestClaim.evidenceIds],
    };
  }

  if (input.latestClaim?.status === "reopened") {
    return {
      status: "reopened",
      claimEvidenceIds: [...input.latestClaim.evidenceIds],
    };
  }

  return {
    status: input.executionEvents.at(-1)?.status ?? "pending",
    claimEvidenceIds: [],
  };
}

function resolveAuthoringFacet(
  revisions: SpecPhaseInput["revisions"],
): AuthoringFacet | undefined {
  if (revisions.some(({ state }) => state === "proposed")) {
    return "in_review";
  }
  if (revisions.some(({ state }) => state === "draft")) {
    return "draft";
  }

  return undefined;
}

function resolveAuthoringStage(
  revisions: SpecPhaseInput["revisions"],
): SpecPhaseProjection["authoringStage"] {
  if (
    revisions.some(
      ({ state, authoringStage }) =>
        state === "approved" && authoringStage === "plan",
    )
  ) {
    return undefined;
  }

  for (const state of ["proposed", "draft", "approved"] as const) {
    const revision = revisions
      .toReversed()
      .find((candidate) => candidate.state === state);
    if (revision !== undefined) return revision.authoringStage;
  }
  return undefined;
}

function withAuthoringStage(
  projection: SpecPhaseProjection,
  authoringStage: SpecPhaseProjection["authoringStage"],
): SpecPhaseProjection {
  return authoringStage === undefined
    ? projection
    : { ...projection, authoringStage };
}

function projectCoverage(
  coveredCount: number,
  totalCount: number,
): RequirementStatus["coverage"] {
  if (coveredCount === 0 || totalCount === 0) {
    return "uncovered";
  }
  if (coveredCount === totalCount) {
    return "covered";
  }

  return "partial";
}

function projectProof(
  provenCount: number,
  waivedCount: number,
  totalCount: number,
): RequirementStatus["proof"] {
  if (totalCount === 0 || provenCount + waivedCount === 0) {
    return "pending";
  }
  if (provenCount === totalCount) {
    return "proven";
  }
  if (waivedCount === totalCount) {
    return "waived";
  }
  if (provenCount + waivedCount === totalCount) {
    return "proven_and_waived";
  }

  return "partial";
}
