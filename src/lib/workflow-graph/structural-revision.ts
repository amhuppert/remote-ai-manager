import { deepEqualJson } from "@/lib/shared/deep-equal";
import type { GraphWorkflowExecution } from "./schemas";

/**
 * The execution keys the live-edit mutation staging seam installs WHOLESALE —
 * the graph and the structures derived from or attached to it. A staged batch
 * that rewrites one of these overwrites it entirely, so it may only install onto
 * the exact value it was validated against; anything else silently erases a
 * concurrent writer.
 *
 * `contextStates` and `taskStates` are deliberately absent: they are the open
 * maps the scheduler also writes, and the seam merges them entry-by-entry
 * instead (see `runtime-edits.ts`).
 *
 * Not to be confused with the persistence `DEFINITION_TIER_KEYS` in
 * `graph-workflow-executions-repo.ts`, which is the blob-splitting layout. This
 * set is about who may overwrite what, and the two overlap without matching.
 */
export const STRUCTURAL_REVISION_KEYS = [
  "workingDefinition",
  "lanePlan",
  "routeControlRevisions",
  "charter",
  "charterAmendments",
] as const satisfies readonly (keyof GraphWorkflowExecution)[];

export type StructuralRevisionKey = (typeof STRUCTURAL_REVISION_KEYS)[number];

/**
 * The `structuralRevision` a commit should carry: the previous one, incremented
 * when any structural key actually moved.
 *
 * DERIVED, not declared. A revision each writer has to remember to bump is a
 * revision the next writer forgets — and the cost of forgetting is a staged
 * install erasing a concurrent one. `iteration-orchestrator` is the standing
 * proof: it appends script-validator remediation tasks to `workingDefinition`
 * inside `mutateActive` and bumps no `liveRevision`, because a failing pre-merge
 * script is not a live edit. Comparing the values themselves is the only fence
 * that covers a writer nobody thought about.
 *
 * The comparison walks the structural keys, which is bounded by the definition —
 * strictly cheaper than the whole-execution `structuredClone` and the
 * whole-execution schema parse the same commit already pays for, and paid once
 * per commit rather than inside the staging seam's fenced half.
 */
export function nextStructuralRevision(
  previous: GraphWorkflowExecution,
  next: GraphWorkflowExecution,
): number {
  const moved = STRUCTURAL_REVISION_KEYS.some(
    (key) => !deepEqualJson(previous[key], next[key]),
  );
  return previous.structuralRevision + (moved ? 1 : 0);
}
