/**
 * Negotiation-round step: Agent Two's `counter_proposal`.
 *
 * Agent Two sees both initial drafts, its own earlier cross-review, and Agent
 * One's `proposed_changes` from the current round, and emits a counter-proposal
 * that becomes the input for Agent One's `resolution_decision`.
 */

import { buildAgentTwoCounterProposalPrompt } from "./prompt-builders";
import {
  collaborationCounterProposalOutputSchema,
  type CollaborationAgent,
  type CollaborationCounterProposalOutput,
  type CollaborationCrossReviewOutput,
  type CollaborationFlowAgent,
  type CollaborationInitialDraftOutput,
  type CollaborationProposedChangesOutput,
} from "./types";
import {
  failRun,
  persistArtifactsSnapshot,
  type AsymmetricCollaborationSliceDeps,
  type AsymmetricCollaborationSliceInput,
  type AsymmetricCollaborationSliceResult,
} from "./envelope";
import {
  callPrimitive,
  parseStructured,
  trackArtifact,
  type ArtifactTracker,
} from "./helpers";

export interface RunCounterProposalStepContext {
  input: AsymmetricCollaborationSliceInput;
  deps: AsymmetricCollaborationSliceDeps;
  now: () => string;
  tracker: ArtifactTracker;
  backendForAgent: (agent: CollaborationFlowAgent) => CollaborationAgent;
  agentOneDraft: CollaborationInitialDraftOutput;
  agentTwoDraft: CollaborationInitialDraftOutput;
  crossReview: CollaborationCrossReviewOutput;
  proposedChanges: CollaborationProposedChangesOutput;
}

export type RunCounterProposalStepOutcome =
  | { kind: "ok"; counterProposal: CollaborationCounterProposalOutput }
  | {
      kind: "failed";
      result: Extract<AsymmetricCollaborationSliceResult, { kind: "failed" }>;
    };

export async function runCounterProposalStep(
  ctx: RunCounterProposalStepContext,
): Promise<RunCounterProposalStepOutcome> {
  const {
    input,
    deps,
    now,
    tracker,
    backendForAgent,
    agentOneDraft,
    agentTwoDraft,
    crossReview,
    proposedChanges,
  } = ctx;

  const counterProposalPrompt = buildAgentTwoCounterProposalPrompt({
    userPrompt: input.brief,
    ownDraft: agentTwoDraft,
    otherDraft: agentOneDraft,
    ownCrossReview: crossReview,
    proposedChanges,
  });
  const counterProposalCall = await callPrimitive({
    input,
    deps,
    flowAgent: "agent_two",
    backend: backendForAgent("agent_two"),
    prompt: counterProposalPrompt,
  });
  if (counterProposalCall.kind === "failed") {
    return {
      kind: "failed",
      result: await failRun({
        input,
        deps,
        now,
        tracker,
        flowAgent: "agent_two",
        errorSummary: counterProposalCall.errorSummary,
      }),
    };
  }
  const counterProposal = parseStructured(
    "counter_proposal",
    "agent_two",
    counterProposalCall.result,
    collaborationCounterProposalOutputSchema,
  );
  if (!counterProposal.success) {
    return {
      kind: "failed",
      result: await failRun({
        input,
        deps,
        now,
        tracker,
        flowAgent: "agent_two",
        errorSummary: counterProposal.error,
      }),
    };
  }
  trackArtifact(tracker, counterProposal.value);
  await persistArtifactsSnapshot(input, deps, now, tracker);

  return { kind: "ok", counterProposal: counterProposal.value };
}
