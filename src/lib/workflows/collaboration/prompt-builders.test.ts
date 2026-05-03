/**
 * Tests for the asymmetric Collaboration Mode prompt builders. Each builder
 * must:
 *  - request the matching JSON Schema as `outputSchema`,
 *  - include only the role-appropriate context described in
 *    `memory-bank/COLLABORATION_MODE_FLOW.md`,
 *  - never deliver Agent Two's cross-review to Agent One as a standalone
 *    negotiation message,
 *  - thread the latest counter-proposal into Agent One's resolution prompt
 *    (regression for the previous stale-resolution bug),
 *  - thread user clarifications into the final answer prompt without asking
 *    the agent to author a separate resolution audit section.
 */
import { describe, expect, it } from "vitest";

import {
  COLLABORATION_COUNTER_PROPOSAL_OUTPUT_SCHEMA,
  COLLABORATION_CROSS_REVIEW_OUTPUT_SCHEMA,
  COLLABORATION_FINAL_ANSWER_OUTPUT_SCHEMA,
  COLLABORATION_INITIAL_DRAFT_OUTPUT_SCHEMA,
  COLLABORATION_PROPOSED_CHANGES_OUTPUT_SCHEMA,
  COLLABORATION_RESOLUTION_DECISION_OUTPUT_SCHEMA,
} from "./types";
import {
  buildAgentOneFinalAnswerPrompt,
  buildAgentOneInitialDraftPrompt,
  buildAgentOneProposedChangesPrompt,
  buildAgentOneResolutionDecisionPrompt,
  buildAgentTwoCounterProposalPrompt,
  buildAgentTwoCrossReviewPrompt,
  buildAgentTwoInitialDraftPrompt,
} from "./prompt-builders";
import {
  makeAgentOneInitialDraft,
  makeAgentOneProposedChanges,
  makeAgentTwoCounterProposalRound1,
  makeAgentTwoCounterProposalRound2,
  makeAgentTwoCrossReview,
  makeAgentTwoInitialDraft,
  makeOpenConflicts,
  makeResolutionDecisionAskUser,
  makeResolutionDecisionContinue,
  makeResolutionDecisionFinal,
} from "./test-fixtures";

const USER_PROMPT = "Design pause/resume for the collaboration workflow.";

describe("buildAgentOneInitialDraftPrompt", () => {
  it("requests the initial_draft schema and binds the agent_one role", () => {
    const built = buildAgentOneInitialDraftPrompt({ userPrompt: USER_PROMPT });
    expect(built.outputSchema).toBe(COLLABORATION_INITIAL_DRAFT_OUTPUT_SCHEMA);
    expect(built.prompt).toContain(USER_PROMPT);
    expect(built.prompt).toMatch(/agent_one/i);
    expect(built.prompt).toMatch(/initial draft/i);
  });

  it("does not leak Agent Two context into the initial draft prompt", () => {
    const built = buildAgentOneInitialDraftPrompt({ userPrompt: USER_PROMPT });
    expect(built.prompt).not.toMatch(/counter[- ]?proposal/i);
    expect(built.prompt).not.toMatch(/cross[- ]?review/i);
    expect(built.prompt).not.toMatch(/agent_two draft/i);
  });
});

describe("buildAgentTwoInitialDraftPrompt", () => {
  it("requests the initial_draft schema and binds the agent_two role", () => {
    const built = buildAgentTwoInitialDraftPrompt({ userPrompt: USER_PROMPT });
    expect(built.outputSchema).toBe(COLLABORATION_INITIAL_DRAFT_OUTPUT_SCHEMA);
    expect(built.prompt).toContain(USER_PROMPT);
    expect(built.prompt).toMatch(/agent_two/i);
  });
});

describe("buildAgentOneProposedChangesPrompt", () => {
  it("requests the proposed_changes schema and includes both initial drafts", () => {
    const ownDraft = makeAgentOneInitialDraft();
    const otherDraft = makeAgentTwoInitialDraft();
    const built = buildAgentOneProposedChangesPrompt({
      userPrompt: USER_PROMPT,
      ownDraft,
      otherDraft,
    });
    expect(built.outputSchema).toBe(
      COLLABORATION_PROPOSED_CHANGES_OUTPUT_SCHEMA,
    );
    expect(built.prompt).toContain(USER_PROMPT);
    expect(built.prompt).toContain(ownDraft.report);
    expect(built.prompt).toContain(otherDraft.report);
    expect(built.prompt).toContain(otherDraft.narrative);
  });

  it("does not include Agent Two's cross-review (it is incorporated into the counter-proposal)", () => {
    const ownDraft = makeAgentOneInitialDraft();
    const otherDraft = makeAgentTwoInitialDraft();
    const crossReview = makeAgentTwoCrossReview();
    const built = buildAgentOneProposedChangesPrompt({
      userPrompt: USER_PROMPT,
      ownDraft,
      otherDraft,
    });
    expect(built.prompt).not.toContain(crossReview.report);
    expect(built.prompt).not.toContain(crossReview.narrative);
  });
});

