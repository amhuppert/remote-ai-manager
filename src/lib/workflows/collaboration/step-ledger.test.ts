import { describe, expect, it } from "vitest";
import {
  buildCollaborationStepLedger,
  type CollaborationLedgerOutcome,
  type CollaborationStepLedger,
} from "./step-ledger";
import {
  makeAgentOneInitialDraft,
  makeAgentOneProposedChanges,
  makeAgentTwoCounterProposalRound1,
  makeAgentTwoCounterProposalRound2,
  makeAgentTwoCrossReview,
  makeAgentTwoInitialDraft,
  makeFinalAnswer,
  makeOpenConflicts,
  makeResolutionDecisionContinue,
  makeResolutionDecisionFinal,
} from "./test-fixtures";
import type { CollaborationArtifact } from "./types";

const ROUNDS = 5;

function build(
  stream: readonly CollaborationArtifact[],
  overrides: { negotiationRounds?: number; corruptLineIndexes?: number[] } = {},
): CollaborationLedgerOutcome {
  return buildCollaborationStepLedger({
    stream,
    negotiationRounds: overrides.negotiationRounds ?? ROUNDS,
    ...(overrides.corruptLineIndexes
      ? { corruptLineIndexes: overrides.corruptLineIndexes }
      : {}),
  });
}

function expectOk(
  stream: readonly CollaborationArtifact[],
  overrides?: { negotiationRounds?: number },
): CollaborationStepLedger {
  const outcome = build(stream, overrides);
  if (outcome.kind !== "ok") {
    throw new Error(`expected ok ledger, got ${JSON.stringify(outcome)}`);
  }
  return outcome.ledger;
}

/** A complete round r: proposed_changes → counter_proposal → resolution_decision. */
function round(r: number, last = false): CollaborationArtifact[] {
  return [
    makeAgentOneProposedChanges({ round: r }),
    r === 1
      ? makeAgentTwoCounterProposalRound1({ round: r })
      : makeAgentTwoCounterProposalRound2({ round: r }),
    last
      ? makeResolutionDecisionFinal({ round: r })
      : makeResolutionDecisionContinue({ round: r }),
  ];
}

const BOTH_DRAFTS = [makeAgentOneInitialDraft(), makeAgentTwoInitialDraft()];

describe("buildCollaborationStepLedger — the initial-draft fork", () => {
  it("treats an empty stream as a fresh run", () => {
    expect(build([]).kind).toBe("empty");
  });

  // The ticket's headline case. When Agent One's call fails and Agent Two's
  // succeeds, the phase still commits Agent Two's draft before failing, so the
  // sidecar legitimately holds agent_two ALONE. A grammar demanding both
  // drafts before anything else would refuse exactly the run this feature
  // exists to rescue.
  it("accepts agent_two's draft alone", () => {
    const ledger = expectOk([makeAgentTwoInitialDraft()]);
    expect(
      ledger.replay({ kind: "initial_draft", agent: "agent_two" }),
    ).not.toBeNull();
    expect(
      ledger.replay({ kind: "initial_draft", agent: "agent_one" }),
    ).toBeNull();
  });

  it("accepts agent_one's draft alone", () => {
    const ledger = expectOk([makeAgentOneInitialDraft()]);
    expect(
      ledger.replay({ kind: "initial_draft", agent: "agent_one" }),
    ).not.toBeNull();
    expect(
      ledger.replay({ kind: "initial_draft", agent: "agent_two" }),
    ).toBeNull();
  });

  it("accepts both drafts in either on-disk order", () => {
    for (const stream of [
      BOTH_DRAFTS,
      [makeAgentTwoInitialDraft(), makeAgentOneInitialDraft()],
    ]) {
      const ledger = expectOk(stream);
      expect(
        ledger.replay({ kind: "initial_draft", agent: "agent_one" }),
      ).not.toBeNull();
      expect(
        ledger.replay({ kind: "initial_draft", agent: "agent_two" }),
      ).not.toBeNull();
    }
  });

  // An append-only file can never be reordered, so canonical order is a
  // property of the in-memory history the prompts see, not of the disk.
  it("canonicalises drafts to agent_one first regardless of disk order", () => {
    const ledger = expectOk([
      makeAgentTwoInitialDraft(),
      makeAgentOneInitialDraft(),
    ]);
    expect(
      ledger.recorded.map((a) => a.kind === "initial_draft" && a.agent),
    ).toEqual(["agent_one", "agent_two"]);
  });

  it("refuses a duplicate draft from the same agent", () => {
    const outcome = build([
      makeAgentOneInitialDraft(),
      makeAgentOneInitialDraft(),
    ]);
    expect(outcome).toMatchObject({
      kind: "unusable",
      reason: { code: "duplicate_step" },
    });
  });
});

