/**
 * Reusable typed fixtures for the asymmetric Collaboration Mode artifact
 * stream. Used by backend prompt/orchestrator tests and Storybook stories so
 * the same canonical objects exercise validation, prompt construction, and
 * UI rendering.
 *
 * Each canonical fixture is built by a factory that returns a fully populated
 * artifact and accepts shallow `Partial<>` overrides for tests that need to
 * tweak a single field. The shapes match the Zod schemas in
 * `src/lib/schemas.ts` (re-exported via `./types.ts`).
 *
 * The fixtures cover:
 *   1. Agent One initial draft
 *   2. Agent Two initial draft
 *   3. Agent Two cross-review of Agent One's draft
 *   4. Agent One proposed changes
 *   5. Agent Two counter-proposal (round 1)
 *   6. Agent Two counter-proposal (round 2 — for the stale-resolution
 *      regression test, where the counter-proposal differs from round 1's)
 *   7. Agent One resolution decisions: `final`, `continue_negotiation`,
 *      `ask_user`, `fail`
 *   8. Open conflicts (orchestrator-produced)
 *   9. Final answer with a collapsed-audit `report` path the UI links to
 */
import type {
  CollaborationArtifactAgreement,
  CollaborationArtifactDisagreement,
  CollaborationChangeProposal,
  CollaborationCounterProposalOutput,
  CollaborationCrossReviewOutput,
  CollaborationFinalAnswerOutput,
  CollaborationInitialDraftOutput,
  CollaborationOpenConflictsOutput,
  CollaborationProposedChangesOutput,
  CollaborationResolutionDecisionOutput,
  CollaborationResolvedDisagreement,
  CollaborationReviseSelfArtifact,
  CollaborationUserQuestion,
} from "./types";

const WORKFLOW_BASE = "memory-bank/collaboration/wf-fixture";

const reportPath = (segment: string): string =>
  `${WORKFLOW_BASE}/${segment}.md`;
const supportingPath = (segment: string, file: string): string =>
  `${WORKFLOW_BASE}/${segment}/${file}`;

// ============================================================
// Leaf fixtures: agreements, disagreements, change proposals.
// ============================================================

function makeAgreement(
  overrides: Partial<CollaborationArtifactAgreement> = {},
): CollaborationArtifactAgreement {
  return {
    id: "A-1",
    claim: "Reuse the workflow envelope as the persistence boundary",
    ref: {
      artifact: reportPath("initial/agent-one"),
      locator: "#persistence",
    },
    ...overrides,
  };
}

export function makeImplementationDisagreement(
  overrides: Partial<CollaborationArtifactDisagreement> = {},
): CollaborationArtifactDisagreement {
  return {
    id: "D-impl-1",
    category: "implementation",
    severity: "major",
    claim: "Introduce a separate notification table",
    reason: "Adds operational overhead without solving a real problem",
    proposedResolution: "Reuse the existing envelope-driven status bus",
    ref: {
      artifact: reportPath("cross-review/agent-two"),
      locator: "#notification-table",
    },
    ...overrides,
  };
}

export function makeMinorImplementationDisagreement(
  overrides: Partial<CollaborationArtifactDisagreement> = {},
): CollaborationArtifactDisagreement {
  return {
    id: "D-impl-minor",
    category: "implementation",
    severity: "minor",
    claim: "Rename `runId` to `collaborationRunId`",
    reason: "Field name is ambiguous in mixed-context code",
    ...overrides,
  };
}

export function makeBlockingImplementationDisagreement(
  overrides: Partial<CollaborationArtifactDisagreement> = {},
): CollaborationArtifactDisagreement {
  return {
    id: "D-impl-blocking",
    category: "implementation",
    severity: "blocking",
    claim: "Drop SSE entirely from the run lifecycle",
    reason: "Loses live updates with no equivalent proposed",
    ...overrides,
  };
}

export function makeObjectiveDisagreement(
  overrides: Partial<CollaborationArtifactDisagreement> = {},
): CollaborationArtifactDisagreement {
  return {
    id: "D-obj-1",
    category: "objective",
    severity: "blocking",
    claim: "The user asked for a design, not an implementation plan",
    reason: "The scope changes which artifacts should be produced",
    ...overrides,
  };
}

