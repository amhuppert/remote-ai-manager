/**
 * Reusable typed fixtures for the asymmetric Collaboration Mode artifact
 * stream. Used by backend prompt/orchestrator tests and Storybook stories so
 * the same canonical objects exercise validation, prompt construction, and UI
 * rendering.
 */
import type {
  CollaborationArtifactAgreement,
  CollaborationArtifactDisagreement,
  CollaborationChangeProposal,
  CollaborationCounterProposalOutput,
  CollaborationCrossReviewOutput,
  CollaborationFinalAnswerOutput,
  CollaborationGeneratedArtifact,
  CollaborationInitialDraftOutput,
  CollaborationOpenConflictsOutput,
  CollaborationProposedChangesOutput,
  CollaborationResolutionDecisionOutput,
  CollaborationResolvedDisagreement,
  CollaborationReviseSelfArtifact,
  CollaborationUserQuestion,
} from "./types";

const WORKFLOW_ID = "wf-fixture";
const WORKFLOW_BASE = `memory-bank/collaboration/${WORKFLOW_ID}`;

type FixtureAgent = "agent_one" | "agent_two";
type FixturePhase = CollaborationGeneratedArtifact["phase"];

const artifactPath = (
  round: number,
  agent: FixtureAgent,
  phase: FixturePhase,
  file: string,
): string => `${WORKFLOW_BASE}/round-${round}/${agent}/${phase}/${file}`;

function generatedArtifact(
  round: number,
  agent: FixtureAgent,
  phase: FixturePhase,
  overrides: Partial<CollaborationGeneratedArtifact> = {},
): CollaborationGeneratedArtifact {
  const id = phase === "final_answer" ? "answer" : "main";
  const file = phase === "final_answer" ? "answer.md" : "main.md";
  return {
    id,
    artifact_type: "main_response",
    path: artifactPath(round, agent, phase, file),
    round,
    agent,
    phase,
    summary: `Full ${phase} response.`,
    ...overrides,
  };
}

function finalAuditArtifact(round = 1): CollaborationGeneratedArtifact {
  return generatedArtifact(round, "agent_one", "final_answer", {
    id: "audit",
    artifact_type: "audit",
    path: artifactPath(round, "agent_one", "final_answer", "audit.md"),
    summary: "Final answer audit.",
  });
}

