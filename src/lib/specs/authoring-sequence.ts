import { dialRequiresHumanApproval, resolveDial } from "./policy";
import { toCitationDiffContext, toDiffRows } from "./revision-diff-projections";
import type {
  SpecAuthoringStage,
  SpecGatePolicy,
  SpecRevisionSnapshot,
} from "./schemas";
import {
  activeAuthoringStages,
  authoringStageIndex,
  consultedAuthoringGates,
  nextAuthoringStage,
  type AuthoringGate,
} from "./authoring-gates";
import type { RemainingAuthoringSequence } from "./view-schemas";

export interface RemainingAuthoringSequenceContext {
  policy: SpecGatePolicy;
  revisionId: string;
  revisionNumber: number;
  /**
   * The stage the draft is pinned at. A policy change never moves it (R25.1),
   * so it is read from the revision rather than re-derived from the policy.
   */
  pinnedStage: SpecAuthoringStage;
  /**
   * The gates a propose from this stage consults, measured against the nearest
   * approved ancestor. Which gates those are depends on content, not on dials,
   * so it is decided once where the baseline lives — a caller that re-derives
   * it from the immediate parent drops every obligation that entered through a
   * withdrawn attempt.
   */
  governanceConsultedGates: readonly AuthoringGate[];
}

/**
 * The remaining stage sequence for one open draft under the policy in force,
 * with the gate that concludes each stage (R25.5).
 *
 * The per-stage `dial` is the stage's own dial: which earlier stages a later
 * transition will additionally consult depends on content not yet authored, so
 * only `nextTransition` — the transition whose diff is already known — reports
 * the full stage-scoped consultation of R10.11.
 */
export function remainingAuthoringSequence(
  context: RemainingAuthoringSequenceContext,
): RemainingAuthoringSequence {
  const remainingStages =
    context.pinnedStage === "plan"
      ? (["plan"] as const)
      : activeAuthoringStages.slice(authoringStageIndex(context.pinnedStage));
  const stages = remainingStages.map((stage) => {
    const dial = resolveDial(context.policy, stage);
    const signOff = dialRequiresHumanApproval(dial);
    return {
      stage,
      gate: stage,
      dial,
      concludedBy:
        !signOff && nextAuthoringStage(stage) !== null
          ? ("advance" as const)
          : ("propose" as const),
      requiresHumanSignOff: signOff,
    };
  });

  const current = stages[0];
  if (current === undefined) {
    throw new Error(
      `Authoring stage ${context.pinnedStage} has no remaining sequence.`,
    );
  }

  const consultedGates =
    current.concludedBy === "advance"
      ? [{ gate: current.gate, dial: current.dial }]
      : context.governanceConsultedGates.map((gate) => ({
          gate,
          dial: resolveDial(context.policy, gate),
        }));

  return {
    revisionId: context.revisionId,
    revisionNumber: context.revisionNumber,
    pinnedStage: context.pinnedStage,
    stages,
    nextTransition: {
      stage: context.pinnedStage,
      action: current.concludedBy,
      requiresHumanSignOff: consultedGates.some(({ dial }) =>
        dialRequiresHumanApproval(dial),
      ),
      consultedGates,
      // Carried so a caller previewing other dials asks the same question of
      // the same baseline instead of measuring one of its own.
      governanceConsultedGates: [...context.governanceConsultedGates],
    },
  };
}

/**
 * The sequence for one open draft, read from the revision snapshots the
 * change-policy transaction and the status projection each already load.
 * Returns null for any revision that is not a draft: a proposed, approved, or
 * withdrawn revision is never restaged and owes no remaining sequence (R25.4).
 */
export function draftAuthoringSequence(input: {
  policy: SpecGatePolicy;
  snapshot: SpecRevisionSnapshot;
  governanceBaseSnapshot: SpecRevisionSnapshot | null;
}): RemainingAuthoringSequence | null {
  const { revision } = input.snapshot;
  if (revision.state !== "draft") return null;
  return remainingAuthoringSequence({
    policy: input.policy,
    revisionId: revision.id,
    revisionNumber: revision.number,
    pinnedStage: revision.authoringStage,
    governanceConsultedGates: consultedAuthoringGates(
      revision.authoringStage,
      input.governanceBaseSnapshot === null
        ? []
        : toDiffRows(input.governanceBaseSnapshot),
      toDiffRows(input.snapshot),
      toCitationDiffContext(input.governanceBaseSnapshot, input.snapshot),
    ),
  });
}
