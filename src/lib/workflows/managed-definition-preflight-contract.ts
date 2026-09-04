import { z } from "zod";

export const managedDefinitionPreflightSeveritySchema = z.enum([
  "blocks_propose",
  "blocks_signoff",
  "advisory",
]);

export const managedDefinitionPreflightFindingSchema = z
  .object({
    ruleId: z.string().min(1),
    severity: managedDefinitionPreflightSeveritySchema,
    elementHandle: z.string().min(1),
    message: z.string().min(1),
    recordId: z.string().min(1).optional(),
    rationale: z.string().min(1).optional(),
  })
  .strict();
export type ManagedDefinitionPreflightFinding = z.infer<
  typeof managedDefinitionPreflightFindingSchema
>;

export const managedDefinitionPreflightSummarySchema = z
  .object({
    selected: z.number().int().nonnegative(),
    claimed: z.number().int().nonnegative(),
    unclaimed: z.number().int().nonnegative(),
    dispositions: z.array(
      z
        .object({
          kind: z.string().min(1),
          count: z.number().int().nonnegative(),
        })
        .strict(),
    ),
    charter: z
      .object({
        state: z.enum(["authored", "seed_stub"]),
        invariantCount: z.number().int().nonnegative(),
        sourceCount: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict();
export type ManagedDefinitionPreflightSummary = z.infer<
  typeof managedDefinitionPreflightSummarySchema
>;

export const managedDefinitionPreflightRefusalCodeSchema = z.enum([
  "definition_not_managed",
  "definition_project_mismatch",
  "delivery_plan_not_draft",
]);

export const managedDefinitionPreflightRefusalSchema = z
  .object({
    code: managedDefinitionPreflightRefusalCodeSchema,
    message: z.string().min(1),
    instruction: z.string().min(1),
    rationale: z.string().min(1).optional(),
  })
  .strict();
export type ManagedDefinitionPreflightRefusal = z.infer<
  typeof managedDefinitionPreflightRefusalSchema
>;

export const managedDefinitionPreflightSuccessSchema = z
  .object({
    ok: z.literal(true),
    specSlug: z.string().min(1),
    findings: z.array(managedDefinitionPreflightFindingSchema),
    summary: managedDefinitionPreflightSummarySchema,
  })
  .strict();

export const managedDefinitionPreflightResultSchema = z.discriminatedUnion(
  "ok",
  [
    managedDefinitionPreflightSuccessSchema,
    z
      .object({
        ok: z.literal(false),
        refusal: managedDefinitionPreflightRefusalSchema,
      })
      .strict(),
  ],
);
export type ManagedDefinitionPreflightResult = z.infer<
  typeof managedDefinitionPreflightResultSchema
>;
