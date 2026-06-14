import { z } from "zod";

// ============================================================
// Workflow Charter Schema
//
// A workflow-global charter declares a mission, optional narrative sections,
// and an ordered source-of-truth precedence hierarchy. The source list is an
// explicit precedence ordering: a lower `rank` is higher authority, ranks are
// unique within the charter, and a higher-ranked source governs over a
// lower-ranked one when they conflict. These schemas are the single source of
// truth for the charter data model; all types are derived via `z.infer`.
// ============================================================

export const sourceTypeSchema = z.enum([
  "code",
  "config",
  "document",
  "spec",
  "other",
]);
export type SourceType = z.infer<typeof sourceTypeSchema>;

export const accessPolicySchema = z.enum([
  "worktree-relative",
  "external-readonly",
]);
export type AccessPolicy = z.infer<typeof accessPolicySchema>;

export const sourceOfTruthSchema = z.object({
  // Positive integer; unique within the charter. Lower = higher authority.
  rank: z.number().int().positive(),
  id: z.string().min(1),
  label: z.string().min(1),
  type: sourceTypeSchema,
  // Path / glob / URI; never auto-resolved by the engine.
  locator: z.string().min(1),
  description: z.string().min(1),
  // Applicability scope; precedence is evaluated within it.
  appliesTo: z.string().min(1).optional(),
  accessPolicy: accessPolicySchema,
});
export type SourceOfTruth = z.infer<typeof sourceOfTruthSchema>;

export const workflowCharterSchema = z
  .object({
    mission: z.string().min(1),
    conventions: z.array(z.string()).optional(),
    nonGoals: z.array(z.string()).optional(),
    vocabulary: z.array(z.string()).optional(),
    ownershipMap: z.string().optional(),
    testStrategy: z.string().optional(),
    knownAmbiguities: z.array(z.string()).optional(),
    sourcesOfTruth: z.array(sourceOfTruthSchema).min(1),
  })
  .superRefine((charter, ctx) => {
    const seenRanks = new Map<number, number>();
    charter.sourcesOfTruth.forEach((source, index) => {
      const firstIndex = seenRanks.get(source.rank);
      if (firstIndex === undefined) {
        seenRanks.set(source.rank, index);
        return;
      }
      ctx.addIssue({
        code: "custom",
        message: `duplicate precedence rank ${source.rank} on source '${source.id}' (already used by source at index ${firstIndex}); ranks must be unique within the charter`,
        path: ["sourcesOfTruth", index, "rank"],
      });
    });
  });
export type WorkflowCharter = z.infer<typeof workflowCharterSchema>;