describe("buildAgentTwoCrossReviewPrompt", () => {
  it("requests the cross_review schema and includes both initial drafts", () => {
    const ownDraft = makeAgentTwoInitialDraft();
    const otherDraft = makeAgentOneInitialDraft();
    const built = buildAgentTwoCrossReviewPrompt({
      userPrompt: USER_PROMPT,
      ownDraft,
      otherDraft,
    });
    expect(built.outputSchema).toBe(COLLABORATION_CROSS_REVIEW_OUTPUT_SCHEMA);
    expect(built.prompt).toContain(USER_PROMPT);
    expect(built.prompt).toContain(otherDraft.report);
    expect(built.prompt).toContain(ownDraft.report);
    expect(built.prompt).toMatch(/cross[- ]?review/i);
    expect(built.prompt).toMatch(/output zone/i);
  });
});

describe("buildAgentTwoCounterProposalPrompt", () => {
  it("requests the counter_proposal schema and includes drafts, own cross-review, and Agent One proposed changes", () => {
    const ownDraft = makeAgentTwoInitialDraft();
    const otherDraft = makeAgentOneInitialDraft();
    const ownCrossReview = makeAgentTwoCrossReview();
    const proposedChanges = makeAgentOneProposedChanges();
    const built = buildAgentTwoCounterProposalPrompt({
      userPrompt: USER_PROMPT,
      ownDraft,
      otherDraft,
      ownCrossReview,
      proposedChanges,
    });
    expect(built.outputSchema).toBe(
      COLLABORATION_COUNTER_PROPOSAL_OUTPUT_SCHEMA,
    );
    expect(built.prompt).toContain(USER_PROMPT);
    expect(built.prompt).toContain(ownDraft.report);
    expect(built.prompt).toContain(otherDraft.report);
    expect(built.prompt).toContain(ownCrossReview.report);
    expect(built.prompt).toContain(proposedChanges.report);
    for (const change of proposedChanges.proposedChanges) {
      expect(built.prompt).toContain(change.id);
    }
  });

  it("instructs Agent Two to incorporate its prior cross-review into the counter-proposal", () => {
    const ownDraft = makeAgentTwoInitialDraft();
    const otherDraft = makeAgentOneInitialDraft();
    const ownCrossReview = makeAgentTwoCrossReview();
    const proposedChanges = makeAgentOneProposedChanges();
    const built = buildAgentTwoCounterProposalPrompt({
      userPrompt: USER_PROMPT,
      ownDraft,
      otherDraft,
      ownCrossReview,
      proposedChanges,
    });
    expect(built.prompt).toMatch(/incorporate.*cross[- ]?review/i);
  });
});

describe("buildAgentOneResolutionDecisionPrompt", () => {
  it("requests the resolution_decision schema and includes the LATEST counter-proposal", () => {
    const round1 = makeAgentTwoCounterProposalRound1();
    const round2 = makeAgentTwoCounterProposalRound2();
    const built = buildAgentOneResolutionDecisionPrompt({
      userPrompt: USER_PROMPT,
      ownDraft: makeAgentOneInitialDraft(),
      otherDraft: makeAgentTwoInitialDraft(),
      proposedChanges: makeAgentOneProposedChanges(),
      latestCounterProposal: round2,
      negotiationRound: 2,
    });
    expect(built.outputSchema).toBe(
      COLLABORATION_RESOLUTION_DECISION_OUTPUT_SCHEMA,
    );
    expect(built.prompt).toContain(round2.report);
    expect(built.prompt).toContain(round2.narrative);
    expect(built.prompt).not.toContain(round1.report);
    expect(built.prompt).not.toContain(round1.narrative);
  });

  it("regression: round 2 resolution prompt cites the round 2 counter-proposal, not round 1", () => {
    const round1 = makeAgentTwoCounterProposalRound1();
    const round2 = makeAgentTwoCounterProposalRound2();
    expect(round1.report).not.toBe(round2.report);
    const builtRound2 = buildAgentOneResolutionDecisionPrompt({
      userPrompt: USER_PROMPT,
      ownDraft: makeAgentOneInitialDraft(),
      otherDraft: makeAgentTwoInitialDraft(),
      proposedChanges: makeAgentOneProposedChanges(),
      latestCounterProposal: round2,
      negotiationRound: 2,
    });
    expect(builtRound2.prompt).toContain(round2.report);
    expect(builtRound2.prompt).not.toContain(round1.report);
    expect(builtRound2.prompt).toMatch(/round\s*2/i);
  });

  // Regression: the resolver must see every disagreement Agent Two raised in
  // its latest counter-proposal — id, claim, and severity. If the prompt
  // builder ever drops the disagree summary, Agent One can silently ignore
  // disagreements that should be addressed (resolved, kept open, or routed
  // to the user).
  it("regression: includes every disagreement from the latest counter-proposal in the prompt", () => {
    const counter = makeAgentTwoCounterProposalRound1();
    expect(counter.disagree.length).toBeGreaterThan(0);
    const built = buildAgentOneResolutionDecisionPrompt({
      userPrompt: USER_PROMPT,
      ownDraft: makeAgentOneInitialDraft(),
      otherDraft: makeAgentTwoInitialDraft(),
      proposedChanges: makeAgentOneProposedChanges(),
      latestCounterProposal: counter,
      negotiationRound: 1,
    });
    for (const d of counter.disagree) {
      expect(built.prompt).toContain(d.id);
      expect(built.prompt).toContain(d.claim);
      expect(built.prompt).toContain(d.severity);
    }
  });
});

