/**
 * Asymmetric Collaboration Mode policy edges.
 *
 * The policy is a pure decision function that takes Agent One's most recent
 * `resolution_decision` (after it has read Agent Two's latest counter-proposal),
 * the configured `autonomousResolutionThreshold`, and a flag indicating whether
 * any negotiation rounds remain — and routes the run to one of:
 *
 *  - `final` — Agent One declared agreement; proceed to final answer.
 *  - `continue_negotiation` — implementation disagreements remain and the
 *    agents may still negotiate; loop into another round.
 *  - `ask_user` — objective disagreement (always halts) OR implementation
 *    disagreements that exceed the autonomous threshold OR negotiation rounds
 *    are exhausted with disagreements above threshold.
 *  - `fail` — Agent One explicitly returned `fail` (e.g. a blocking
 *    implementation disagreement that exceeds the resolver's tolerance under
 *    the configured threshold).
 *
 * The policy is testable in isolation because it never touches I/O, agents,
 * or the envelope store — it sees only the decision artifact and the policy
 * inputs.
 */
import { describe, expect, it } from "vitest";
import {
  decideCollaborationNextStep,
  type CollaborationPolicyDecision,
} from "./policy";
import {
  makeBlockingImplementationDisagreement,
  makeImplementationDisagreement,
  makeMinorImplementationDisagreement,
  makeObjectiveDisagreement,
  makeResolutionDecisionAskUser,
  makeResolutionDecisionContinue,
  makeResolutionDecisionFail,
  makeResolutionDecisionFinal,
} from "./test-fixtures";

describe("decideCollaborationNextStep — next_action passthrough", () => {
  it("returns kind=final when Agent One declared agreement and next_action=final", () => {
    const decision = makeResolutionDecisionFinal();

    const result = decideCollaborationNextStep({
      decision,
      autonomousResolutionThreshold: "major",
      negotiationRoundsRemaining: 2,
    });

    expect(result satisfies CollaborationPolicyDecision).toMatchObject({
      kind: "final",
    });
  });

  it("returns kind=fail when Agent One explicitly chose fail", () => {
    const decision = makeResolutionDecisionFail();

    const result = decideCollaborationNextStep({
      decision,
      autonomousResolutionThreshold: "major",
      negotiationRoundsRemaining: 2,
    });

    expect(result.kind).toBe("fail");
  });
});

describe("decideCollaborationNextStep — objective disagreements always halt", () => {
  it("forces ask_user when an objective disagreement remains, regardless of next_action=continue_negotiation", () => {
    const decision = makeResolutionDecisionContinue({
      remaining_disagreements: [makeObjectiveDisagreement()],
    });

    const result = decideCollaborationNextStep({
      decision,
      autonomousResolutionThreshold: "blocking",
      negotiationRoundsRemaining: 5,
    });

    expect(result.kind).toBe("ask_user");
  });

  it("forces ask_user when an objective disagreement remains, regardless of next_action=final", () => {
    const decision = makeResolutionDecisionFinal({
      agreement_reached: false,
      remaining_disagreements: [makeObjectiveDisagreement()],
    });

    const result = decideCollaborationNextStep({
      decision,
      autonomousResolutionThreshold: "blocking",
      negotiationRoundsRemaining: 5,
    });

    expect(result.kind).toBe("ask_user");
  });
});

describe("decideCollaborationNextStep — implementation disagreement loops while rounds remain", () => {
  it("returns kind=continue_negotiation when implementation disagreements remain and rounds remain", () => {
    const decision = makeResolutionDecisionContinue({
      remaining_disagreements: [makeImplementationDisagreement()],
    });

    const result = decideCollaborationNextStep({
      decision,
      autonomousResolutionThreshold: "major",
      negotiationRoundsRemaining: 2,
    });

    expect(result.kind).toBe("continue_negotiation");
  });
});

