import type { CandidateScope } from "@/lib/git/diff";
import type {
  GraphWorkflowExecution,
  GraphWorkflowReviewOrigin,
} from "./schemas";
import { candidateScopeForPlacement } from "./validation-diff-scope";

export type ReviewOriginResolution =
  | {
      kind: "available";
      candidateScope: CandidateScope;
      origin: GraphWorkflowReviewOrigin;
    }
  | { kind: "unavailable"; candidateScope: CandidateScope; reason: string };

function sameScope(left: CandidateScope, right: CandidateScope): boolean {
  if (left.mode !== right.mode) return false;
  if (left.mode === "wholeTree" || right.mode === "wholeTree") return true;
  return (
    JSON.stringify([...new Set(left.ownedPaths)].sort()) ===
    JSON.stringify([...new Set(right.ownedPaths)].sort())
  );
}

/**
 * Resolve the immutable origin of retained work. Assignment edits cannot
 * silently change the lane or scope the evidence describes.
 */
export function resolveContextReviewOrigin(
  execution: GraphWorkflowExecution,
  contextId: string,
): ReviewOriginResolution {
  const context = execution.workingDefinition.executionContexts.find(
    (entry) => entry.id === contextId,
  );
  const scope = candidateScopeForPlacement(context?.placement, {
    stableRead: context?.outputSchema !== undefined,
  });
  const state = execution.contextStates[contextId];
  const origin = state?.reviewOrigin;
  if (!origin) {
    return {
      kind: "unavailable",
      candidateScope: scope,
      reason: "the retained work has no captured review origin",
    };
  }
  if (
    origin.laneId !== state.laneId ||
    (state.status !== "awaiting_approval" &&
      !sameScope(origin.candidateScope, scope))
  ) {
    return {
      kind: "unavailable",
      candidateScope: origin.candidateScope,
      reason:
        "the retained work's lane or scope no longer matches its review origin",
    };
  }
  return { kind: "available", candidateScope: origin.candidateScope, origin };
}

/** Capture before the first turn; subsequent dispatches retain the same origin. */
export function captureContextReviewOrigin(
  execution: GraphWorkflowExecution,
  contextId: string,
  baselineSha: string,
  capturedAt: string,
): boolean {
  const state = execution.contextStates[contextId];
  if (!state || state.reviewOrigin !== undefined || state.iterationCount > 0)
    return false;
  const context = execution.workingDefinition.executionContexts.find(
    (entry) => entry.id === contextId,
  );
  if (!context) return false;
  const scope = candidateScopeForPlacement(context.placement, {
    stableRead: context.outputSchema !== undefined,
  });
  state.reviewOrigin = {
    laneId: state.laneId,
    baselineSha,
    candidateScope:
      scope.mode === "wholeTree"
        ? { mode: "wholeTree" }
        : { mode: "owned", ownedPaths: [...scope.ownedPaths] },
    capturedAt,
  };
  return true;
}