function makeAgreement(
  overrides: Partial<CollaborationArtifactAgreement> = {},
): CollaborationArtifactAgreement {
  return {
    id: "A-1",
    claim: "Reuse the workflow envelope as the persistence boundary",
    ref: {
      artifact: artifactPath(0, "agent_one", "initial_draft", "main.md"),
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
    proposed_resolution: "Reuse the existing envelope-driven status bus",
    ref: {
      artifact: artifactPath(0, "agent_two", "cross_review", "main.md"),
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
    addresses_disagreement_ids: ["D-impl-1"],
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
    related_disagreement_ids: ["D-obj-1"],
    ...overrides,
  };
}

export function makeResolvedDisagreement(
  overrides: Partial<CollaborationResolvedDisagreement> = {},
): CollaborationResolvedDisagreement {
  return {
    disagreement_id: "D-impl-1",
    resolution: "Use the envelope store with a separate snapshot view",
    resolved_autonomously: true,
    rationale:
      "Major implementation disagreement is within configured threshold",
    ...overrides,
  };
}

export function makeAgentOneInitialDraft(
  overrides: Partial<CollaborationInitialDraftOutput> = {},
): CollaborationInitialDraftOutput {
  const round = overrides.round ?? 0;
  return {
    kind: "initial_draft",
    agent: "agent_one",
    round,
    summary:
      "Agent One proposes reusing the workflow envelope as the source of truth.",
    artifacts: overrides.artifacts ?? [
      generatedArtifact(round, "agent_one", "initial_draft"),
    ],
    assumptions: [
      "Synthesis remains in the conversation transcript.",
      "Pause/resume is driven by the existing envelope state.",
    ],
    key_claims: [
      makeAgreement({
        id: "A-1",
        claim: "Reuse the workflow envelope for state",
      }),
      makeAgreement({
        id: "A-2",
        claim: "Persist artifacts as generated markdown files",
        ref: {
          artifact: artifactPath(0, "agent_one", "initial_draft", "main.md"),
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
  const round = overrides.round ?? 0;
  return {
    kind: "initial_draft",
    agent: "agent_two",
    round,
    summary:
      "Agent Two proposes a dedicated notification table to track delivery.",
    artifacts: overrides.artifacts ?? [
      generatedArtifact(round, "agent_two", "initial_draft"),
    ],
    assumptions: [
      "Notifications must survive process restarts.",
      "A new table simplifies query patterns for the UI.",
    ],
    key_claims: [
      makeAgreement({
        id: "A-1",
        claim: "Persist run state for resumability",
        ref: {
          artifact: artifactPath(0, "agent_two", "initial_draft", "main.md"),
          locator: "#persistence",
        },
      }),
    ],
    ...overrides,
  };
}

export function makeAgentTwoCrossReview(
  overrides: Partial<CollaborationCrossReviewOutput> = {},
): CollaborationCrossReviewOutput {
  const round = overrides.round ?? 0;
  return {
    kind: "cross_review",
    agent: "agent_two",
    target_agent: "agent_one",
    round,
    summary:
      "Agent Two agrees with envelope reuse but flags the notification table tradeoff.",
    artifacts: overrides.artifacts ?? [
      generatedArtifact(round, "agent_two", "cross_review"),
    ],
    agree: [makeAgreement({ id: "A-1" })],
    disagree: [makeImplementationDisagreement()],
    revise_self: [makeReviseSelf()],
    ...overrides,
  };
}

export function makeAgentOneProposedChanges(
  overrides: Partial<CollaborationProposedChangesOutput> = {},
): CollaborationProposedChangesOutput {
  const round = overrides.round ?? 1;
  return {
    kind: "proposed_changes",
    agent: "agent_one",
    target_agent: "agent_two",
    round,
    summary:
      "Agent One incorporates Agent Two's review and proposes envelope-based snapshots.",
    artifacts: overrides.artifacts ?? [
      generatedArtifact(round, "agent_one", "proposed_changes"),
    ],
    accepted_from_other_agent_draft: [
      makeAgreement({
        id: "A-2-from-two",
        claim: "Persist run state for resumability",
      }),
    ],
    proposed_changes: [
      makeChangeProposal({
        id: "PC-1",
        change: "Use the envelope store for progress snapshots",
        addresses_disagreement_ids: ["D-impl-1"],
      }),
    ],
    remaining_disagreements: [makeImplementationDisagreement()],
    ...overrides,
  };
}

export function makeAgentTwoCounterProposalRound1(
  overrides: Partial<CollaborationCounterProposalOutput> = {},
): CollaborationCounterProposalOutput {
  const round = overrides.round ?? 1;
  return {
    kind: "counter_proposal",
    agent: "agent_two",
    target_agent: "agent_one",
    round,
    summary:
      "Agent Two accepts the envelope snapshot but pushes back on collapsing notifications.",
    artifacts: overrides.artifacts ?? [
      generatedArtifact(round, "agent_two", "counter_proposal"),
    ],
    accepted_change_ids: ["PC-1"],
    rejected_change_ids: [],
    alternative_changes: [
      makeChangeProposal({
        id: "AC-1",
        change: "Materialize an envelope-derived notification view",
        rationale:
          "Keeps single source of truth without losing query ergonomics",
        addresses_disagreement_ids: ["D-impl-1"],
      }),
    ],
    agree: [makeAgreement({ id: "A-1" })],
    disagree: [makeImplementationDisagreement()],
    ...overrides,
  };
}

export function makeAgentTwoCounterProposalRound2(
  overrides: Partial<CollaborationCounterProposalOutput> = {},
): CollaborationCounterProposalOutput {
  const round = overrides.round ?? 2;
  return {
    kind: "counter_proposal",
    agent: "agent_two",
    target_agent: "agent_one",
    round,
    summary:
      "Round 2: Agent Two drops the implementation disagreement and surfaces an objective scope concern.",
    artifacts: overrides.artifacts ?? [
      generatedArtifact(round, "agent_two", "counter_proposal"),
    ],
    accepted_change_ids: ["PC-1", "PC-2"],
    rejected_change_ids: [],
    alternative_changes: [],
    agree: [
      makeAgreement({ id: "A-1" }),
      makeAgreement({
        id: "A-3",
        claim: "Envelope-derived view is acceptable",
        ref: {
          artifact: artifactPath(2, "agent_two", "counter_proposal", "main.md"),
          locator: "#view",
        },
      }),
    ],
    disagree: [makeObjectiveDisagreement()],
    ...overrides,
  };
}

export function makeResolutionDecisionFinal(
  overrides: Partial<CollaborationResolutionDecisionOutput> = {},
): CollaborationResolutionDecisionOutput {
  const round = overrides.round ?? 1;
  return {
    kind: "resolution_decision",
    agent: "agent_one",
    target_agent: "agent_two",
    round,
    summary:
      "All disagreements are resolved within the configured autonomous threshold.",
    artifacts: overrides.artifacts ?? [
      generatedArtifact(round, "agent_one", "resolution_decision"),
    ],
    agreement_reached: true,
    next_action: "final",
    accepted_points: [makeAgreement({ id: "A-1" })],
    resolved_disagreements: [
      makeResolvedDisagreement({
        disagreement_id: "D-impl-1",
        resolution: "Adopt envelope-derived notification view (AC-1)",
        resolved_autonomously: true,
      }),
    ],
    remaining_disagreements: [],
    user_questions: [],
    rationale:
      "All disagreements are resolved within the configured autonomous threshold.",
    ...overrides,
  };
}

export function makeResolutionDecisionContinue(
  overrides: Partial<CollaborationResolutionDecisionOutput> = {},
): CollaborationResolutionDecisionOutput {
  const round = overrides.round ?? 1;
  return {
    kind: "resolution_decision",
    agent: "agent_one",
    target_agent: "agent_two",
    round,
    summary: "Implementation disagreement remains; continue negotiation.",
    artifacts: overrides.artifacts ?? [
      generatedArtifact(round, "agent_one", "resolution_decision"),
    ],
    agreement_reached: false,
    next_action: "continue_negotiation",
    accepted_points: [makeAgreement({ id: "A-1" })],
    resolved_disagreements: [],
    remaining_disagreements: [makeImplementationDisagreement()],
    user_questions: [],
    rationale:
      "Implementation disagreement remains; rounds remain so continue negotiation.",
    ...overrides,
  };
}

export function makeResolutionDecisionAskUser(
  overrides: Partial<CollaborationResolutionDecisionOutput> = {},
): CollaborationResolutionDecisionOutput {
  const round = overrides.round ?? 1;
  return {
    kind: "resolution_decision",
    agent: "agent_one",
    target_agent: "agent_two",
    round,
    summary:
      "Objective disagreement requires user clarification before continuing.",
    artifacts: overrides.artifacts ?? [
      generatedArtifact(round, "agent_one", "resolution_decision"),
    ],
    agreement_reached: false,
    next_action: "ask_user",
    accepted_points: [makeAgreement({ id: "A-1" })],
    resolved_disagreements: [],
    remaining_disagreements: [makeObjectiveDisagreement()],
    user_questions: [makeUserQuestion()],
    rationale:
      "Objective disagreement requires user clarification before continuing.",
    ...overrides,
  };
}

export function makeResolutionDecisionFail(
  overrides: Partial<CollaborationResolutionDecisionOutput> = {},
): CollaborationResolutionDecisionOutput {
  const round = overrides.round ?? 1;
  return {
    kind: "resolution_decision",
    agent: "agent_one",
    target_agent: "agent_two",
    round,
    summary: "Blocking disagreement cannot be resolved.",
    artifacts: overrides.artifacts ?? [
      generatedArtifact(round, "agent_one", "resolution_decision"),
    ],
    agreement_reached: false,
    next_action: "fail",
    accepted_points: [],
    resolved_disagreements: [],
    remaining_disagreements: [makeBlockingImplementationDisagreement()],
    user_questions: [],
    rationale:
      "Blocking disagreement cannot be resolved under the configured threshold.",
    ...overrides,
  };
}

export function makeOpenConflicts(
  overrides: Partial<CollaborationOpenConflictsOutput> = {},
): CollaborationOpenConflictsOutput {
  return {
    kind: "open_conflicts",
    round: 1,
    summary: "Objective disagreement requires user attention.",
    disagreements: [makeObjectiveDisagreement()],
    questions: [makeUserQuestion()],
    ...overrides,
  };
}

export function makeFinalAnswer(
  overrides: Partial<CollaborationFinalAnswerOutput> = {},
): CollaborationFinalAnswerOutput {
  const round = overrides.round ?? 1;
  return {
    kind: "final_answer",
    agent: "agent_one",
    round,
    summary:
      "Reuse the workflow envelope as the source of truth and expose an envelope-derived notification view.",
    artifacts: overrides.artifacts ?? [
      generatedArtifact(round, "agent_one", "final_answer", {
        id: "answer",
        path: artifactPath(round, "agent_one", "final_answer", "answer.md"),
        summary: "Final answer.",
      }),
      finalAuditArtifact(round),
    ],
    answer_artifact_id: "answer",
    audit_artifact_id: "audit",
    ...overrides,
  };
}

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