describe("buildCollaborationStepLedger — the linear remainder", () => {
  it("accepts drafts, cross-review, and complete rounds", () => {
    const ledger = expectOk([
      ...BOTH_DRAFTS,
      makeAgentTwoCrossReview(),
      ...round(1),
      ...round(2),
    ]);
    expect(ledger.negotiationRoundsCompleted).toBe(2);
    expect(
      ledger.replay({ kind: "counter_proposal", round: 2 }),
    ).not.toBeNull();
    expect(ledger.replay({ kind: "proposed_changes", round: 3 })).toBeNull();
  });

  it("accepts a partial trailing round", () => {
    const ledger = expectOk([
      ...BOTH_DRAFTS,
      makeAgentTwoCrossReview(),
      ...round(1),
      makeAgentOneProposedChanges({ round: 2 }),
    ]);
    // The failure landed after agent_one proposed and before agent_two
    // countered: round 2 is genuinely half-done, and only round 1 is complete.
    expect(ledger.negotiationRoundsCompleted).toBe(1);
    expect(
      ledger.replay({ kind: "proposed_changes", round: 2 }),
    ).not.toBeNull();
    expect(ledger.replay({ kind: "counter_proposal", round: 2 })).toBeNull();
  });

  it("refuses a round that skips its cross-review", () => {
    const outcome = build([...BOTH_DRAFTS, ...round(1)]);
    expect(outcome).toMatchObject({
      kind: "unusable",
      reason: { code: "causal_gap" },
    });
  });

  // The splice this rule exists to prevent: round 2's recorded counter and
  // resolution were derived from round 2's proposed changes. Re-running the
  // missing proposal would produce different upstream text while the stale
  // downstream artifacts replayed on top of it.
  it("refuses an interior gap inside a round", () => {
    const outcome = build([
      ...BOTH_DRAFTS,
      makeAgentTwoCrossReview(),
      ...round(1),
      makeAgentTwoCounterProposalRound2({ round: 2 }),
      makeResolutionDecisionContinue({ round: 2 }),
    ]);
    expect(outcome).toMatchObject({
      kind: "unusable",
      reason: { code: "causal_gap" },
    });
  });

  it("refuses a skipped round", () => {
    const outcome = build([
      ...BOTH_DRAFTS,
      makeAgentTwoCrossReview(),
      ...round(1),
      ...round(3),
    ]);
    expect(outcome).toMatchObject({
      kind: "unusable",
      reason: { code: "causal_gap" },
    });
  });

  it("refuses artifacts recorded out of phase order", () => {
    const outcome = build([
      ...BOTH_DRAFTS,
      makeAgentTwoCrossReview(),
      makeAgentTwoCounterProposalRound1({ round: 1 }),
      makeAgentOneProposedChanges({ round: 1 }),
      makeResolutionDecisionContinue({ round: 1 }),
    ]);
    expect(outcome.kind).toBe("unusable");
  });

  it("refuses a duplicate step in the linear remainder", () => {
    const outcome = build([
      ...BOTH_DRAFTS,
      makeAgentTwoCrossReview(),
      makeAgentTwoCrossReview(),
    ]);
    expect(outcome).toMatchObject({
      kind: "unusable",
      reason: { code: "duplicate_step" },
    });
  });
});

describe("buildCollaborationStepLedger — canonicality against the snapshot", () => {
  // The storage schema alone accepts arbitrary integer rounds and either agent
  // for drafts and cross-review, so the ledger is where the run's actual
  // configuration is enforced.
  it("refuses a round beyond the run's configured maximum", () => {
    const outcome = build(
      [...BOTH_DRAFTS, makeAgentTwoCrossReview(), ...round(1), ...round(2)],
      { negotiationRounds: 1 },
    );
    expect(outcome).toMatchObject({
      kind: "unusable",
      reason: { code: "noncanonical_step" },
    });
  });

  it("refuses a draft recorded at a non-zero round", () => {
    const outcome = build([makeAgentOneInitialDraft({ round: 2 })]);
    expect(outcome).toMatchObject({
      kind: "unusable",
      reason: { code: "noncanonical_step" },
    });
  });

  it("refuses a cross-review authored by the wrong agent", () => {
    const outcome = build([
      ...BOTH_DRAFTS,
      makeAgentTwoCrossReview({
        agent: "agent_one",
        target_agent: "agent_two",
      }),
    ]);
    expect(outcome).toMatchObject({
      kind: "unusable",
      reason: { code: "noncanonical_step" },
    });
  });

  it("refuses a negotiation artifact recorded at round zero", () => {
    const outcome = build([
      ...BOTH_DRAFTS,
      makeAgentTwoCrossReview(),
      makeAgentOneProposedChanges({ round: 0 }),
    ]);
    expect(outcome).toMatchObject({
      kind: "unusable",
      reason: { code: "noncanonical_step" },
    });
  });
});

