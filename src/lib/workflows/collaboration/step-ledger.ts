/**
 * The run's recorded model outputs, read as a reusable log.
 *
 * A step whose artifact is here already produced that output, so re-entering
 * the run replays it instead of paying the model again. A step that is absent
 * is run again — at-least-once, never exactly-once: a call can complete, bill,
 * and advance its lane before the process dies short of the append.
 *
 * The ledger is fail-closed. It is built only from a stream that is a valid
 * causal prefix of the phase graph with no duplicate or non-canonical steps;
 * anything else is refused before a single model call, because a stream with an
 * interior gap would splice fresh upstream work into stale downstream
 * artifacts that were derived from a different upstream.
 */

import type {
  CollaborationArtifact,
  CollaborationCounterProposalOutput,
  CollaborationCrossReviewOutput,
  CollaborationFinalAnswerOutput,
  CollaborationFlowAgent,
  CollaborationInitialDraftOutput,
  CollaborationOpenConflictsOutput,
  CollaborationProposedChangesOutput,
  CollaborationResolutionDecisionOutput,
} from "./types";

export type CollaborationStepKey =
  | { kind: "initial_draft"; agent: CollaborationFlowAgent }
  | { kind: "cross_review" }
  | { kind: "proposed_changes"; round: number }
  | { kind: "counter_proposal"; round: number }
  | { kind: "resolution_decision"; round: number }
  | { kind: "open_conflicts"; round: number }
  | { kind: "final_answer" };

export type StepArtifactFor<S extends CollaborationStepKey> = S extends {
  kind: "initial_draft";
}
  ? CollaborationInitialDraftOutput
  : S extends { kind: "cross_review" }
    ? CollaborationCrossReviewOutput
    : S extends { kind: "proposed_changes" }
      ? CollaborationProposedChangesOutput
      : S extends { kind: "counter_proposal" }
        ? CollaborationCounterProposalOutput
        : S extends { kind: "resolution_decision" }
          ? CollaborationResolutionDecisionOutput
          : S extends { kind: "open_conflicts" }
            ? CollaborationOpenConflictsOutput
            : S extends { kind: "final_answer" }
              ? CollaborationFinalAnswerOutput
              : never;

export type LedgerRejection =
  /** The sidecar exists but could not be read. Never treated as absence:
   *  "start over" and "I could not look" are different answers. */
  | { code: "unreadable"; detail: string }
  | { code: "corrupt_lines"; lineIndexes: number[] }
  | { code: "duplicate_step"; step: string }
  | { code: "noncanonical_step"; step: string; detail: string }
  | { code: "causal_gap"; missing: string; before: string };

export interface CollaborationStepLedger {
  replay<S extends CollaborationStepKey>(step: S): StepArtifactFor<S> | null;
  /**
   * Prior artifacts in CANONICAL order — both initial drafts ordered
   * agent_one then agent_two regardless of how they landed on disk, then the
   * linear remainder. The tracker seeded from this feeds `artifactStream` into
   * every prompt, so a resumed run must present a stable history; the
   * append-only file itself is never reordered.
   */
  readonly recorded: readonly CollaborationArtifact[];
  /** Highest round with a recorded `resolution_decision`. Derived, so it can
   *  never disagree with the log the way a snapshot counter could. */
  readonly negotiationRoundsCompleted: number;
  /** The run reached a clarification gate. A failure resume refuses: an
   *  artifact proves questions were generated, never that the user saw or
   *  answered them. */
  readonly reachedGate: boolean;
  /** The run began its final answer, so delivery to the transcript may have
   *  happened. A failure resume refuses rather than risk a second answer. */
  readonly reachedFinal: boolean;
}

export type CollaborationLedgerOutcome =
  | { kind: "ok"; ledger: CollaborationStepLedger }
  | { kind: "empty" }
  | { kind: "unusable"; reason: LedgerRejection };

export interface BuildLedgerInput {
  stream: readonly CollaborationArtifact[];
  /** The run's configured maximum, from the executable snapshot. A recorded
   *  round beyond it means the stream does not belong to this run's config. */
  negotiationRounds: number;
  /** True source-line indexes the strict reader had to skip. Any skipped line
   *  makes the stream unusable: the gap could be anywhere. */
  corruptLineIndexes?: readonly number[];
}

