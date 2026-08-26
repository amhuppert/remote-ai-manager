import { z } from "zod";

import { graphWorkflowTaskStatusSchema } from "@/lib/workflow-graph/spec-bridge";

import {
  specApprovalValiditySchema,
  specAuthoringStageSchema,
  specExecutionStateSchema,
  specRevisionStateSchema,
} from "./schemas";
import {
  authoringFacetSchema,
  deliveryDisplaySchema,
  specPhasePrimarySchema,
  specPhaseProjectionSchema,
  type AuthoringFacet,
  type DeliveryDisplay,
  type SpecPhasePrimary,
  type SpecPhaseProjection,
} from "./phase-view-schemas";

export {
  authoringFacetSchema,
  deliveryDisplaySchema,
  specPhasePrimarySchema,
  specPhaseProjectionSchema,
};
export type {
  AuthoringFacet,
  DeliveryDisplay,
  SpecPhasePrimary,
  SpecPhaseProjection,
};

export const deliveryCriterionStateSchema = z.enum([
  "pending",
  "proven_and_merged",
  /**
   * The criterion's work shipped outside this system, on the strength of an
   * imported spec's external-delivery record. It is its own state rather than
   * a second way to be `proven_and_merged` because nothing here verified it:
   * it discharges the criterion's obligation to be pending, never its
   * obligation to be proven.
   */
  "delivered_externally",
  "waived",
]);
export type DeliveryCriterionState = z.infer<
  typeof deliveryCriterionStateSchema
>;

export const deliveryCriterionSchema = z
  .object({ state: deliveryCriterionStateSchema })
  .strict();
export type DeliveryCriterion = z.infer<typeof deliveryCriterionSchema>;

/**
 * A delivery criterion the display can name. The phase projection reads only
 * `state` and keeps the bare shape; the display carries the element id because
 * a surface asked to render one criterion as delivered externally has to know
 * which one, and a tally cannot say.
 */
export const identifiedDeliveryCriterionSchema = z
  .object({
    criterionElementId: z.string().min(1),
    state: deliveryCriterionStateSchema,
  })
  .strict();
export type IdentifiedDeliveryCriterion = z.infer<
  typeof identifiedDeliveryCriterionSchema
>;

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

const requirementCriterionStatusInputSchema = z
  .object({
    covered: z.boolean(),
    /**
     * `delivered_externally` is carried into the rollup rather than folded into
     * `proven` on the way: the rollup is a proof surface, and a criterion that
     * shipped on an import's testimony has to stay distinguishable from one
     * this system verified.
     */
    proof: z.enum(["pending", "proven", "waived", "delivered_externally"]),
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
    /**
     * `delivered_externally` names a fully settled requirement whose settlement
     * leans, in whole or in part, on an import's external testimony. It is not
     * a fourth way to be proven: the weakest warrant names the rollup, so a
     * requirement mixing merged proof with external delivery reads as delivered
     * externally rather than proven.
     */
    proof: z.enum([
      "pending",
      "partial",
      "proven",
      "waived",
      "proven_and_waived",
      "delivered_externally",
    ]),
  })
  .strict();
export type RequirementStatus = z.infer<typeof requirementStatusSchema>;

const executionTaskEventSchema = z
  .object({ status: graphWorkflowTaskStatusSchema })
  .strict();

export const taskWorkStatusInputSchema = z
  .object({ executionEvents: z.array(executionTaskEventSchema) })
  .strict();
export type TaskWorkStatusInput = z.infer<typeof taskWorkStatusInputSchema>;

export const taskWorkStatusSchema = z
  .object({ status: graphWorkflowTaskStatusSchema })
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
  criteria: IdentifiedDeliveryCriterion[],
): DeliveryDisplay {
  return {
    allWaived:
      criteria.length > 0 && criteria.every(({ state }) => state === "waived"),
    deliveredCount: criteria.filter(
      ({ state }) =>
        state === "proven_and_merged" || state === "delivered_externally",
    ).length,
    provenCount: criteria.filter(({ state }) => state === "proven_and_merged")
      .length,
    totalInScope: criteria.length,
    deliveredExternallyCriterionIds: criteria
      .filter(({ state }) => state === "delivered_externally")
      .map(({ criterionElementId }) => criterionElementId),
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
  const deliveredExternallyCount = input.criteria.filter(
    ({ proof }) => proof === "delivered_externally",
  ).length;

  return {
    approval: input.approvalValidity ?? "unapproved",
    coverage: projectCoverage(coveredCount, input.criteria.length),
    proof: projectProof({
      provenCount,
      waivedCount,
      deliveredExternallyCount,
      totalCount: input.criteria.length,
    }),
  };
}

export function projectTaskWorkStatus(
  input: TaskWorkStatusInput,
): TaskWorkStatus {
  return { status: input.executionEvents.at(-1)?.status ?? "pending" };
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

function projectProof({
  provenCount,
  waivedCount,
  deliveredExternallyCount,
  totalCount,
}: {
  provenCount: number;
  waivedCount: number;
  deliveredExternallyCount: number;
  totalCount: number;
}): RequirementStatus["proof"] {
  const settledCount = provenCount + waivedCount + deliveredExternallyCount;
  if (totalCount === 0 || settledCount === 0) {
    return "pending";
  }
  if (settledCount < totalCount) {
    return "partial";
  }
  // Ahead of the proof answers on purpose: once external testimony settles any
  // part of a requirement, no label above it can be honestly claimed.
  if (deliveredExternallyCount > 0) {
    return "delivered_externally";
  }
  if (provenCount === totalCount) {
    return "proven";
  }
  if (waivedCount === totalCount) {
    return "waived";
  }

  return "proven_and_waived";
}
