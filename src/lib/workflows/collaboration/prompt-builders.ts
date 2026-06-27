/**
 * Phase-specific prompt builders for the asymmetric Collaboration Mode flow.
 *
 * Each builder is a pure function that returns the prompt string and the
 * matching JSON Schema constant the caller wires into
 * `AgentCallRequest.outputSchema`. Builders include only the role-appropriate
 * context described in `memory-bank/COLLABORATION_MODE_FLOW.md`:
 *
 *  - Initial drafts see only the user prompt.
 *  - Agent One's proposed changes (its review of Agent Two's draft) sees both
 *    drafts but NOT Agent Two's cross-review — that review is incorporated by
 *    Agent Two into its counter-proposal (message 5 → message 6 in the flow).
 *  - Agent Two's cross-review sees both drafts and is saved to the output zone
 *    only.
 *  - Agent Two's counter-proposal sees both drafts, its own cross-review, and
 *    Agent One's proposed changes.
 *  - Agent One's resolution decision sees the prior context plus the LATEST
 *    counter-proposal for the round being resolved (regression boundary).
 *  - Agent One's final answer sees prior artifacts and any user clarifications
 *    that resolved open conflicts. The agent is NOT asked to author a separate
 *    resolution audit section inside the answer body.
 */
import type {
  CollaborationArtifact,
  CollaborationCounterProposalOutput,
  CollaborationCrossReviewOutput,
  CollaborationInitialDraftOutput,
  CollaborationOpenConflictsOutput,
  CollaborationProposedChangesOutput,
  CollaborationResolutionDecisionOutput,
} from "./types";
import {
  COLLABORATION_COUNTER_PROPOSAL_OUTPUT_SCHEMA,
  COLLABORATION_CROSS_REVIEW_OUTPUT_SCHEMA,
  COLLABORATION_FINAL_ANSWER_OUTPUT_SCHEMA,
  COLLABORATION_INITIAL_DRAFT_OUTPUT_SCHEMA,
  COLLABORATION_PROPOSED_CHANGES_OUTPUT_SCHEMA,
  COLLABORATION_RESOLUTION_DECISION_OUTPUT_SCHEMA,
} from "./types";
import {
  requiredArtifactFileRefs,
  type CollaborationArtifactFileContext,
} from "./artifact-files";

export interface BuiltCollaborationPrompt {
  prompt: string;
  outputSchema: Record<string, unknown>;
}

interface InitialDraftInput {
  userPrompt: string;
  workflowId: string;
}

interface CrossReviewInput {
  userPrompt: string;
  ownDraft: CollaborationInitialDraftOutput;
  otherDraft: CollaborationInitialDraftOutput;
  workflowId: string;
  round: number;
}

interface CounterProposalInput {
  userPrompt: string;
  ownDraft: CollaborationInitialDraftOutput;
  otherDraft: CollaborationInitialDraftOutput;
  ownCrossReview: CollaborationCrossReviewOutput;
  proposedChanges: CollaborationProposedChangesOutput;
  workflowId: string;
  round: number;
}

interface ResolutionDecisionInput {
  userPrompt: string;
  ownDraft: CollaborationInitialDraftOutput;
  otherDraft: CollaborationInitialDraftOutput;
  proposedChanges: CollaborationProposedChangesOutput;
  latestCounterProposal: CollaborationCounterProposalOutput;
  negotiationRound: number;
  workflowId: string;
}

interface CollaborationUserAnswer {
  questionId: string;
  question: string;
  answer: string;
}

interface FinalAnswerInput {
  userPrompt: string;
  ownDraft: CollaborationInitialDraftOutput;
  otherDraft: CollaborationInitialDraftOutput;
  latestCounterProposal: CollaborationCounterProposalOutput;
  latestResolutionDecision: CollaborationResolutionDecisionOutput;
  workflowId: string;
  round: number;
  artifactStream?: CollaborationArtifact[];
  openConflicts?: CollaborationOpenConflictsOutput;
  userAnswers?: CollaborationUserAnswer[];
}

