/**
 * Asserts every canonical fixture parses against its Zod schema, so backend
 * tests and Storybook stories can rely on these fixtures as valid artifact
 * outputs without re-validating per use.
 */
import { describe, expect, it } from "vitest";

import {
  collaborationArtifactSchema,
  collaborationCounterProposalOutputSchema,
  collaborationCrossReviewOutputSchema,
  collaborationFinalAnswerOutputSchema,
  collaborationInitialDraftOutputSchema,
  collaborationOpenConflictsOutputSchema,
  collaborationProposedChangesOutputSchema,
  collaborationResolutionDecisionOutputSchema,
} from "./types";
import {
  makeAgentOneInitialDraft,
  makeAgentOneProposedChanges,
  makeAgentTwoCounterProposalRound1,
  makeAgentTwoCounterProposalRound2,
  makeAgentTwoCrossReview,
  makeAgentTwoInitialDraft,
  makeCollaborationAsymmetricStreamFixture,
  makeFinalAnswer,
  makeOpenConflicts,
  makeResolutionDecisionAskUser,
  makeResolutionDecisionContinue,
  makeResolutionDecisionFail,
  makeResolutionDecisionFinal,
} from "./test-fixtures";

describe("collaboration asymmetric fixtures", () => {
  it("agent one initial draft validates", () => {
    expect(
      collaborationInitialDraftOutputSchema.safeParse(
        makeAgentOneInitialDraft(),
      ).success,
    ).toBe(true);
  });

  it("agent two initial draft validates", () => {
    expect(
      collaborationInitialDraftOutputSchema.safeParse(
        makeAgentTwoInitialDraft(),
      ).success,
    ).toBe(true);
  });

  it("agent two cross-review validates and targets agent_one", () => {
    const fixture = makeAgentTwoCrossReview();
    expect(
      collaborationCrossReviewOutputSchema.safeParse(fixture).success,
    ).toBe(true);
    expect(fixture.agent).toBe("agent_two");
    expect(fixture.targetAgent).toBe("agent_one");
  });

  it("agent one proposed changes validates and targets agent_two", () => {
    const fixture = makeAgentOneProposedChanges();
    expect(
      collaborationProposedChangesOutputSchema.safeParse(fixture).success,
    ).toBe(true);
    expect(fixture.agent).toBe("agent_one");
    expect(fixture.targetAgent).toBe("agent_two");
  });

  it("agent two counter-proposals validate (round 1 and round 2)", () => {
    const r1 = makeAgentTwoCounterProposalRound1();
    const r2 = makeAgentTwoCounterProposalRound2();
    expect(collaborationCounterProposalOutputSchema.safeParse(r1).success).toBe(
      true,
    );
    expect(collaborationCounterProposalOutputSchema.safeParse(r2).success).toBe(
      true,
    );
    expect(r1).not.toEqual(r2);
  });

  it("each resolution decision variant validates with its own nextAction", () => {
    const variants = [
      { fn: makeResolutionDecisionFinal, expected: "final" as const },
      {
        fn: makeResolutionDecisionContinue,
        expected: "continue_negotiation" as const,
      },
      { fn: makeResolutionDecisionAskUser, expected: "ask_user" as const },
      { fn: makeResolutionDecisionFail, expected: "fail" as const },
    ];
    for (const { fn, expected } of variants) {
      const fixture = fn();
      expect(
        collaborationResolutionDecisionOutputSchema.safeParse(fixture).success,
      ).toBe(true);
      expect(fixture.nextAction).toBe(expected);
      expect(fixture.agent).toBe("agent_one");
    }
  });

  it("open conflicts validates", () => {
    expect(
      collaborationOpenConflictsOutputSchema.safeParse(makeOpenConflicts())
        .success,
    ).toBe(true);
  });

  it("final answer validates and exposes a collapsed-audit report path", () => {
    const fixture = makeFinalAnswer();
    expect(
      collaborationFinalAnswerOutputSchema.safeParse(fixture).success,
    ).toBe(true);
    expect(fixture.report).toMatch(/\.md$/);
    expect(fixture.supporting.length).toBeGreaterThan(0);
  });

  it("the canonical stream snapshot exposes every artifact kind once", () => {
    const stream = makeCollaborationAsymmetricStreamFixture();
    const everyArtifact = [
      stream.agentOneInitialDraft,
      stream.agentTwoInitialDraft,
      stream.agentTwoCrossReview,
      stream.agentOneProposedChanges,
      stream.agentTwoCounterProposalRound1,
      stream.agentTwoCounterProposalRound2,
      stream.resolutionDecisionFinal,
      stream.resolutionDecisionContinue,
      stream.resolutionDecisionAskUser,
      stream.resolutionDecisionFail,
      stream.openConflicts,
      stream.finalAnswer,
    ];
    for (const artifact of everyArtifact) {
      expect(collaborationArtifactSchema.safeParse(artifact).success).toBe(
        true,
      );
    }
  });

  it("override pattern lets tests change a single field deterministically", () => {
    const draft = makeAgentOneInitialDraft({ narrative: "custom narrative" });
    expect(draft.narrative).toBe("custom narrative");
    expect(draft.agent).toBe("agent_one");
  });
});
