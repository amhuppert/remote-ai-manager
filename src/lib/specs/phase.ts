import { z } from "zod";

import {
  specApprovalValiditySchema,
  specAuthoringStageSchema,
  specRevisionStateSchema,
} from "./schemas";
import {
  specPhaseProjectionSchema,
  type SpecPhasePrimary,
  type SpecPhaseProjection,
} from "./phase-view-schemas";

export { specPhaseProjectionSchema };
export type { SpecPhasePrimary, SpecPhaseProjection };

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
  })
  .strict();
export type SpecPhaseInput = z.infer<typeof specPhaseInputSchema>;

export const requirementStatusInputSchema = z
  .object({
    approvalValidity: specApprovalValiditySchema.nullable(),
  })
  .strict();
export type RequirementStatusInput = z.infer<
  typeof requirementStatusInputSchema
>;

export const requirementStatusSchema = z
  .object({
    approval: z.union([z.literal("unapproved"), specApprovalValiditySchema]),
  })
  .strict();
export type RequirementStatus = z.infer<typeof requirementStatusSchema>;

export function projectSpecPhase(input: SpecPhaseInput): SpecPhaseProjection {
  const authoringStage = resolveAuthoringStage(input.revisions);
  return withAuthoringStage(
    {
      primary: input.abandoned
        ? "abandoned"
        : input.revisions.some(({ state }) => state === "draft") ||
            !input.revisions.some(({ state }) => state === "approved")
          ? "draft"
          : "approved",
    },
    authoringStage,
  );
}

export function projectRequirementStatus(
  input: RequirementStatusInput,
): RequirementStatus {
  return { approval: input.approvalValidity ?? "unapproved" };
}

function resolveAuthoringStage(
  revisions: SpecPhaseInput["revisions"],
): SpecPhaseProjection["authoringStage"] {
  for (const state of ["draft", "approved"] as const) {
    const revision = revisions
      .toReversed()
      .find((candidate) => candidate.state === state);
    if (revision !== undefined) {
      return revision.authoringStage === "plan"
        ? undefined
        : revision.authoringStage;
    }
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
