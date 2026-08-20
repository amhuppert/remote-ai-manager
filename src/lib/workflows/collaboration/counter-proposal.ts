/**
 * Negotiation-round step: Agent Two's `counter_proposal`.
 *
 * Agent Two sees both initial drafts, its own earlier cross-review, and Agent
 * One's `proposed_changes` from the current round, and emits a counter-proposal
 * that becomes the input for Agent One's `resolution_decision`.
 */

import { buildAgentTwoCounterProposalPrompt } from "./prompt-builders";
import {
  collaborationCounterProposalContentSchema,
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
  produceCollaborationStep,
  trackArtifact,
  type ArtifactTracker,
} from "./helpers";
import type { CollaborationStepLedger } from "./step-ledger";

export interface RunCounterProposalStepContext {
  input: AsymmetricCollaborationSliceInput;
  deps: AsymmetricCollaborationSliceDeps;
  now: () => string;
  tracker: ArtifactTracker;
  /** The prior attempt's recorded outputs; null for a run with no history. */
  ledger: CollaborationStepLedger | null;
  backendForAgent: (agent: CollaborationFlowAgent) => CollaborationAgent;
  agentOneDraft: CollaborationInitialDraftOutput;
  agentTwoDraft: CollaborationInitialDraftOutput;
  crossReview: CollaborationCrossReviewOutput;
  proposedChanges: CollaborationProposedChangesOutput;
  round: number;
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
    round,
  } = ctx;

  const counterProposalPrompt = buildAgentTwoCounterProposalPrompt({
    userPrompt: input.brief,
    ownDraft: agentTwoDraft,
    otherDraft: agentOneDraft,
    ownCrossReview: crossReview,
    proposedChanges,
    workflowId: input.workflowId,
    round,
  });
  const step =
    await produceCollaborationStep<CollaborationCounterProposalOutput>({
      input,
      deps,
      ledger: ctx.ledger,
      key: { kind: "counter_proposal", round },
      flowAgent: "agent_two",
      backend: backendForAgent("agent_two"),
      prompt: counterProposalPrompt,
      contentSchema: collaborationCounterProposalContentSchema,
      fullSchema: collaborationCounterProposalOutputSchema,
      injection: {
        kind: "counter_proposal",
        agent: "agent_two",
        target_agent: "agent_one",
        round,
      },
    });
  if (step.kind === "failed") {
    return {
      kind: "failed",
      result: await failRun({
        input,
        deps,
        now,
        tracker,
        flowAgent: "agent_two",
        errorSummary: step.errorSummary,
        cause: step.cause,
      }),
    };
  }
  if (step.kind === "replayed") {
    return { kind: "ok", counterProposal: step.artifact };
  }

  await trackArtifact(tracker, step.artifact);
  await persistArtifactsSnapshot(input, deps, now, tracker);

  return { kind: "ok", counterProposal: step.artifact };
}
