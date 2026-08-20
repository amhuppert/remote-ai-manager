/**
 * Negotiation-round steps owned by Agent One: `proposed_changes` and
 * `resolution_decision`.
 *
 * `proposed_changes` runs first in a round — Agent One sees both initial
 * drafts but NOT Agent Two's cross-review. `resolution_decision` runs last
 * and must read the LATEST counter-proposal of the current round, never an
 * earlier round's, so each round's decision reflects the most recent
 * negotiation state.
 */

import {
  buildAgentOneProposedChangesPrompt,
  buildAgentOneResolutionDecisionPrompt,
} from "./prompt-builders";
import {
  collaborationProposedChangesContentSchema,
  collaborationProposedChangesOutputSchema,
  collaborationResolutionDecisionContentSchema,
  collaborationResolutionDecisionOutputSchema,
  type CollaborationAgent,
  type CollaborationCounterProposalOutput,
  type CollaborationFlowAgent,
  type CollaborationInitialDraftOutput,
  type CollaborationProposedChangesOutput,
  type CollaborationResolutionDecisionOutput,
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

export interface RunProposedChangesStepContext {
  input: AsymmetricCollaborationSliceInput;
  deps: AsymmetricCollaborationSliceDeps;
  now: () => string;
  tracker: ArtifactTracker;
  /** The prior attempt's recorded outputs; null for a run with no history. */
  ledger: CollaborationStepLedger | null;
  backendForAgent: (agent: CollaborationFlowAgent) => CollaborationAgent;
  agentOneDraft: CollaborationInitialDraftOutput;
  agentTwoDraft: CollaborationInitialDraftOutput;
  round: number;
}

export type RunProposedChangesStepOutcome =
  | { kind: "ok"; proposedChanges: CollaborationProposedChangesOutput }
  | {
      kind: "failed";
      result: Extract<AsymmetricCollaborationSliceResult, { kind: "failed" }>;
    };

export async function runProposedChangesStep(
  ctx: RunProposedChangesStepContext,
): Promise<RunProposedChangesStepOutcome> {
  const {
    input,
    deps,
    now,
    tracker,
    backendForAgent,
    agentOneDraft,
    agentTwoDraft,
    round,
  } = ctx;

  const proposedChangesPrompt = buildAgentOneProposedChangesPrompt({
    userPrompt: input.brief,
    ownDraft: agentOneDraft,
    otherDraft: agentTwoDraft,
    workflowId: input.workflowId,
    round,
  });
  const step =
    await produceCollaborationStep<CollaborationProposedChangesOutput>({
      input,
      deps,
      ledger: ctx.ledger,
      key: { kind: "proposed_changes", round },
      flowAgent: "agent_one",
      backend: backendForAgent("agent_one"),
      prompt: proposedChangesPrompt,
      contentSchema: collaborationProposedChangesContentSchema,
      fullSchema: collaborationProposedChangesOutputSchema,
      injection: {
        kind: "proposed_changes",
        agent: "agent_one",
        target_agent: "agent_two",
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
        flowAgent: "agent_one",
        errorSummary: step.errorSummary,
        cause: step.cause,
      }),
    };
  }
  if (step.kind === "replayed") {
    return { kind: "ok", proposedChanges: step.artifact };
  }

  await trackArtifact(tracker, step.artifact);
  await persistArtifactsSnapshot(input, deps, now, tracker);

  return { kind: "ok", proposedChanges: step.artifact };
}

export interface RunResolutionDecisionStepContext {
  input: AsymmetricCollaborationSliceInput;
  deps: AsymmetricCollaborationSliceDeps;
  now: () => string;
  tracker: ArtifactTracker;
  /** The prior attempt's recorded outputs; null for a run with no history. */
  ledger: CollaborationStepLedger | null;
  backendForAgent: (agent: CollaborationFlowAgent) => CollaborationAgent;
  agentOneDraft: CollaborationInitialDraftOutput;
  agentTwoDraft: CollaborationInitialDraftOutput;
  proposedChanges: CollaborationProposedChangesOutput;
  counterProposal: CollaborationCounterProposalOutput;
  round: number;
}

export type RunResolutionDecisionStepOutcome =
  | { kind: "ok"; resolution: CollaborationResolutionDecisionOutput }
  | {
      kind: "failed";
      result: Extract<AsymmetricCollaborationSliceResult, { kind: "failed" }>;
    };

export async function runResolutionDecisionStep(
  ctx: RunResolutionDecisionStepContext,
): Promise<RunResolutionDecisionStepOutcome> {
  const {
    input,
    deps,
    now,
    tracker,
    backendForAgent,
    agentOneDraft,
    agentTwoDraft,
    proposedChanges,
    counterProposal,
    round,
  } = ctx;

  const resolutionPrompt = buildAgentOneResolutionDecisionPrompt({
    userPrompt: input.brief,
    ownDraft: agentOneDraft,
    otherDraft: agentTwoDraft,
    proposedChanges,
    latestCounterProposal: counterProposal,
    negotiationRound: round,
    workflowId: input.workflowId,
  });
  const step =
    await produceCollaborationStep<CollaborationResolutionDecisionOutput>({
      input,
      deps,
      ledger: ctx.ledger,
      key: { kind: "resolution_decision", round },
      flowAgent: "agent_one",
      backend: backendForAgent("agent_one"),
      prompt: resolutionPrompt,
      contentSchema: collaborationResolutionDecisionContentSchema,
      fullSchema: collaborationResolutionDecisionOutputSchema,
      injection: {
        kind: "resolution_decision",
        agent: "agent_one",
        target_agent: "agent_two",
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
        flowAgent: "agent_one",
        errorSummary: step.errorSummary,
        cause: step.cause,
      }),
    };
  }
  if (step.kind === "replayed") {
    tracker.negotiationRoundsCompleted = round;
    return { kind: "ok", resolution: step.artifact };
  }

  await trackArtifact(tracker, step.artifact);
  await persistArtifactsSnapshot(input, deps, now, tracker);

  return { kind: "ok", resolution: step.artifact };
}
