import { z } from "zod";

// ============================================================
// Acceptance-criterion records (#69 change 4, stage 1)
//
// A context's acceptance criteria are ordered `{ id, statement }` records,
// mirroring charter invariants: validators cite `id` in issues the way they
// already cite invariant ids, so ids must be stable and unique within one
// context. Legacy prose remains a valid PARSE everywhere (stored definitions,
// working definitions, execution state) and is canonicalized to records only
// on authored write paths (validate/create/replace and edit operations) —
// never on read, so a stored prose value re-serializes byte-identical and
// every content hash over it is stable (no-read-renormalization). In-memory
// consumers normalize through {@link criterionRecordsOf} instead of branching
// on the shape locally.
// ============================================================

// Kebab-case keeps criterion ids citable verbatim in verdicts, prompts, and
// logs: no whitespace, no case ambiguity, same grammar the deterministic
// wrap id (`ac-1`) uses.
const KEBAB_CASE_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const criterionRecordSchema = z.object({
  id: z.string().regex(KEBAB_CASE_ID_PATTERN, {
    message:
      "criterion id must be kebab-case: lowercase letters and digits separated by single hyphens",
  }),
  statement: z.string().min(1),
});
export type CriterionRecord = z.infer<typeof criterionRecordSchema>;

// `.min(1)`: an empty records array would be a second spelling of "no
// acceptance criteria", which the prose schema already refuses as an empty
// string. The duplicate refusal is located at the offending element's `id` so
// a union-wrapped parse still surfaces `acceptanceCriteria.<index>.id`.
export const criterionRecordsSchema = z
  .array(criterionRecordSchema)
  .min(1)
  .superRefine((records, ctx) => {
    const seen = new Map<string, number>();
    records.forEach((record, index) => {
      const firstIndex = seen.get(record.id);
      if (firstIndex === undefined) {
        seen.set(record.id, index);
        return;
      }
      ctx.addIssue({
        code: "custom",
        message: `duplicate criterion id '${record.id}' (already used by the criterion at index ${firstIndex}); ids must be unique within the context`,
        path: [index, "id"],
      });
    });
  });

// The tolerant union every acceptanceCriteria surface parses: legacy prose or
// ordered records. A tolerant PARSE, not a canonicalization — the write paths
// that must persist records apply {@link criterionRecordsOf} to the parsed
// value themselves.
export const acceptanceCriteriaSchema = z.union([
  z.string().trim().min(1),
  criterionRecordsSchema,
]);
export type AcceptanceCriteria = z.infer<typeof acceptanceCriteriaSchema>;

/**
 * The single prose→records normalization. Prose wraps as exactly ONE record —
 * a paragraph's clause structure is the author's to declare, not this
 * helper's to guess — under the deterministic id `ac-1`, so wrapping the same
 * prose twice yields the same records and no hash-bearing artifact depends on
 * call order. Records return as a fresh array with the input untouched.
 */
export function criterionRecordsOf(
  criteria: string | readonly CriterionRecord[],
): CriterionRecord[] {
  if (typeof criteria === "string") {
    return [{ id: "ac-1", statement: criteria }];
  }
  return [...criteria];
}

/**
 * The one string rendering of an acceptance-criteria value, for surfaces that
 * embed criteria in prose (prompts, previews, outlines). Prose passes through
 * byte-identical — a pre-records plan must render exactly as it always has —
 * while records render as numbered lines citing each id, the citable form the
 * acceptance seat's verdicts key on.
 */
export function acceptanceCriteriaText(
  criteria: string | readonly CriterionRecord[],
): string {
  if (typeof criteria === "string") return criteria;
  return criteria
    .map((record, index) => `${index + 1}. [${record.id}] ${record.statement}`)
    .join("\n");
}