function stepKeyOf(artifact: CollaborationArtifact): string {
  switch (artifact.kind) {
    case "initial_draft":
      return `initial_draft:${artifact.agent}`;
    case "cross_review":
      return "cross_review";
    case "open_conflicts":
      return "open_conflicts";
    case "final_answer":
      return "final_answer";
    default:
      return `${artifact.kind}:${artifact.round}`;
  }
}

export function collaborationStepKeyId(step: CollaborationStepKey): string {
  switch (step.kind) {
    case "initial_draft":
      return `initial_draft:${step.agent}`;
    case "cross_review":
      return "cross_review";
    case "open_conflicts":
      return "open_conflicts";
    case "final_answer":
      return "final_answer";
    default:
      return `${step.kind}:${step.round}`;
  }
}

/**
 * Position in the phase graph. Both drafts share position 0 — they are a fork,
 * not a sequence, so either on-disk order is legitimate. Everything after is
 * strictly ordered: cross-review, then each round's three steps, then the
 * optional gate and final answer, which sit past every possible round so a
 * short run's tail still sorts after its last round.
 */
function phasePositionOf(
  artifact: CollaborationArtifact,
  negotiationRounds: number,
): number {
  switch (artifact.kind) {
    case "initial_draft":
      return 0;
    case "cross_review":
      return 1;
    case "proposed_changes":
      return 3 * artifact.round - 1;
    case "counter_proposal":
      return 3 * artifact.round;
    case "resolution_decision":
      return 3 * artifact.round + 1;
    case "open_conflicts":
      return 3 * negotiationRounds + 2;
    case "final_answer":
      return 3 * negotiationRounds + 3;
  }
}

function canonicalityViolation(
  artifact: CollaborationArtifact,
  negotiationRounds: number,
): string | null {
  switch (artifact.kind) {
    case "initial_draft":
      return artifact.round === 0
        ? null
        : `initial_draft is recorded at round ${artifact.round}, expected 0`;
    case "cross_review":
      if (artifact.round !== 0) {
        return `cross_review is recorded at round ${artifact.round}, expected 0`;
      }
      if (
        artifact.agent !== "agent_two" ||
        artifact.target_agent !== "agent_one"
      ) {
        return `cross_review is authored by ${artifact.agent} targeting ${artifact.target_agent}, expected agent_two targeting agent_one`;
      }
      return null;
    default:
      // Every remaining kind is a numbered negotiation step (or the gate/final
      // that follow one), so its round must name a real configured round.
      if (artifact.round < 1) {
        return `${artifact.kind} is recorded at round ${artifact.round}, expected at least 1`;
      }
      if (artifact.round > negotiationRounds) {
        return `${artifact.kind} is recorded at round ${artifact.round}, beyond this run's configured maximum of ${negotiationRounds}`;
      }
      return null;
  }
}

