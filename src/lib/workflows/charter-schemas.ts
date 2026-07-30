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

// A cross-cutting rule that constrains HOW every context implements (not WHAT
// one context builds). Rendered into both the implementer and validator
// prompts; validators check each applicable invariant and cite its `id` in
// issues, so ids must be stable and unique within the charter.
export const charterInvariantSchema = z.object({
  id: z.string().min(1),
  statement: z.string().min(1),
});
export type CharterInvariant = z.infer<typeof charterInvariantSchema>;

// One accepted live `amend-charter` operation (docs/design/cc-cli/07). A
// metadata-only record: the amended content lives in the execution's current
// charter; frozen contexts keep the as-run copy they executed under, so the
// log never embeds full charter snapshots (F2). Rendered into prompts and
// charter.md as the "Amendment log" so agents see that the rules changed and why.
export const charterAmendmentSchema = z.object({
  // 1-based, append-only position in the execution's amendment history.
  seq: z.number().int().min(1),
  amendedAt: z.string(),
  // Trusted client self-identification, same model as live edits (doc 06 D15).
  source: z.enum(["cli", "ui"]),
  rationale: z.string().min(1),
  // Top-level charter fields the operation touched, e.g. ["invariants"].
  fieldsChanged: z.array(z.string().min(1)).min(1),
  // Content hash AFTER this amendment (computeCharterHash).
  charterHash: z.string().min(1),
});
export type CharterAmendment = z.infer<typeof charterAmendmentSchema>;

export const workflowCharterSchema = z
  .object({
    mission: z.string().min(1),
    conventions: z.array(z.string()).optional(),
    nonGoals: z.array(z.string()).optional(),
    vocabulary: z.array(z.string()).optional(),
    testStrategy: z.string().optional(),
    knownAmbiguities: z.array(z.string()).optional(),
    invariants: z.array(charterInvariantSchema).optional(),
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
    const seenInvariantIds = new Map<string, number>();
    (charter.invariants ?? []).forEach((invariant, index) => {
      const firstIndex = seenInvariantIds.get(invariant.id);
      if (firstIndex === undefined) {
        seenInvariantIds.set(invariant.id, index);
        return;
      }
      ctx.addIssue({
        code: "custom",
        message: `duplicate invariant id '${invariant.id}' (already used by invariant at index ${firstIndex}); ids must be unique within the charter`,
        path: ["invariants", index, "id"],
      });
    });
  });
export type WorkflowCharter = z.infer<typeof workflowCharterSchema>;