function makeChangeProposal(
  overrides: Partial<CollaborationChangeProposal> = {},
): CollaborationChangeProposal {
  return {
    id: "PC-1",
    change: "Use the workflow envelope store for progress snapshots",
    rationale: "Both UI and backend already consume it",
    addressesDisagreementIds: ["D-impl-1"],
    ...overrides,
  };
}

export function makeReviseSelf(
  overrides: Partial<CollaborationReviseSelfArtifact> = {},
): CollaborationReviseSelfArtifact {
  return {
    change: "Adopt the existing notification path for status updates",
    because: "It avoids introducing a second delivery mechanism",
    ...overrides,
  };
}

export function makeUserQuestion(
  overrides: Partial<CollaborationUserQuestion> = {},
): CollaborationUserQuestion {
  return {
    id: "Q-1",
    question: "Should the output be a design document or implementation plan?",
    relatedDisagreementIds: ["D-obj-1"],
    ...overrides,
  };
}

export function makeResolvedDisagreement(
  overrides: Partial<CollaborationResolvedDisagreement> = {},
): CollaborationResolvedDisagreement {
  return {
    disagreementId: "D-impl-1",
    resolution: "Use the envelope store with a separate snapshot view",
    resolvedAutonomously: true,
    rationale:
      "Major implementation disagreement is within configured threshold",
    ...overrides,
  };
}

// ============================================================
// Initial drafts (agents draft in parallel, see only the user prompt).
// ============================================================

export function makeAgentOneInitialDraft(
  overrides: Partial<CollaborationInitialDraftOutput> = {},
): CollaborationInitialDraftOutput {
  return {
    kind: "initial_draft",
    agent: "agent_one",
    narrative:
      "Agent One proposes reusing the workflow envelope as the source of truth.",
    report: reportPath("initial/agent-one"),
    supporting: [supportingPath("initial/agent-one", "api-sketch.md")],
    assumptions: [
      "Synthesis remains in the conversation transcript.",
      "Pause/resume is driven by the existing envelope state.",
    ],
    keyClaims: [
      makeAgreement({
        id: "A-1",
        claim: "Reuse the workflow envelope for state",
      }),
      makeAgreement({
        id: "A-2",
        claim: "Persist artifacts as ArtifactRegistry references",
        ref: {
          artifact: reportPath("initial/agent-one"),
          locator: "#artifacts",
        },
      }),
    ],
    ...overrides,
  };
}

export function makeAgentTwoInitialDraft(
  overrides: Partial<CollaborationInitialDraftOutput> = {},
): CollaborationInitialDraftOutput {
  return {
    kind: "initial_draft",
    agent: "agent_two",
    narrative:
      "Agent Two proposes a dedicated notification table to track delivery.",
    report: reportPath("initial/agent-two"),
    supporting: [supportingPath("initial/agent-two", "schema.md")],
    assumptions: [
      "Notifications must survive process restarts.",
      "A new table simplifies query patterns for the UI.",
    ],
    keyClaims: [
      makeAgreement({
        id: "A-1",
        claim: "Persist run state for resumability",
        ref: {
          artifact: reportPath("initial/agent-two"),
          locator: "#persistence",
        },
      }),
    ],
    ...overrides,
  };
}

// ============================================================
// Cross-review: Agent Two reviews Agent One's draft.
// (Agent One's symmetrical review is folded into proposed_changes.)
// ============================================================

export function makeAgentTwoCrossReview(
  overrides: Partial<CollaborationCrossReviewOutput> = {},
): CollaborationCrossReviewOutput {
  return {
    kind: "cross_review",
    agent: "agent_two",
    targetAgent: "agent_one",
    narrative:
      "Agent Two agrees with envelope reuse but flags the notification table tradeoff.",
    report: reportPath("cross-review/agent-two"),
    supporting: [
      supportingPath("cross-review/agent-two", "table-pros-cons.md"),
    ],
    agree: [makeAgreement({ id: "A-1" })],
    disagree: [makeImplementationDisagreement()],
    reviseSelf: [makeReviseSelf()],
    ...overrides,
  };
}

// ============================================================
// Negotiation: Agent One -> proposed_changes, Agent Two -> counter_proposal.
// ============================================================

