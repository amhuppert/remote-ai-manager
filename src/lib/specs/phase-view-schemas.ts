import { z } from "zod";

import { specAuthoringStageSchema } from "./schemas";

export const specPhasePrimarySchema = z.enum([
  "abandoned",
  "draft",
  "approved",
]);
export type SpecPhasePrimary = z.infer<typeof specPhasePrimarySchema>;

export const authoringFacetSchema = z.enum(["draft"]);
export type AuthoringFacet = z.infer<typeof authoringFacetSchema>;

export const specPhaseProjectionSchema = z
  .object({
    primary: specPhasePrimarySchema,
    authoringFacet: authoringFacetSchema.optional(),
    authoringStage: specAuthoringStageSchema.optional(),
  })
  .strict();
export type SpecPhaseProjection = z.infer<typeof specPhaseProjectionSchema>;
