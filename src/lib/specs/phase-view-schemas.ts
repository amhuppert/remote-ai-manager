import { z } from "zod";

import { specAuthoringStageSchema } from "./schemas";

export const specPhasePrimarySchema = z.enum([
  "abandoned",
  "executing",
  "draft",
  "delivered",
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

export const deliveryDisplaySchema = z
  .object({
    allWaived: z.boolean(),
    /**
     * Criteria whose delivery has landed by any route — merged proof or an
     * import's external testimony. This is the tally a "delivered" label reads.
     */
    deliveredCount: z.number().int().nonnegative(),
    /**
     * Criteria this system proved and saw merged. Kept apart from
     * `deliveredCount` so a proof-oriented surface cannot report external
     * testimony as proof it never took.
     */
    provenCount: z.number().int().nonnegative(),
    totalInScope: z.number().int().nonnegative(),
    /**
     * The criteria whose delivery rests on an import's external testimony,
     * named rather than merely counted so a surface can render exactly those
     * as delivered externally. Required rather than defaulted: an empty
     * default would read a truncated payload as nothing delivered externally,
     * which is the direction that hides import provenance.
     */
    deliveredExternallyCriterionIds: z.array(z.string().min(1)),
  })
  .strict();
export type DeliveryDisplay = z.infer<typeof deliveryDisplaySchema>;