export function makeAgentOneProposedChanges(
  overrides: Partial<CollaborationProposedChangesOutput> = {},
): CollaborationProposedChangesOutput {
  return {
    kind: "proposed_changes",
    agent: "agent_one",
    targetAgent: "agent_two",
    narrative:
      "Agent One incorporates Agent Two's review and proposes envelope-based snapshots.",
    acceptedFromAgentTwoDraft: [
      makeAgreement({
        id: "A-2-from-two",
        claim: "Persist run state for resumability",
      }),
    ],
    proposedChanges: [
      makeChangeProposal({
        id: "PC-1",
        change: "Use the envelope store for progress snapshots",
        addressesDisagreementIds: ["D-impl-1"],
      }),
    ],
    remainingDisagreements: [makeImplementationDisagreement()],
    report: reportPath("negotiation-1/proposed"),
    supporting: [supportingPath("negotiation-1", "envelope-snapshot-plan.md")],
    ...overrides,
  };
}

export function makeAgentTwoCounterProposalRound1(
  overrides: Partial<CollaborationCounterProposalOutput> = {},
): CollaborationCounterProposalOutput {
  return {
    kind: "counter_proposal",
    agent: "agent_two",
    narrative:
      "Agent Two accepts the envelope snapshot but pushes back on collapsing notifications.",
    acceptedProposedChangeIds: ["PC-1"],
    rejectedProposedChangeIds: [],
    alternativeChanges: [
      makeChangeProposal({
        id: "AC-1",
        change: "Materialize an envelope-derived notification view",
        rationale:
          "Keeps single source of truth without losing query ergonomics",
        addressesDisagreementIds: ["D-impl-1"],
      }),
    ],
    agree: [makeAgreement({ id: "A-1" })],
    disagree: [makeImplementationDisagreement()],
    report: reportPath("negotiation-1/counter"),
    supporting: [supportingPath("negotiation-1", "view-shape.md")],
    ...overrides,
  };
}

export function makeAgentTwoCounterProposalRound2(
  overrides: Partial<CollaborationCounterProposalOutput> = {},
): CollaborationCounterProposalOutput {
  return {
    kind: "counter_proposal",
    agent: "agent_two",
    narrative:
      "Round 2: Agent Two drops the implementation disagreement and surfaces an objective scope concern.",
    acceptedProposedChangeIds: ["PC-1", "PC-2"],
    rejectedProposedChangeIds: [],
    alternativeChanges: [],
    agree: [
      makeAgreement({ id: "A-1" }),
      makeAgreement({
        id: "A-3",
        claim: "Envelope-derived view is acceptable",
        ref: {
          artifact: reportPath("negotiation-2/counter"),
          locator: "#view",
        },
      }),
    ],
    disagree: [makeObjectiveDisagreement()],
    report: reportPath("negotiation-2/counter"),
    supporting: [supportingPath("negotiation-2", "scope-question.md")],
    ...overrides,
  };
}

// ============================================================
// Resolution decisions (Agent One only, one per nextAction value).
// ============================================================

export function makeResolutionDecisionFinal(
  overrides: Partial<CollaborationResolutionDecisionOutput> = {},
): CollaborationResolutionDecisionOutput {
  return {
    kind: "resolution_decision",
    agent: "agent_one",
    agreementReached: true,
    nextAction: "final",
    acceptedPoints: [makeAgreement({ id: "A-1" })],
    resolvedDisagreements: [
      makeResolvedDisagreement({
        disagreementId: "D-impl-1",
        resolution: "Adopt envelope-derived notification view (AC-1)",
        resolvedAutonomously: true,
      }),
    ],
    remainingDisagreements: [],
    userQuestions: [],
    rationale:
      "All disagreements are resolved within the configured autonomous threshold.",
    ...overrides,
  };
}

export function makeResolutionDecisionContinue(
  overrides: Partial<CollaborationResolutionDecisionOutput> = {},
): CollaborationResolutionDecisionOutput {
  return {
    kind: "resolution_decision",
    agent: "agent_one",
    agreementReached: false,
    nextAction: "continue_negotiation",
    acceptedPoints: [makeAgreement({ id: "A-1" })],
    resolvedDisagreements: [],
    remainingDisagreements: [makeImplementationDisagreement()],
    userQuestions: [],
    rationale:
      "Implementation disagreement remains; rounds remain so continue negotiation.",
    ...overrides,
  };
}

