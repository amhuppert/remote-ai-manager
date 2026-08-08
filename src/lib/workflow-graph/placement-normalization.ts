/**
 * The inflate boundary for placement on a stored definition.
 *
 * Separate from `placement-validation.ts` deliberately: this runs inside the
 * schema-cutover guard, on the path every stored definition is read through,
 * and the validation module reads the authored edge set — a topology read the
 * guard has no business acquiring by import.
 */

import { laneIdViolation } from "./lane-identity";

/**
 * The inflate boundary for a stored definition written before placement existed.
 *
 * Placement is REQUIRED on an authored context, so a document from before the
 * field would otherwise fail to parse and take its workflow with it. What such a
 * document actually ran under is known exactly: deterministic seed-time
 * assignment gave every context its own lane and the whole worktree to write,
 * which is `mode: "full"` on a lane named for the context. Backfilling that is
 * a faithful restatement of the document's own behavior, not a default chosen
 * here — and `full` composes no envelope, so nothing about how the context runs
 * changes on the way through.
 *
 * Mutates in place and runs BEFORE the parse, exactly like the edge-id
 * normalization it sits beside.
 */
export function normalizeRawDefinitionPlacements(rawDefinition: unknown): void {
  if (!isRawRecord(rawDefinition)) return;
  const contexts = rawDefinition.executionContexts;
  if (!Array.isArray(contexts)) return;

  for (const context of contexts) {
    if (!isRawRecord(context)) continue;
    if (context.placement !== undefined) continue;
    const id = typeof context.id === "string" ? context.id.trim() : "";
    if (id.length === 0 || laneIdViolation(id) !== null) continue;
    context.placement = { lane: id, mode: "full" };
  }
}

function isRawRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