describe("buildAgentOneFinalAnswerPrompt", () => {
  it("requests the final_answer schema and includes the prior artifacts", () => {
    const built = buildAgentOneFinalAnswerPrompt({
      userPrompt: USER_PROMPT,
      ownDraft: makeAgentOneInitialDraft(),
      otherDraft: makeAgentTwoInitialDraft(),
      latestCounterProposal: makeAgentTwoCounterProposalRound1(),
      latestResolutionDecision: makeResolutionDecisionAskUser(),
    });
    expect(built.outputSchema).toBe(COLLABORATION_FINAL_ANSWER_OUTPUT_SCHEMA);
    expect(built.prompt).toContain(USER_PROMPT);
    expect(built.prompt).toContain("agent_one");
  });

  it("threads user clarifications into the final answer prompt after open conflicts", () => {
    const openConflicts = makeOpenConflicts();
    const userAnswers = [
      {
        questionId: openConflicts.questions[0]!.id,
        question: openConflicts.questions[0]!.question,
        answer: "Produce a design document, not an implementation plan.",
      },
    ];
    const built = buildAgentOneFinalAnswerPrompt({
      userPrompt: USER_PROMPT,
      ownDraft: makeAgentOneInitialDraft(),
      otherDraft: makeAgentTwoInitialDraft(),
      latestCounterProposal: makeAgentTwoCounterProposalRound1(),
      latestResolutionDecision: makeResolutionDecisionAskUser(),
      openConflicts,
      userAnswers,
    });
    expect(built.prompt).toContain(openConflicts.questions[0]!.question);
    expect(built.prompt).toContain(userAnswers[0]!.answer);
  });

  it("includes the full prior artifact stream in order for final synthesis", () => {
    const crossReview = makeAgentTwoCrossReview();
    const round1Proposed = makeAgentOneProposedChanges();
    const round1Counter = makeAgentTwoCounterProposalRound1();
    const round1Decision = makeResolutionDecisionContinue();
    const round2Proposed = makeAgentOneProposedChanges({
      report: "memory-bank/collaboration/wf-fixture/negotiation-2/proposed.md",
      narrative: "Round 2 proposed changes",
    });
    const round2Counter = makeAgentTwoCounterProposalRound2();
    const round2Decision = makeResolutionDecisionFinal();

    const built = buildAgentOneFinalAnswerPrompt({
      userPrompt: USER_PROMPT,
      ownDraft: makeAgentOneInitialDraft(),
      otherDraft: makeAgentTwoInitialDraft(),
      latestCounterProposal: round2Counter,
      latestResolutionDecision: round2Decision,
      artifactStream: [
        makeAgentOneInitialDraft(),
        makeAgentTwoInitialDraft(),
        crossReview,
        round1Proposed,
        round1Counter,
        round1Decision,
        round2Proposed,
        round2Counter,
        round2Decision,
      ],
    });

    const crossReviewIndex = built.prompt.indexOf(crossReview.report);
    const round1ProposedIndex = built.prompt.indexOf(round1Proposed.report);
    const round1CounterIndex = built.prompt.indexOf(round1Counter.report);
    const round1DecisionIndex = built.prompt.indexOf(round1Decision.rationale);
    const round2ProposedIndex = built.prompt.indexOf(round2Proposed.report);
    const round2CounterIndex = built.prompt.indexOf(round2Counter.report);
    const round2DecisionIndex = built.prompt.indexOf(round2Decision.rationale);

    expect(crossReviewIndex).toBeGreaterThan(-1);
    expect(round1ProposedIndex).toBeGreaterThan(crossReviewIndex);
    expect(round1CounterIndex).toBeGreaterThan(round1ProposedIndex);
    expect(round1DecisionIndex).toBeGreaterThan(round1CounterIndex);
    expect(round2ProposedIndex).toBeGreaterThan(round1DecisionIndex);
    expect(round2CounterIndex).toBeGreaterThan(round2ProposedIndex);
    expect(round2DecisionIndex).toBeGreaterThan(round2CounterIndex);
  });

  it("does not ask the agent to author a separate resolution audit section in the answer body", () => {
    const built = buildAgentOneFinalAnswerPrompt({
      userPrompt: USER_PROMPT,
      ownDraft: makeAgentOneInitialDraft(),
      otherDraft: makeAgentTwoInitialDraft(),
      latestCounterProposal: makeAgentTwoCounterProposalRound1(),
      latestResolutionDecision: makeResolutionDecisionAskUser(),
    });
    expect(built.prompt).not.toMatch(/resolution audit section/i);
    expect(built.prompt).not.toMatch(/include.*resolution audit.*section/i);
    expect(built.prompt).not.toMatch(/append.*resolution audit/i);
  });
});
