import {
  contextPlacementSchema,
  type ContextPlacement,
} from "@/lib/workflow-graph/definition-schemas";
import {
  laneIdViolation,
  SESSION_LANE_NAME,
} from "@/lib/workflow-graph/lane-identity";

// Where a context runs and what it may write (lwp R1): a lane name plus a
// write grade. Both authoring tiers — the builder's draft definition and the
// live execution's working definition — gate Save on the same check.

/**
 * Why this placement cannot be submitted yet, or null when it is complete.
 *
 * Exported because both hosts gate Save on it: the builder blocks a draft the
 * accept-time gate would refuse, and the live editor blocks an `update-context`
 * op the frontier would refuse. Lane grammar is re-checked HERE rather than
 * only server-side so the author sees an illegal branch segment while typing;
 * the server refusal stays authoritative.
 */
export function placementAuthoringIssue(
  placement: ContextPlacement,
): string | null {
  if (!contextPlacementSchema.safeParse(placement).success) {
    return placement.mode === "owned" && placement.ownedPaths.length === 0
      ? 'An owning placement needs at least one owned path — or use "read-only" for a context with no write surface.'
      : "This placement is not a legal declaration.";
  }
  if (placement.lane === SESSION_LANE_NAME) {
    return placement.mode === "readOnly"
      ? null
      : `The reserved "${SESSION_LANE_NAME}" lane admits read-only contexts only.`;
  }
  const violation = laneIdViolation(placement.lane);
  return violation === null
    ? null
    : `Lane names become branch and worktree path segments: it ${violation}.`;
}
