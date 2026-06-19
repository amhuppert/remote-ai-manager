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
  collaborationProposedChangesOutputSchema,
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
  callPrimitive,
  parseStructured,
  trackArtifact,
  type ArtifactTracker,
} from "./helpers";

export interface RunProposedChangesStepContext {
  input: AsymmetricCollaborationSliceInput;
  deps: AsymmetricCollaborationSliceDeps;
  now: () => string;
  tracker: ArtifactTracker;
  backendForAgent: (agent: CollaborationFlowAgent) => CollaborationAgent;
  agentOneDraft: CollaborationInitialDraftOutput;
  agentTwoDraft: CollaborationInitialDraftOutput;
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
  } = ctx;

  const proposedChangesPrompt = buildAgentOneProposedChangesPrompt({
    userPrompt: input.brief,
    ownDraft: agentOneDraft,
    otherDraft: agentTwoDraft,
  });
  const proposedChangesCall = await callPrimitive({
    input,
    deps,
    flowAgent: "agent_one",
    backend: backendForAgent("agent_one"),
    prompt: proposedChangesPrompt,
  });
  if (proposedChangesCall.kind === "failed") {
    return {
      kind: "failed",
      result: await failRun({
        input,
        deps,
        now,
        tracker,
        flowAgent: "agent_one",
        errorSummary: proposedChangesCall.errorSummary,
      }),
    };
  }
  const proposedChanges = parseStructured(
    "proposed_changes",
    "agent_one",
    proposedChangesCall.result,
    collaborationProposedChangesOutputSchema,
  );
  if (!proposedChanges.success) {
    return {
      kind: "failed",
      result: await failRun({
        input,
        deps,
        now,
        tracker,
        flowAgent: "agent_one",
        errorSummary: proposedChanges.error,
      }),
    };
  }
  await trackArtifact(tracker, proposedChanges.value);
  await persistArtifactsSnapshot(input, deps, now, tracker);

  return { kind: "ok", proposedChanges: proposedChanges.value };
}

export interface RunResolutionDecisionStepContext {
  input: AsymmetricCollaborationSliceInput;
  deps: AsymmetricCollaborationSliceDeps;
  now: () => string;
  tracker: ArtifactTracker;
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
  });
  const resolutionCall = await callPrimitive({
    input,
    deps,
    flowAgent: "agent_one",
    backend: backendForAgent("agent_one"),
    prompt: resolutionPrompt,
  });
  if (resolutionCall.kind === "failed") {
    return {
      kind: "failed",
      result: await failRun({
        input,
        deps,
        now,
        tracker,
        flowAgent: "agent_one",
        errorSummary: resolutionCall.errorSummary,
      }),
    };
  }
  const resolution = parseStructured(
    "resolution_decision",
    "agent_one",
    resolutionCall.result,
    collaborationResolutionDecisionOutputSchema,
  );
  if (!resolution.success) {
    return {
      kind: "failed",
      result: await failRun({
        input,
        deps,
        now,
        tracker,
        flowAgent: "agent_one",
        errorSummary: resolution.error,
      }),
    };
  }
  await trackArtifact(tracker, resolution.value);
  await persistArtifactsSnapshot(input, deps, now, tracker);

  return { kind: "ok", resolution: resolution.value };
}