// Every phase prompt ends with the structured-output reminder. The
// collaboration agent caller runs schema-bearing calls in two turns: a prose
// work turn where this reminder is swapped for COLLABORATION_PROSE_TURN_INSTRUCTION
// so the agent reasons freely, then a format turn driven by
// COLLABORATION_FORMAT_TURN_INSTRUCTION that restates the answer as JSON under
// schema enforcement. Single-call consumers (the graph-scoped collaborator)
// keep this reminder verbatim.
export const COLLABORATION_STRUCTURED_OUTPUT_REMINDER =
  "Return only the structured JSON object that matches the supplied JSON Schema. Substantive content must already be written to the required generated artifact files; the JSON object must contain only short summaries, decisions, ids, and file references. Do not include prose outside the object.";

export const COLLABORATION_PROSE_TURN_INSTRUCTION =
  "Complete the phase work in prose and write the required generated artifact file(s) exactly as instructed above. Do not emit JSON yet; a follow-up message will ask you to produce the small structured manifest.";

export const COLLABORATION_FORMAT_TURN_INSTRUCTION =
  "Convert your previous response into a single JSON object that conforms to the required output schema. Return only the small structured manifest: short summaries, decisions, ids, and references to generated artifact files. Do not restate full details and do not copy generated file contents into JSON. Output only the JSON object, with no prose outside it.";

function joinLines(...lines: Array<string | string[]>): string {
  return lines
    .flat()
    .filter((line) => line !== undefined && line !== null)
    .join("\n");
}

function summarizeAgreements(
  agreements: ReadonlyArray<{ id: string; claim: string }>,
): string[] {
  if (agreements.length === 0) return ["(none)"];
  return agreements.map((a) => `- ${a.id}: ${a.claim}`);
}

function summarizeDisagreements(
  disagreements: ReadonlyArray<{
    id: string;
    category: string;
    severity: string;
    claim: string;
    reason: string;
  }>,
): string[] {
  if (disagreements.length === 0) return ["(none)"];
  return disagreements.map(
    (d) => `- ${d.id} [${d.category}/${d.severity}]: ${d.claim} — ${d.reason}`,
  );
}

function summarizeChangeProposals(
  changes: ReadonlyArray<{
    id: string;
    change: string;
    rationale: string;
    addresses_disagreement_ids: string[];
  }>,
): string[] {
  if (changes.length === 0) return ["(none)"];
  return changes.map(
    (c) =>
      `- ${c.id}: ${c.change} (rationale: ${c.rationale}; addresses: ${
        c.addresses_disagreement_ids.join(", ") || "—"
      })`,
  );
}

function artifactSummaryLines(
  artifact: ReadonlyArray<{
    id: string;
    artifact_type: string;
    path: string;
    summary: string;
  }>,
): string[] {
  if (artifact.length === 0) return ["(none)"];
  return artifact.map(
    (ref) => `- ${ref.id} [${ref.artifact_type}]: ${ref.path} — ${ref.summary}`,
  );
}

function draftSection(
  label: string,
  draft: CollaborationInitialDraftOutput,
): string[] {
  return [
    `--- ${label} (agent=${draft.agent}) ---`,
    `round: ${draft.round}`,
    `summary: ${draft.summary}`,
    `generated artifacts:`,
    ...artifactSummaryLines(draft.artifacts),
    `assumptions:`,
    ...(draft.assumptions.length > 0
      ? draft.assumptions.map((a) => `- ${a}`)
      : ["(none)"]),
    `key claims:`,
    ...summarizeAgreements(draft.key_claims),
  ];
}

function artifactProtocolSection(
  context: CollaborationArtifactFileContext,
): string[] {
  const refs = requiredArtifactFileRefs(context);
  return [
    `--- generated artifact files ---`,
    `Before returning structured output, create these markdown file(s) relative to the repository worktree:`,
    ...refs.map(
      (ref) =>
        `- id=${ref.id}, artifact_type=${ref.artifact_type}, path=${ref.path}`,
    ),
    `Create parent directories if needed. These file(s) are mandatory and must contain the full substantive ${context.phase} response.`,
    `The structured JSON must include matching entries in artifacts and must keep inline text short. Do not copy file contents into JSON.`,
  ];
}

