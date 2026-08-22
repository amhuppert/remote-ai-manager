import { deepEqualJson } from "@/lib/shared/deep-equal";
import { validatePlacements } from "@/lib/workflow-graph/placement-validation";
import type { ContextPlacement } from "@/lib/workflow-graph/definition-schemas";
import type { GraphWorkflowExecution } from "@/lib/workflow-graph/schemas";
import { placementAuthoringIssue } from "@/components/workflow-config/PlacementEditor";

/**
 * Why a drafted placement cannot be saved onto THIS execution, or null.
 *
 * Two questions, and only one of them is answerable from the placement alone.
 * `placementAuthoringIssue` judges the declaration — grade shape, lane grammar,
 * the reserved session lane — and is what the author sees while typing. But a
 * legal declaration can still be illegal HERE: moving a context onto a lane
 * whose concurrent members own overlapping paths is a fact about the
 * surrounding definition, and only the canonical composite can see it.
 *
 * So the definition-level half is asked of `validatePlacements` — the same
 * composite the live-edit frontier reaches through — rather than restated.
 * Restating it would put a second, weaker copy of R5 in the UI, which is exactly
 * the drift the frontier check exists to prevent.
 *
 * The gate's SHAPE mirrors the frontier's too, because a preflight that is
 * merely similar is a preflight that enables a Save the runtime then refuses.
 * `checkPlacements` (runtime-edits.ts) is keyed on one question — did this batch
 * touch placement? — and, when it did, refuses on ANY error the whole post-batch
 * definition carries, including one that was already there. So:
 *
 * - Placement untouched: the frontier asks nothing, and neither does this. A
 *   pre-existing violation the author did not cause and cannot fix from here
 *   must not strand an edit that has nothing to do with placement.
 * - Placement moved: the whole post-edit definition is judged, and the first
 *   complaint is reported verbatim — a violation elsewhere blocks here because
 *   it will block there.
 */
export function livePlacementIssue({
  execution,
  contextId,
  placement,
}: {
  execution: GraphWorkflowExecution;
  contextId: string;
  placement: ContextPlacement;
}): string | null {
  const stored = execution.workingDefinition.executionContexts;
  const current = stored.find((context) => context.id === contextId);
  // The op carries `placement` only when it differs from what the execution
  // holds, and that field is the sole reason the frontier's placement gate runs
  // at all — so an unmoved placement is outside this gate's remit.
  if (current && deepEqualJson(current.placement, placement)) return null;

  const declaration = placementAuthoringIssue(placement);
  if (declaration !== null) return declaration;

  // The definition as it WOULD be, so the concurrency check sees the move
  // rather than the placement it is replacing.
  const errors = validatePlacements({
    executionContexts: stored.map((context) =>
      context.id === contextId ? { ...context, placement } : context,
    ),
    edges: execution.workingDefinition.edges,
  });
  return errors[0]?.message ?? null;
}