export function makeResolutionDecisionAskUser(
  overrides: Partial<CollaborationResolutionDecisionOutput> = {},
): CollaborationResolutionDecisionOutput {
  return {
    kind: "resolution_decision",
    agent: "agent_one",
    agreementReached: false,
    nextAction: "ask_user",
    acceptedPoints: [makeAgreement({ id: "A-1" })],
    resolvedDisagreements: [],
    remainingDisagreements: [makeObjectiveDisagreement()],
    userQuestions: [makeUserQuestion()],
    rationale:
      "Objective disagreement requires user clarification before continuing.",
    ...overrides,
  };
}

export function makeResolutionDecisionFail(
  overrides: Partial<CollaborationResolutionDecisionOutput> = {},
): CollaborationResolutionDecisionOutput {
  return {
    kind: "resolution_decision",
    agent: "agent_one",
    agreementReached: false,
    nextAction: "fail",
    acceptedPoints: [],
    resolvedDisagreements: [],
    remainingDisagreements: [makeBlockingImplementationDisagreement()],
    userQuestions: [],
    rationale:
      "Blocking disagreement cannot be resolved under the configured threshold.",
    ...overrides,
  };
}

// ============================================================
// Open conflicts (orchestrator-produced — surfaced when nextAction is ask_user).
// ============================================================

export function makeOpenConflicts(
  overrides: Partial<CollaborationOpenConflictsOutput> = {},
): CollaborationOpenConflictsOutput {
  return {
    kind: "open_conflicts",
    disagreements: [makeObjectiveDisagreement()],
    questions: [makeUserQuestion()],
    ...overrides,
  };
}

// ============================================================
// Final answer (Agent One only). The `report` path is the collapsed-audit
// source the UI's "Resolution audit" disclosure links back to.
// ============================================================

export function makeFinalAnswer(
  overrides: Partial<CollaborationFinalAnswerOutput> = {},
): CollaborationFinalAnswerOutput {
  return {
    kind: "final_answer",
    agent: "agent_one",
    answer:
      "# Final design\n\nReuse the workflow envelope as the source of truth and expose an envelope-derived notification view.",
    report: reportPath("final/answer"),
    supporting: [
      supportingPath("final", "resolution-audit.md"),
      supportingPath("final", "key-decisions.md"),
    ],
    ...overrides,
  };
}

// ============================================================
// Canonical full-stream snapshot for stories and integration tests.
// ============================================================

export interface CollaborationAsymmetricStreamFixture {
  agentOneInitialDraft: CollaborationInitialDraftOutput;
  agentTwoInitialDraft: CollaborationInitialDraftOutput;
  agentTwoCrossReview: CollaborationCrossReviewOutput;
  agentOneProposedChanges: CollaborationProposedChangesOutput;
  agentTwoCounterProposalRound1: CollaborationCounterProposalOutput;
  agentTwoCounterProposalRound2: CollaborationCounterProposalOutput;
  resolutionDecisionFinal: CollaborationResolutionDecisionOutput;
  resolutionDecisionContinue: CollaborationResolutionDecisionOutput;
  resolutionDecisionAskUser: CollaborationResolutionDecisionOutput;
  resolutionDecisionFail: CollaborationResolutionDecisionOutput;
  openConflicts: CollaborationOpenConflictsOutput;
  finalAnswer: CollaborationFinalAnswerOutput;
}

export function makeCollaborationAsymmetricStreamFixture(): CollaborationAsymmetricStreamFixture {
  return {
    agentOneInitialDraft: makeAgentOneInitialDraft(),
    agentTwoInitialDraft: makeAgentTwoInitialDraft(),
    agentTwoCrossReview: makeAgentTwoCrossReview(),
    agentOneProposedChanges: makeAgentOneProposedChanges(),
    agentTwoCounterProposalRound1: makeAgentTwoCounterProposalRound1(),
    agentTwoCounterProposalRound2: makeAgentTwoCounterProposalRound2(),
    resolutionDecisionFinal: makeResolutionDecisionFinal(),
    resolutionDecisionContinue: makeResolutionDecisionContinue(),
    resolutionDecisionAskUser: makeResolutionDecisionAskUser(),
    resolutionDecisionFail: makeResolutionDecisionFail(),
    openConflicts: makeOpenConflicts(),
    finalAnswer: makeFinalAnswer(),
  };
}