function artifactLedgerSection(
  artifacts: ReadonlyArray<CollaborationArtifact>,
): string[] {
  if (artifacts.length === 0) return [];

  const lines = [
    `--- complete artifact stream before final answer ---`,
    `Use these artifacts in order when synthesizing the final answer. Preserve the final answer as user-facing prose; the UI renders this stream as the collapsed audit.`,
  ];

  artifacts.forEach((artifact, index) => {
    const prefix = `${index + 1}. ${artifact.kind}`;
    switch (artifact.kind) {
      case "initial_draft":
        lines.push(
          `${prefix} (agent=${artifact.agent})`,
          `round: ${artifact.round}`,
          `summary: ${artifact.summary}`,
          `generated artifacts:`,
          ...artifactSummaryLines(artifact.artifacts),
        );
        break;
      case "cross_review":
        lines.push(
          `${prefix} (agent=${artifact.agent}, target=${artifact.target_agent}, round=${artifact.round})`,
          `summary: ${artifact.summary}`,
          `generated artifacts:`,
          ...artifactSummaryLines(artifact.artifacts),
          `disagreements:`,
          ...summarizeDisagreements(artifact.disagree),
        );
        break;
      case "proposed_changes":
        lines.push(
          `${prefix} (agent=${artifact.agent}, target=${artifact.target_agent}, round=${artifact.round})`,
          `summary: ${artifact.summary}`,
          `generated artifacts:`,
          ...artifactSummaryLines(artifact.artifacts),
          `proposed changes:`,
          ...summarizeChangeProposals(artifact.proposed_changes),
          `remaining disagreements:`,
          ...summarizeDisagreements(artifact.remaining_disagreements),
        );
        break;
      case "counter_proposal":
        lines.push(
          `${prefix} (agent=${artifact.agent}, target=${artifact.target_agent}, round=${artifact.round})`,
          `summary: ${artifact.summary}`,
          `generated artifacts:`,
          ...artifactSummaryLines(artifact.artifacts),
          `alternative changes:`,
          ...summarizeChangeProposals(artifact.alternative_changes),
          `remaining disagreements:`,
          ...summarizeDisagreements(artifact.disagree),
        );
        break;
      case "resolution_decision":
        lines.push(
          `${prefix} (agent=${artifact.agent}, target=${artifact.target_agent}, round=${artifact.round})`,
          `summary: ${artifact.summary}`,
          `generated artifacts:`,
          ...artifactSummaryLines(artifact.artifacts),
          `next_action: ${artifact.next_action}`,
          `agreement_reached: ${artifact.agreement_reached}`,
          `rationale: ${artifact.rationale}`,
          `remaining disagreements:`,
          ...summarizeDisagreements(artifact.remaining_disagreements),
        );
        break;
      case "open_conflicts":
        lines.push(
          `${prefix} (round=${artifact.round})`,
          `summary: ${artifact.summary}`,
          `disagreements:`,
          ...summarizeDisagreements(artifact.disagreements),
          `questions asked:`,
          ...artifact.questions.map((q) => `- ${q.id}: ${q.question}`),
        );
        break;
      case "final_answer":
        lines.push(
          `${prefix} (agent=${artifact.agent}, round=${artifact.round})`,
          `summary: ${artifact.summary}`,
          `generated artifacts:`,
          ...artifactSummaryLines(artifact.artifacts),
        );
        break;
    }
  });

  return lines;
}