export function buildCollaborationStepLedger(
  input: BuildLedgerInput,
): CollaborationLedgerOutcome {
  const { stream, negotiationRounds } = input;

  // A skipped line makes the whole stream untrustworthy: the gap could sit
  // anywhere, and a missing interior step is exactly the shape that splices a
  // fresh upstream output into stale downstream artifacts.
  const corrupt = input.corruptLineIndexes ?? [];
  if (corrupt.length > 0) {
    return {
      kind: "unusable",
      reason: { code: "corrupt_lines", lineIndexes: [...corrupt] },
    };
  }

  if (stream.length === 0) return { kind: "empty" };

  for (const artifact of stream) {
    const violation = canonicalityViolation(artifact, negotiationRounds);
    if (violation !== null) {
      return {
        kind: "unusable",
        reason: {
          code: "noncanonical_step",
          step: stepKeyOf(artifact),
          detail: violation,
        },
      };
    }
  }

  const byKey = new Map<string, CollaborationArtifact>();
  for (const artifact of stream) {
    const key = stepKeyOf(artifact);
    if (byKey.has(key)) {
      return {
        kind: "unusable",
        reason: { code: "duplicate_step", step: key },
      };
    }
    byKey.set(key, artifact);
  }

  // File order must follow the phase graph. Only the two drafts may tie.
  let previous = -1;
  let previousKey = "<start>";
  for (const artifact of stream) {
    const position = phasePositionOf(artifact, negotiationRounds);
    const tiedDrafts = position === 0 && previous === 0;
    if (position < previous || (position === previous && !tiedDrafts)) {
      return {
        kind: "unusable",
        reason: {
          code: "causal_gap",
          missing: stepKeyOf(artifact),
          before: previousKey,
        },
      };
    }
    previous = position;
    previousKey = stepKeyOf(artifact);
  }

  const has = (step: CollaborationStepKey): boolean =>
    byKey.has(collaborationStepKeyId(step));

  const gap = (
    missing: string,
    before: string,
  ): CollaborationLedgerOutcome => ({
    kind: "unusable",
    reason: { code: "causal_gap", missing, before },
  });

  // Every step past the fork depends on both drafts: cross-review reads Agent
  // One's draft, and every negotiation prompt carries both.
  const beyondDrafts = stream.some((a) => a.kind !== "initial_draft");
  if (beyondDrafts) {
    for (const agent of ["agent_one", "agent_two"] as const) {
      if (!has({ kind: "initial_draft", agent })) {
        return gap(`initial_draft:${agent}`, "cross_review");
      }
    }
  }

  let roundsCompleted = 0;
  for (let r = 1; r <= negotiationRounds; r++) {
    const proposed = has({ kind: "proposed_changes", round: r });
    const counter = has({ kind: "counter_proposal", round: r });
    const resolution = has({ kind: "resolution_decision", round: r });

    if (proposed && !has({ kind: "cross_review" })) {
      return gap("cross_review", `proposed_changes:${r}`);
    }
    if (proposed && r > 1 && roundsCompleted < r - 1) {
      return gap(`resolution_decision:${r - 1}`, `proposed_changes:${r}`);
    }
    if (counter && !proposed) {
      return gap(`proposed_changes:${r}`, `counter_proposal:${r}`);
    }
    if (resolution && !counter) {
      return gap(`counter_proposal:${r}`, `resolution_decision:${r}`);
    }
    if (resolution) roundsCompleted = r;
  }

  const gateArtifact = byKey.get("open_conflicts");
  if (gateArtifact && gateArtifact.kind === "open_conflicts") {
    if (!has({ kind: "resolution_decision", round: gateArtifact.round })) {
      return gap(`resolution_decision:${gateArtifact.round}`, "open_conflicts");
    }
  }

  const finalArtifact = byKey.get("final_answer");
  if (finalArtifact && finalArtifact.kind === "final_answer") {
    if (!has({ kind: "resolution_decision", round: finalArtifact.round })) {
      return gap(`resolution_decision:${finalArtifact.round}`, "final_answer");
    }
  }

  // The file is append-only, so a run that recorded agent_two's draft first can
  // never be reordered on disk. The history the prompts see is canonicalised
  // here instead, so a resumed run presents the same sequence a clean run did.
  const drafts = stream.filter((a) => a.kind === "initial_draft");
  const rest = stream.filter((a) => a.kind !== "initial_draft");
  const recorded: CollaborationArtifact[] = [
    ...drafts.filter(
      (a) => a.kind === "initial_draft" && a.agent === "agent_one",
    ),
    ...drafts.filter(
      (a) => a.kind === "initial_draft" && a.agent === "agent_two",
    ),
    ...rest,
  ];

  const ledger: CollaborationStepLedger = {
    replay<S extends CollaborationStepKey>(step: S): StepArtifactFor<S> | null {
      const artifact = byKey.get(collaborationStepKeyId(step));
      return (artifact as StepArtifactFor<S> | undefined) ?? null;
    },
    recorded,
    negotiationRoundsCompleted: roundsCompleted,
    reachedGate: byKey.has("open_conflicts"),
    reachedFinal: byKey.has("final_answer"),
  };

  return { kind: "ok", ledger };
}