describe("buildCollaborationStepLedger — corrupt input is never 'fresh'", () => {
  // Revision 1 of this design treated a skipped line as absence, which would
  // have re-dispatched an entire completed run as if nothing had happened.
  it("refuses a stream with any skipped source line", () => {
    const outcome = build([...BOTH_DRAFTS], { corruptLineIndexes: [3] });
    expect(outcome).toMatchObject({
      kind: "unusable",
      reason: { code: "corrupt_lines", lineIndexes: [3] },
    });
  });

  it("refuses corrupt lines even when the surviving stream parses cleanly", () => {
    const outcome = build(
      [...BOTH_DRAFTS, makeAgentTwoCrossReview(), ...round(1)],
      { corruptLineIndexes: [0] },
    );
    expect(outcome.kind).toBe("unusable");
  });
});

describe("buildCollaborationStepLedger — gate and final windows", () => {
  it("reports a stream that reached the clarification gate", () => {
    const ledger = expectOk([
      ...BOTH_DRAFTS,
      makeAgentTwoCrossReview(),
      ...round(1),
      makeOpenConflicts({ round: 1 }),
    ]);
    expect(ledger.reachedGate).toBe(true);
    expect(ledger.reachedFinal).toBe(false);
    expect(ledger.replay({ kind: "open_conflicts", round: 1 })).not.toBeNull();
  });

  it("reports a stream that reached the final answer", () => {
    const ledger = expectOk([
      ...BOTH_DRAFTS,
      makeAgentTwoCrossReview(),
      ...round(1, true),
      makeFinalAnswer({ round: 1 }),
    ]);
    expect(ledger.reachedFinal).toBe(true);
    expect(ledger.replay({ kind: "final_answer" })).not.toBeNull();
  });

  it("accepts a gate followed by a final answer", () => {
    const ledger = expectOk([
      ...BOTH_DRAFTS,
      makeAgentTwoCrossReview(),
      ...round(1),
      makeOpenConflicts({ round: 1 }),
      makeFinalAnswer({ round: 1 }),
    ]);
    expect(ledger.reachedGate).toBe(true);
    expect(ledger.reachedFinal).toBe(true);
  });

  it("refuses a final answer recorded before its round completed", () => {
    const outcome = build([
      ...BOTH_DRAFTS,
      makeAgentTwoCrossReview(),
      makeAgentOneProposedChanges({ round: 1 }),
      makeFinalAnswer({ round: 1 }),
    ]);
    expect(outcome).toMatchObject({
      kind: "unusable",
      reason: { code: "causal_gap" },
    });
  });

  it("refuses a gate whose round never completed", () => {
    const outcome = build([
      ...BOTH_DRAFTS,
      makeAgentTwoCrossReview(),
      ...round(1),
      makeOpenConflicts({ round: 2 }),
    ]);
    expect(outcome).toMatchObject({
      kind: "unusable",
      reason: { code: "causal_gap" },
    });
  });
});

describe("buildCollaborationStepLedger — replay lookups", () => {
  it("returns the exact recorded artifact for a step key", () => {
    const proposed = makeAgentOneProposedChanges({
      round: 2,
      summary: "the round two proposal",
    });
    const ledger = expectOk([
      ...BOTH_DRAFTS,
      makeAgentTwoCrossReview(),
      ...round(1),
      proposed,
    ]);
    expect(ledger.replay({ kind: "proposed_changes", round: 2 })).toEqual(
      proposed,
    );
  });

  it("keeps the whole recorded stream for prompt history", () => {
    const stream = [...BOTH_DRAFTS, makeAgentTwoCrossReview(), ...round(1)];
    expect(expectOk(stream).recorded).toHaveLength(stream.length);
  });
});