export function buildAgentOneInitialDraftPrompt(
  input: InitialDraftInput,
): BuiltCollaborationPrompt {
  const prompt = joinLines(
    `You are agent_one (the Primary) in a Collaboration Mode run.`,
    `Phase: Initial Draft.`,
    ``,
    `User prompt:`,
    input.userPrompt,
    ``,
    `Produce your initial draft of an answer to the user prompt. You are drafting in parallel with agent_two; you have not seen agent_two's draft yet.`,
    ``,
    artifactProtocolSection({
      workflowId: input.workflowId,
      round: 0,
      agent: "agent_one",
      phase: "initial_draft",
    }),
    ``,
    COLLABORATION_STRUCTURED_OUTPUT_REMINDER,
  );
  return {
    prompt,
    outputSchema:
      COLLABORATION_INITIAL_DRAFT_OUTPUT_SCHEMA as unknown as Record<
        string,
        unknown
      >,
  };
}

export function buildAgentTwoInitialDraftPrompt(
  input: InitialDraftInput,
): BuiltCollaborationPrompt {
  const prompt = joinLines(
    `You are agent_two in a Collaboration Mode run.`,
    `Phase: Initial Draft.`,
    ``,
    `User prompt:`,
    input.userPrompt,
    ``,
    `Produce your initial draft of an answer to the user prompt. You are drafting in parallel with agent_one; you have not seen agent_one's draft yet.`,
    ``,
    artifactProtocolSection({
      workflowId: input.workflowId,
      round: 0,
      agent: "agent_two",
      phase: "initial_draft",
    }),
    ``,
    COLLABORATION_STRUCTURED_OUTPUT_REMINDER,
  );
  return {
    prompt,
    outputSchema:
      COLLABORATION_INITIAL_DRAFT_OUTPUT_SCHEMA as unknown as Record<
        string,
        unknown
      >,
  };
}

export function buildAgentOneProposedChangesPrompt(
  input: CrossReviewInput,
): BuiltCollaborationPrompt {
  const prompt = joinLines(
    `You are agent_one (the Primary) in a Collaboration Mode run.`,
    `Phase: Cross-Review (your output is "proposed_changes" to agent_two).`,
    ``,
    `User prompt:`,
    input.userPrompt,
    ``,
    draftSection("your initial draft", input.ownDraft),
    ``,
    draftSection("agent_two initial draft", input.otherDraft),
    ``,
    `Read agent_two's draft. Identify points you accept (accepted_from_other_agent_draft), formulate concrete proposed changes (proposed_changes) that address gaps or disagreements, and list any disagreements you still hold (remaining_disagreements) with category and severity.`,
    ``,
    artifactProtocolSection({
      workflowId: input.workflowId,
      round: input.round,
      agent: "agent_one",
      phase: "proposed_changes",
    }),
    ``,
    COLLABORATION_STRUCTURED_OUTPUT_REMINDER,
  );
  return {
    prompt,
    outputSchema:
      COLLABORATION_PROPOSED_CHANGES_OUTPUT_SCHEMA as unknown as Record<
        string,
        unknown
      >,
  };
}

export function buildAgentTwoCrossReviewPrompt(
  input: CrossReviewInput,
): BuiltCollaborationPrompt {
  const prompt = joinLines(
    `You are agent_two in a Collaboration Mode run.`,
    `Phase: Cross-Review.`,
    `Your cross-review is shown in the output zone for the user. It is NOT delivered to agent_one as a standalone negotiation message — you will incorporate it into your counter-proposal in the next step.`,
    ``,
    `User prompt:`,
    input.userPrompt,
    ``,
    draftSection("your initial draft", input.ownDraft),
    ``,
    draftSection("agent_one initial draft", input.otherDraft),
    ``,
    `Produce a structured cross-review of agent_one's draft. Categorize each disagreement as objective or implementation and assign a severity (minor, major, blocking). Include any revise_self items you would change in your own draft based on what you learned.`,
    ``,
    artifactProtocolSection({
      workflowId: input.workflowId,
      round: 0,
      agent: "agent_two",
      phase: "cross_review",
    }),
    ``,
    COLLABORATION_STRUCTURED_OUTPUT_REMINDER,
  );
  return {
    prompt,
    outputSchema: COLLABORATION_CROSS_REVIEW_OUTPUT_SCHEMA as unknown as Record<
      string,
      unknown
    >,
  };
}

