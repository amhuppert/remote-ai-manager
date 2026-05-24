/**
 * Phase 2 of the asymmetric Collaboration slice: Agent Two's cross-review.
 *
 * Agent Two emits a `cross_review` against Agent One's initial draft. The
 * result is saved to the output zone but not delivered to Agent One as a
 * standalone message; Agent Two folds it into its counter-proposal at the
 * negotiation round's message 6.
 */

import { buildAgentTwoCrossReviewPrompt } from "./prompt-builders";
import {
  collaborationCrossReviewOutputSchema,
  type CollaborationAgent,
  type CollaborationCrossReviewOutput,
  type CollaborationFlowAgent,
  type CollaborationInitialDraftOutput,
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

export interface RunCrossReviewPhaseContext {
  input: AsymmetricCollaborationSliceInput;
  deps: AsymmetricCollaborationSliceDeps;
  now: () => string;
  tracker: ArtifactTracker;
  backendForAgent: (agent: CollaborationFlowAgent) => CollaborationAgent;
  agentOneDraft: CollaborationInitialDraftOutput;
  agentTwoDraft: CollaborationInitialDraftOutput;
}

export type RunCrossReviewPhaseOutcome =
  | { kind: "ok"; crossReview: CollaborationCrossReviewOutput }
  | {
      kind: "failed";
      result: Extract<AsymmetricCollaborationSliceResult, { kind: "failed" }>;
    };

export async function runCrossReviewPhase(
  ctx: RunCrossReviewPhaseContext,
): Promise<RunCrossReviewPhaseOutcome> {
  const {
    input,
    deps,
    now,
    tracker,
    backendForAgent,
    agentOneDraft,
    agentTwoDraft,
  } = ctx;

  const crossReviewPrompt = buildAgentTwoCrossReviewPrompt({
    userPrompt: input.brief,
    ownDraft: agentTwoDraft,
    otherDraft: agentOneDraft,
  });
  const crossReviewCall = await callPrimitive({
    input,
    deps,
    flowAgent: "agent_two",
    backend: backendForAgent("agent_two"),
    prompt: crossReviewPrompt,
  });
  if (crossReviewCall.kind === "failed") {
    return {
      kind: "failed",
      result: await failRun({
        input,
        deps,
        now,
        tracker,
        flowAgent: "agent_two",
        errorSummary: crossReviewCall.errorSummary,
      }),
    };
  }
  const crossReview = parseStructured(
    "cross_review",
    "agent_two",
    crossReviewCall.result,
    collaborationCrossReviewOutputSchema,
  );
  if (!crossReview.success) {
    return {
      kind: "failed",
      result: await failRun({
        input,
        deps,
        now,
        tracker,
        flowAgent: "agent_two",
        errorSummary: crossReview.error,
      }),
    };
  }
  trackArtifact(tracker, crossReview.value);
  await persistArtifactsSnapshot(input, deps, now, tracker);

  return { kind: "ok", crossReview: crossReview.value };
}