describe("decideCollaborationNextStep — exhausted rounds + implementation disagreements", () => {
  it("returns ask_user when implementation disagreement severity exceeds threshold and no rounds remain", () => {
    const decision = makeResolutionDecisionContinue({
      remaining_disagreements: [makeImplementationDisagreement()],
    });

    const result = decideCollaborationNextStep({
      decision,
      autonomousResolutionThreshold: "minor",
      negotiationRoundsRemaining: 0,
    });

    expect(result.kind).toBe("ask_user");
  });

  it("returns final when implementation disagreement severity is at or below threshold and no rounds remain", () => {
    const decision = makeResolutionDecisionContinue({
      remaining_disagreements: [makeImplementationDisagreement()],
    });

    const result = decideCollaborationNextStep({
      decision,
      autonomousResolutionThreshold: "major",
      negotiationRoundsRemaining: 0,
    });

    expect(result.kind).toBe("final");
  });

  it("returns final when only minor disagreements remain and threshold is minor", () => {
    const decision = makeResolutionDecisionContinue({
      remaining_disagreements: [makeMinorImplementationDisagreement()],
    });

    const result = decideCollaborationNextStep({
      decision,
      autonomousResolutionThreshold: "minor",
      negotiationRoundsRemaining: 0,
    });

    expect(result.kind).toBe("final");
  });
});

describe("decideCollaborationNextStep — blocking severity gates", () => {
  it("returns ask_user when a blocking implementation disagreement remains and threshold is major", () => {
    const decision = makeResolutionDecisionContinue({
      remaining_disagreements: [makeBlockingImplementationDisagreement()],
    });

    const result = decideCollaborationNextStep({
      decision,
      autonomousResolutionThreshold: "major",
      negotiationRoundsRemaining: 0,
    });

    expect(result.kind).toBe("ask_user");
  });

  it("returns final when a blocking implementation disagreement remains and threshold is blocking", () => {
    const decision = makeResolutionDecisionContinue({
      remaining_disagreements: [makeBlockingImplementationDisagreement()],
    });

    const result = decideCollaborationNextStep({
      decision,
      autonomousResolutionThreshold: "blocking",
      negotiationRoundsRemaining: 0,
    });

    expect(result.kind).toBe("final");
  });
});

describe("decideCollaborationNextStep — threshold=none halts on any remaining disagreement", () => {
  it("returns ask_user when any disagreement remains and threshold is none, even with rounds remaining and continue_negotiation", () => {
    const decision = makeResolutionDecisionContinue({
      remaining_disagreements: [makeMinorImplementationDisagreement()],
    });

    const result = decideCollaborationNextStep({
      decision,
      autonomousResolutionThreshold: "none",
      negotiationRoundsRemaining: 0,
    });

    expect(result.kind).toBe("ask_user");
  });
});

describe("decideCollaborationNextStep — ask_user explicit", () => {
  it("returns ask_user when Agent One returned next_action=ask_user", () => {
    const decision = makeResolutionDecisionAskUser();

    const result = decideCollaborationNextStep({
      decision,
      autonomousResolutionThreshold: "blocking",
      negotiationRoundsRemaining: 5,
    });

    expect(result.kind).toBe("ask_user");
  });
});

describe("decideCollaborationNextStep — final with no remaining disagreements", () => {
  it("returns final when no disagreements remain and Agent One returned next_action=final, regardless of threshold", () => {
    const decision = makeResolutionDecisionFinal({
      remaining_disagreements: [],
    });

    const result = decideCollaborationNextStep({
      decision,
      autonomousResolutionThreshold: "none",
      negotiationRoundsRemaining: 0,
    });

    expect(result.kind).toBe("final");
  });
});

describe("decideCollaborationNextStep — loop discipline overrides next_action=final while rounds remain", () => {
  it("returns continue_negotiation when next_action=final but implementation disagreements remain within threshold and rounds remain", () => {
    const decision = makeResolutionDecisionFinal({
      agreement_reached: false,
      remaining_disagreements: [makeImplementationDisagreement()],
    });

    const result = decideCollaborationNextStep({
      decision,
      autonomousResolutionThreshold: "major",
      negotiationRoundsRemaining: 2,
    });

    expect(result.kind).toBe("continue_negotiation");
  });

  it("returns continue_negotiation when next_action=final but implementation disagreements above threshold remain and rounds remain", () => {
    const decision = makeResolutionDecisionFinal({
      agreement_reached: false,
      remaining_disagreements: [makeBlockingImplementationDisagreement()],
    });

    const result = decideCollaborationNextStep({
      decision,
      autonomousResolutionThreshold: "major",
      negotiationRoundsRemaining: 2,
    });

    expect(result.kind).toBe("continue_negotiation");
  });
});