export function buildAgentTwoCounterProposalPrompt(
  input: CounterProposalInput,
): BuiltCollaborationPrompt {
  const prompt = joinLines(
    `You are agent_two in a Collaboration Mode run.`,
    `Phase: Negotiation — produce your counter-proposal.`,
    `Incorporate your prior cross-review of agent_one's draft into this counter-proposal. The cross-review is not delivered to agent_one separately, so any review points you still hold must appear here.`,
    ``,
    `User prompt:`,
    input.userPrompt,
    ``,
    draftSection("your initial draft", input.ownDraft),
    ``,
    draftSection("agent_one initial draft", input.otherDraft),
    ``,
    `--- your cross-review of agent_one's draft ---`,
    `summary: ${input.ownCrossReview.summary}`,
    `generated artifacts:`,
    ...artifactSummaryLines(input.ownCrossReview.artifacts),
    `disagree:`,
    ...summarizeDisagreements(input.ownCrossReview.disagree),
    ``,
    `--- agent_one proposed changes ---`,
    `summary: ${input.proposedChanges.summary}`,
    `generated artifacts:`,
    ...artifactSummaryLines(input.proposedChanges.artifacts),
    `proposed changes:`,
    ...summarizeChangeProposals(input.proposedChanges.proposed_changes),
    `agent_one remaining disagreements:`,
    ...summarizeDisagreements(input.proposedChanges.remaining_disagreements),
    ``,
    `Decide which proposed change ids you accept and which you reject (by id). Offer alternative changes only when needed. Restate any remaining agreements (agree) and disagreements (disagree) — including the points from your cross-review you still hold — with category and severity.`,
    ``,
    artifactProtocolSection({
      workflowId: input.workflowId,
      round: input.round,
      agent: "agent_two",
      phase: "counter_proposal",
    }),
    ``,
    COLLABORATION_STRUCTURED_OUTPUT_REMINDER,
  );
  return {
    prompt,
    outputSchema:
      COLLABORATION_COUNTER_PROPOSAL_OUTPUT_SCHEMA as unknown as Record<
        string,
        unknown
      >,
  };
}

export function buildAgentOneResolutionDecisionPrompt(
  input: ResolutionDecisionInput,
): BuiltCollaborationPrompt {
  const counter = input.latestCounterProposal;
  const prompt = joinLines(
    `You are agent_one (the Primary) in a Collaboration Mode run.`,
    `Phase: Resolution Decision for negotiation round ${input.negotiationRound}.`,
    `You are the authoritative resolver. Your decision must be based on the LATEST counter-proposal from agent_two for this round, not any earlier round.`,
    ``,
    `User prompt:`,
    input.userPrompt,
    ``,
    draftSection("your initial draft", input.ownDraft),
    ``,
    draftSection("agent_two initial draft", input.otherDraft),
    ``,
    `--- your proposed changes (round ${input.negotiationRound}) ---`,
    `summary: ${input.proposedChanges.summary}`,
    `generated artifacts:`,
    ...artifactSummaryLines(input.proposedChanges.artifacts),
    `proposed changes:`,
    ...summarizeChangeProposals(input.proposedChanges.proposed_changes),
    `your remaining disagreements:`,
    ...summarizeDisagreements(input.proposedChanges.remaining_disagreements),
    ``,
    `--- agent_two latest counter-proposal (round ${input.negotiationRound}) ---`,
    `summary: ${counter.summary}`,
    `generated artifacts:`,
    ...artifactSummaryLines(counter.artifacts),
    `accepted_change_ids: ${counter.accepted_change_ids.join(", ") || "(none)"}`,
    `rejected_change_ids: ${counter.rejected_change_ids.join(", ") || "(none)"}`,
    `alternative changes:`,
    ...summarizeChangeProposals(counter.alternative_changes),
    `agent_two agreements:`,
    ...summarizeAgreements(counter.agree),
    `agent_two remaining disagreements:`,
    ...summarizeDisagreements(counter.disagree),
    ``,
    `Choose next_action: "final" if agreement is reached, "continue_negotiation" if implementation disagreements remain and rounds remain, "ask_user" if objective disagreements remain or remaining implementation disagreements exceed the autonomous threshold, or "fail" if the run cannot proceed. Populate resolved_disagreements with autonomous resolutions you take and user_questions for any clarification you need from the user.`,
    ``,
    artifactProtocolSection({
      workflowId: input.workflowId,
      round: input.negotiationRound,
      agent: "agent_one",
      phase: "resolution_decision",
    }),
    ``,
    COLLABORATION_STRUCTURED_OUTPUT_REMINDER,
  );
  return {
    prompt,
    outputSchema:
      COLLABORATION_RESOLUTION_DECISION_OUTPUT_SCHEMA as unknown as Record<
        string,
        unknown
      >,
  };
}

