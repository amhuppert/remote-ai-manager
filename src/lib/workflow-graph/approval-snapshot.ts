import type { CandidateScope } from "@/lib/git/diff";
import type { SessionDiff } from "@/lib/git/schemas";
import type {
  GraphWorkflowApprovalSnapshotResponse,
  GraphWorkflowExecution,
} from "@/lib/workflow-graph/schemas";
import {
  computeValidationDiffScope,
  type ValidationDiffScope,
} from "./validation-diff-scope";
import { resolveContextReviewOrigin } from "./review-origin";

/**
 * What the approval surface is fed for one parked context: the API's answer,
 * plus the two refusals that are HTTP-level rather than payload-level (an
 * unknown context and a context that is not parked both 404).
 */
export type ApprovalSnapshotResolution =
  | GraphWorkflowApprovalSnapshotResponse
  | { kind: "not_awaiting_approval" }
  | { kind: "unknown_context" }
  | { kind: "gate_superseded" };

export interface ApprovalSnapshotDeps {
  /**
   * Read the context's change set under `scope` from ONE temporary index — the
   * same reader a validation round's shared inputs are rendered through, so the
   * approval surface and the validators cannot disagree about what the context
   * changed.
   */
  computeDiffScope(
    worktreePath: string,
    scope: CandidateScope,
    baselineSha: string,
  ): Promise<ValidationDiffScope>;
}

const defaultDeps: ApprovalSnapshotDeps = {
  computeDiffScope: (worktreePath, scope, baselineSha) =>
    computeValidationDiffScope(worktreePath, scope, undefined, baselineSha),
};

function emptyDiff(): SessionDiff {
  return { files: [], totalAdditions: 0, totalDeletions: 0 };
}

export interface ResolveApprovalSnapshotInput {
  execution: GraphWorkflowExecution;
  contextId: string;
  /** Fallback substrate for a context that never got a lane worktree. */
  sessionWorktreePath: string;
  /**
   * Which gate the caller believes it is reading, as its `requestedAt`. A
   * client holding stale execution state would otherwise be handed a LATER
   * gate's bytes under the earlier gate's identity — and could approve them.
   * Omitted by callers that have no gate identity to assert.
   */
  requestedAt?: string;
}

/**
 * Resolve what the approval view for one parked context renders.
 *
 * The scope comes from the PARKED record rather than from the context's current
 * placement. Placement stays live-editable while a gate stands, so re-deriving
 * it here would let a pause-and-re-place silently widen a decision that was
 * frozen under an envelope into a whole-tree one.
 *
 * The read is taken from the context's own lane worktree. In a shared lane that
 * worktree also holds concurrent siblings' in-progress work, which is exactly
 * why the scope is applied: the whole-worktree delta there is partly theirs.
 */
export async function resolveApprovalSnapshot(
  input: ResolveApprovalSnapshotInput,
  deps: ApprovalSnapshotDeps = defaultDeps,
): Promise<ApprovalSnapshotResolution> {
  const contextState = input.execution.contextStates[input.contextId];
  if (!contextState) return { kind: "unknown_context" };

  const pending = contextState.pendingApproval;
  if (
    contextState.status !== "awaiting_approval" ||
    pending === null ||
    pending.decision !== null
  ) {
    return { kind: "not_awaiting_approval" };
  }

  // The gate asked about must be the gate that is parked, or the answer would
  // describe a different candidate than the one the caller is rendering.
  if (
    input.requestedAt !== undefined &&
    input.requestedAt !== pending.requestedAt
  ) {
    return { kind: "gate_superseded" };
  }

  // Every branch below reads the FROZEN scope. The context's live placement is
  // deliberately never consulted: it can be edited while the gate stands, and a
  // full-access member is a different claim from an enveloped member whose
  // candidate could not be read — a distinction the placement cannot make after
  // the fact, and getting it wrong hands the human a sibling's in-progress work.
  const frozen = pending.approvalScope;
  if (frozen.kind === "unreadable") {
    return { kind: "unavailable", reason: frozen.reason };
  }

  const worktreePath = contextState.worktreePath ?? input.sessionWorktreePath;
  const review = resolveContextReviewOrigin(input.execution, input.contextId);
  if (review.kind === "unavailable")
    return { kind: "unavailable", reason: review.reason };
  if (frozen.treeHash === undefined) {
    return {
      kind: "unavailable",
      reason: "the approval gate has no frozen candidate identity",
    };
  }
  const scope = review.candidateScope;
  const scopeMatches =
    frozen.kind === "whole_tree"
      ? scope.mode === "wholeTree"
      : scope.mode === "owned" &&
        JSON.stringify(scope.ownedPaths) === JSON.stringify(frozen.ownedPaths);
  if (!scopeMatches) {
    return {
      kind: "unavailable",
      reason:
        "the approval scope does not match the retained work's review origin",
    };
  }
  const observed = await deps.computeDiffScope(
    worktreePath,
    scope,
    review.origin.baselineSha,
  );
  if (observed.kind === "unavailable") {
    return { kind: "unavailable", reason: observed.reason };
  }

  if (observed.treeHash !== frozen.treeHash) {
    return {
      kind: "drifted",
      contextId: input.contextId,
      frozenTreeHash: frozen.treeHash,
      observedTreeHash: observed.treeHash,
    };
  }

  if (frozen.kind === "whole_tree") {
    return {
      kind: "whole_tree",
      contextId: input.contextId,
      snapshot: {
        treeHash: observed.treeHash,
        diff: observed.kind === "empty" ? emptyDiff() : observed.diff,
      },
    };
  }

  return {
    kind: "scoped",
    snapshot: {
      contextId: input.contextId,
      ownedPaths: [...frozen.ownedPaths],
      treeHash: observed.treeHash,
      // An `empty` read is a real answer, not a missing one: the context owns
      // paths and changed none of them. Rendering it as an empty change set is
      // what lets a reviewer see that, instead of an error that reads like the
      // surface failed.
      diff: observed.kind === "empty" ? emptyDiff() : observed.diff,
    },
  };
}
