import { z } from "zod";

// ============================================================
// Workflow Charter Schema
//
// A workflow-global charter declares a mission, optional narrative sections,
// and an ordered source-of-truth reference hierarchy. `rank` orders the list
// and is unique within the charter; conflicts between sources are resolved at
// plan time (an unresolved conflict is a plan defect, not a runtime judgment),
// so agents never re-derive precedence per round. These schemas are the single
// source of truth for the charter data model; all types are derived via
// `z.infer`.
//
// Every parse surface is tolerant of the pre-structured stored shapes (legacy
// prose `appliesTo` and the retired `accessPolicy` are accepted AND preserved
// verbatim, never normalized in place, so a reloaded value re-serializes to
// the exact bytes that were stored and every content hash computed over it is
// stable — no-read-renormalization). Authored writes are still refused those
// shapes, but at the enforcement layer rather than the parse: edit operations
// bind the strict `sourceOfTruthSchema` directly, and plan accept
// (validate/create/replace) refuses them via
// `validateCharterSourceAuthoredShapes` in workflow-graph validation.
// Consumers normalize through helpers like {@link sourceScopeContextIds}
// instead of mutating the value.
// ============================================================

export const sourceTypeSchema = z.enum([
  "code",
  "config",
  "document",
  "spec",
  "other",
]);
export type SourceType = z.infer<typeof sourceTypeSchema>;

// The shared applicability scope for charter entries: the authored context ids
// the entry applies to. Absence of a scope means global. Used by invariants and
// sources alike so both refuse the same malformed shapes at the same paths.
export const charterScopeSchema = z
  .object({
    contextIds: z
      .array(z.string().trim().min(1))
      .min(1)
      .superRefine((contextIds, ctx) => {
        const seen = new Map<string, number>();
        contextIds.forEach((contextId, index) => {
          const firstIndex = seen.get(contextId);
          if (firstIndex === undefined) {
            seen.set(contextId, index);
            return;
          }
          ctx.addIssue({
            code: "custom",
            message: `duplicate scope context id '${contextId}' (already used at index ${firstIndex})`,
            path: [index],
          });
        });
      }),
  })
  .strict();
export type CharterScope = z.infer<typeof charterScopeSchema>;

export const charterInvariantAppliesToSchema = charterScopeSchema;
export type CharterInvariantAppliesTo = CharterScope;

// Legacy access policy values persisted before the field retired. Kept ONLY so
// the tolerant persisted parse can carry stored values through unchanged; the
// authored schema refuses the field (external material is materialized into
// the worktree at plan time instead of permission-gated per agent).
const legacyAccessPolicySchema = z.enum([
  "worktree-relative",
  "external-readonly",
]);

const sourceOfTruthShape = {
  // Positive integer; unique within the charter. Lower = higher authority.
  rank: z.number().int().positive(),
  id: z.string().min(1),
  label: z.string().min(1),
  type: sourceTypeSchema,
  // Path / glob / URI; never auto-resolved by the engine.
  locator: z.string().min(1),
  description: z.string().min(1),
  // Structured applicability: the context ids this source is rendered for.
  // Absent = global (rendered for every context).
  appliesTo: charterScopeSchema.optional(),
};

// The authored source entry. `.strict()` is the refusal surface for the
// retired `accessPolicy` field (and any other unknown key): an author writing
// the pre-structured shape gets a located error instead of silent stripping.
export const sourceOfTruthSchema = z.object(sourceOfTruthShape).strict();
export type SourceOfTruth = z.infer<typeof sourceOfTruthSchema>;

// The persisted source entry: tolerant of the pre-structured stored shape.
// Legacy prose `appliesTo` and `accessPolicy` are accepted and preserved
// verbatim — see the module header for why stripping here is forbidden.
export const persistedSourceOfTruthSchema = z.object({
  ...sourceOfTruthShape,
  appliesTo: z.union([charterScopeSchema, z.string().min(1)]).optional(),
  accessPolicy: legacyAccessPolicySchema.optional(),
});
export type PersistedSourceOfTruth = z.infer<
  typeof persistedSourceOfTruthSchema
>;

/**
 * The context ids a source applies to, or `null` when the source is global.
 * A legacy prose `appliesTo` carries no context ids the engine can filter on,
 * so it is treated as global — exactly the pre-structured rendering behavior.
 */
export function sourceScopeContextIds(
  source: Pick<PersistedSourceOfTruth, "appliesTo">,
): readonly string[] | null {
  const scope = source.appliesTo;
  if (scope === undefined || typeof scope === "string") return null;
  return scope.contextIds;
}

// A cross-cutting rule that constrains HOW every context implements (not WHAT
// one context builds). Rendered into both the implementer and validator
// prompts; validators check each applicable invariant and cite its `id` in
// issues, so ids must be stable and unique within the charter.
export const charterInvariantSchema = z.object({
  id: z.string().min(1),
  statement: z.string().min(1),
  appliesTo: charterInvariantAppliesToSchema.optional(),
});
export type CharterInvariant = z.infer<typeof charterInvariantSchema>;

// One accepted live `amend-charter` operation (docs/design/cc-cli/07). A
// metadata-only record: the amended content lives in the execution's current
// charter; frozen contexts keep the as-run copy they executed under, so the
// log never embeds full charter snapshots (F2). Rendered into charter.md as
// the "Amendment log" so the durable record shows that the rules changed and
// why; prompts carry only an amendment-count pointer to it.
export const charterAmendmentSchema = z.object({
  // 1-based, append-only position in the execution's amendment history.
  seq: z.number().int().min(1),
  amendedAt: z.string(),
  // Trusted client self-identification, same model as live edits (doc 06 D15).
  // `plan-repair` is server-derived only (the D1 repair supervisor); the HTTP
  // live-edit schema still accepts just cli|ui — same trust model as lane-agent.
  source: z.enum(["cli", "ui", "plan-repair"]),
  rationale: z.string().min(1),
  // Top-level charter fields the operation touched, e.g. ["invariants"].
  fieldsChanged: z.array(z.string().min(1)).min(1),
  // Content hash AFTER this amendment (computeCharterHash).
  charterHash: z.string().min(1),
});
export type CharterAmendment = z.infer<typeof charterAmendmentSchema>;

function buildWorkflowCharterSchema<
  SourceSchema extends z.ZodType<{ rank: number; id: string }>,
>(sourceSchema: SourceSchema) {
  return z
    .object({
      mission: z.string().min(1),
      conventions: z.array(z.string()).optional(),
      nonGoals: z.array(z.string()).optional(),
      vocabulary: z.array(z.string()).optional(),
      testStrategy: z.string().optional(),
      knownAmbiguities: z.array(z.string()).optional(),
      invariants: z.array(charterInvariantSchema).optional(),
      sourcesOfTruth: z.array(sourceSchema).min(1),
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
}

// The working charter schema: what stored definition records, execution
// working definitions, and every in-memory consumer parse and type against.
// Tolerant by construction — see the module header.
export const workflowCharterSchema = buildWorkflowCharterSchema(
  persistedSourceOfTruthSchema,
);
export type WorkflowCharter = z.infer<typeof workflowCharterSchema>;