export function buildAgentOneFinalAnswerPrompt(
  input: FinalAnswerInput,
): BuiltCollaborationPrompt {
  const sections: string[] = [
    `You are agent_one (the Primary) in a Collaboration Mode run.`,
    `Phase: Final Answer.`,
    `Write the final answer for the user into the required answer.md file. Write a concise audit of how the negotiation resolved into audit.md. Resolution details remain metadata in the artifact stream and the UI exposes them separately.`,
    ``,
    `User prompt:`,
    input.userPrompt,
    ``,
    ...draftSection("your initial draft", input.ownDraft),
    ``,
    ...draftSection("agent_two initial draft", input.otherDraft),
    ``,
    ...(input.artifactStream && input.artifactStream.length > 0
      ? [...artifactLedgerSection(input.artifactStream), ``]
      : []),
    `--- agent_two latest counter-proposal ---`,
    `summary: ${input.latestCounterProposal.summary}`,
    `generated artifacts:`,
    ...artifactSummaryLines(input.latestCounterProposal.artifacts),
    ``,
    `--- your latest resolution decision ---`,
    `next_action: ${input.latestResolutionDecision.next_action}`,
    `agreement_reached: ${input.latestResolutionDecision.agreement_reached}`,
    `rationale: ${input.latestResolutionDecision.rationale}`,
    `resolved disagreements:`,
    ...(input.latestResolutionDecision.resolved_disagreements.length > 0
      ? input.latestResolutionDecision.resolved_disagreements.map(
          (r) =>
            `- ${r.disagreement_id}: ${r.resolution} (auto=${r.resolved_autonomously}; ${r.rationale})`,
        )
      : ["(none)"]),
  ];

  if (input.openConflicts) {
    sections.push(
      ``,
      `--- open conflicts surfaced to the user ---`,
      `disagreements:`,
      ...summarizeDisagreements(input.openConflicts.disagreements),
      `questions asked:`,
      ...input.openConflicts.questions.map((q) => `- ${q.id}: ${q.question}`),
    );
  }

  if (input.userAnswers && input.userAnswers.length > 0) {
    sections.push(``, `--- user clarifications ---`);
    for (const answer of input.userAnswers) {
      sections.push(
        `Q (${answer.questionId}): ${answer.question}`,
        `A: ${answer.answer}`,
      );
    }
    sections.push(
      ``,
      `Use these clarifications to settle outstanding disagreements when forming the final answer.`,
    );
  }

  sections.push(
    ``,
    ...artifactProtocolSection({
      workflowId: input.workflowId,
      round: input.round,
      agent: "agent_one",
      phase: "final_answer",
    }),
    ``,
    `Set answer_artifact_id to "answer" and audit_artifact_id to "audit". The structured JSON must not contain the final answer body or audit body.`,
    ``,
    COLLABORATION_STRUCTURED_OUTPUT_REMINDER,
  );

  return {
    prompt: sections.join("\n"),
    outputSchema: COLLABORATION_FINAL_ANSWER_OUTPUT_SCHEMA as unknown as Record<
      string,
      unknown
    >,
  };
}
