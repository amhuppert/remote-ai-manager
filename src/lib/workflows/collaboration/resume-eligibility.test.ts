import { describe, expect, it } from "vitest";
import {
  decideResumeEligibility,
  describeResumeRefusal,
  type ResumeEligibilityInput,
} from "./resume-eligibility";
import { buildCollaborationStepLedger } from "./step-ledger";
import {
  makeAgentOneInitialDraft,
  makeAgentOneProposedChanges,
  makeAgentTwoCounterProposalRound1,
  makeAgentTwoCrossReview,
  makeAgentTwoInitialDraft,
  makeFinalAnswer,
  makeOpenConflicts,
  makeResolutionDecisionContinue,
} from "./test-fixtures";
import type { CollaborationArtifact } from "./types";

function ledgerFor(stream: CollaborationArtifact[]) {
  const outcome = buildCollaborationStepLedger({
    stream,
    negotiationRounds: 5,
  });
  if (outcome.kind !== "ok") throw new Error(`fixture stream unusable`);
  return outcome.ledger;
}

const MID_NEGOTIATION: CollaborationArtifact[] = [
  makeAgentOneInitialDraft(),
  makeAgentTwoInitialDraft(),
  makeAgentTwoCrossReview(),
  makeAgentOneProposedChanges({ round: 1 }),
  makeAgentTwoCounterProposalRound1({ round: 1 }),
  makeResolutionDecisionContinue({ round: 1 }),
];

function input(
  overrides: Partial<ResumeEligibilityInput> = {},
): ResumeEligibilityInput {
  return {
    status: "failed",
    failureCause: { kind: "agent_call", failureKind: "backend_error" },
    ledger: ledgerFor(MID_NEGOTIATION),
    ledgerRejection: null,
    missingPremises: [],
    snapshotRoundsCompleted: 1,
    ...overrides,
  };
}

describe("decideResumeEligibility", () => {
  it("allows a mid-negotiation operational failure — the case this exists for", () => {
    expect(decideResumeEligibility(input())).toEqual({ kind: "eligible" });
  });

  it("allows a run that failed before producing anything", () => {
    expect(
      decideResumeEligibility(
        input({ ledger: null, snapshotRoundsCompleted: 0 }),
      ),
    ).toEqual({ kind: "eligible" });
  });

  it.each(["running", "paused", "completed"])("refuses a %s run", (status) => {
    expect(decideResumeEligibility(input({ status }))).toMatchObject({
      kind: "refused",
      refusal: { code: "not_failed" },
    });
  });

  // Replaying a recorded `fail` decision reaches the same decision forever.
  it("refuses a semantic policy failure", () => {
    expect(
      decideResumeEligibility(input({ failureCause: { kind: "policy_fail" } })),
    ).toMatchObject({ kind: "refused", refusal: { code: "terminal_failure" } });
  });

  it("refuses an envelope that never recorded why it failed", () => {
    expect(
      decideResumeEligibility(input({ failureCause: null })),
    ).toMatchObject({ kind: "refused", refusal: { code: "premise_missing" } });
  });

  it("refuses when the run's exact settings were never stored", () => {
    const decision = decideResumeEligibility(
      input({ missingPremises: ["agents", "imageRefs"] }),
    );
    expect(decision).toMatchObject({
      kind: "refused",
      refusal: { code: "premise_missing", detail: "agents, imageRefs" },
    });
  });

  it("refuses an unusable recorded stream", () => {
    expect(
      decideResumeEligibility(
        input({
          ledger: null,
          ledgerRejection: { code: "duplicate_step", step: "cross_review" },
        }),
      ),
    ).toMatchObject({ kind: "refused", refusal: { code: "ledger_unusable" } });
  });

  // An artifact proves questions were generated, never that the user answered
  // them — the pause is persisted after the artifact is written.
  it("refuses a run that had already asked the user a question", () => {
    expect(
      decideResumeEligibility(
        input({
          ledger: ledgerFor([
            ...MID_NEGOTIATION,
            makeOpenConflicts({ round: 1 }),
          ]),
        }),
      ),
    ).toMatchObject({ kind: "refused", refusal: { code: "reached_gate" } });
  });

  it("refuses a run that had already begun its final answer", () => {
    expect(
      decideResumeEligibility(
        input({
          ledger: ledgerFor([
            ...MID_NEGOTIATION,
            makeFinalAnswer({ round: 1 }),
          ]),
        }),
      ),
    ).toMatchObject({ kind: "refused", refusal: { code: "reached_final" } });
  });

  // A vanished sidecar under a run that made progress is data loss. Treating it
  // as a fresh start would re-run and re-bill rounds that already happened.
  it("refuses an empty stream under a run that recorded completed rounds", () => {
    expect(
      decideResumeEligibility(
        input({ ledger: null, snapshotRoundsCompleted: 3 }),
      ),
    ).toMatchObject({ kind: "refused", refusal: { code: "lost_progress" } });
  });
});

describe("describeResumeRefusal", () => {
  it("explains a policy failure without blaming the user's setup", () => {
    const text = describeResumeRefusal({
      code: "terminal_failure",
      cause: { kind: "policy_fail" },
    });
    expect(text).toContain("could not be resolved");
    expect(text).toContain("Start a new collaboration");
  });

  it("names restart as the way forward for every refusal", () => {
    const refusals = [
      {
        code: "terminal_failure" as const,
        cause: { kind: "policy_fail" as const },
      },
      { code: "premise_missing" as const, detail: "agents" },
      {
        code: "ledger_unusable" as const,
        rejection: { code: "causal_gap" as const, missing: "a", before: "b" },
      },
      { code: "reached_gate" as const },
      { code: "reached_final" as const },
      { code: "lost_progress" as const, recordedRounds: 2 },
    ];
    for (const refusal of refusals) {
      expect(describeResumeRefusal(refusal)).toContain(
        "Start a new collaboration",
      );
    }
  });
});
