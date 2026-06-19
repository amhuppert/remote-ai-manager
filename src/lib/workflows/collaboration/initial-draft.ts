/**
 * Phase 1 of the asymmetric Collaboration slice: parallel initial drafts.
 *
 * Agent One and Agent Two each emit an `initial_draft` against the user prompt
 * in parallel. Each call is `read_only`, so the lane scheduler bypasses the
 * per-session write lock and the two requests overlap.
 *
 * Both outcomes are processed before deciding to fail: if one peer succeeds
 * and the other fails, the successful artifact is still tracked, registered,
 * and persisted so the partial run remains visible in the envelope snapshot.
 */

import {
  buildAgentOneInitialDraftPrompt,
  buildAgentTwoInitialDraftPrompt,
} from "./prompt-builders";
import {
  collaborationInitialDraftOutputSchema,
  type CollaborationAgent,
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

export interface RunInitialDraftsPhaseContext {
  input: AsymmetricCollaborationSliceInput;
  deps: AsymmetricCollaborationSliceDeps;
  now: () => string;
  tracker: ArtifactTracker;
  backendForAgent: (agent: CollaborationFlowAgent) => CollaborationAgent;
}

export type RunInitialDraftsPhaseOutcome =
  | {
      kind: "ok";
      agentOneDraft: CollaborationInitialDraftOutput;
      agentTwoDraft: CollaborationInitialDraftOutput;
    }
  | {
      kind: "failed";
      result: Extract<AsymmetricCollaborationSliceResult, { kind: "failed" }>;
    };

export async function runInitialDraftsPhase(
  ctx: RunInitialDraftsPhaseContext,
): Promise<RunInitialDraftsPhaseOutcome> {
  const { input, deps, now, tracker, backendForAgent } = ctx;

  const agentOneInitialPrompt = buildAgentOneInitialDraftPrompt({
    userPrompt: input.brief,
  });
  const agentTwoInitialPrompt = buildAgentTwoInitialDraftPrompt({
    userPrompt: input.brief,
  });

  // Initial drafts are pure planning calls: each agent emits structured
  // output (handled post-call by the artifact registry). They must run in
  // parallel — `read_only` lets the lane scheduler skip the per-session
  // write lock so both calls overlap.
  const [agentOneDraftCall, agentTwoDraftCall] = await Promise.all([
    callPrimitive({
      input,
      deps,
      flowAgent: "agent_one",
      backend: backendForAgent("agent_one"),
      prompt: agentOneInitialPrompt,
      writeCapability: "read_only",
    }),
    callPrimitive({
      input,
      deps,
      flowAgent: "agent_two",
      backend: backendForAgent("agent_two"),
      prompt: agentTwoInitialPrompt,
      writeCapability: "read_only",
    }),
  ]);

  // Process both initial-draft outcomes BEFORE deciding to fail. If one
  // peer failed but the other succeeded, the successful peer's artifact is
  // tracked, registered, and persisted so the partial run remains visible
  // in the snapshot.
  const agentOneDraft =
    agentOneDraftCall.kind === "ok"
      ? parseStructured(
          "initial_draft",
          "agent_one",
          agentOneDraftCall.result,
          collaborationInitialDraftOutputSchema,
        )
      : null;
  const agentTwoDraft =
    agentTwoDraftCall.kind === "ok"
      ? parseStructured(
          "initial_draft",
          "agent_two",
          agentTwoDraftCall.result,
          collaborationInitialDraftOutputSchema,
        )
      : null;

  if (agentOneDraft && agentOneDraft.success) {
    await trackArtifact(tracker, agentOneDraft.value);
    await persistArtifactsSnapshot(input, deps, now, tracker);
  }
  if (agentTwoDraft && agentTwoDraft.success) {
    await trackArtifact(tracker, agentTwoDraft.value);
    await persistArtifactsSnapshot(input, deps, now, tracker);
  }

  if (agentOneDraftCall.kind === "failed") {
    return {
      kind: "failed",
      result: await failRun({
        input,
        deps,
        now,
        tracker,
        flowAgent: "agent_one",
        errorSummary: agentOneDraftCall.errorSummary,
      }),
    };
  }
  if (agentTwoDraftCall.kind === "failed") {
    return {
      kind: "failed",
      result: await failRun({
        input,
        deps,
        now,
        tracker,
        flowAgent: "agent_two",
        errorSummary: agentTwoDraftCall.errorSummary,
      }),
    };
  }
  if (!agentOneDraft || !agentOneDraft.success) {
    return {
      kind: "failed",
      result: await failRun({
        input,
        deps,
        now,
        tracker,
        flowAgent: "agent_one",
        errorSummary: agentOneDraft ? agentOneDraft.error : "agent_one missing",
      }),
    };
  }
  if (!agentTwoDraft || !agentTwoDraft.success) {
    return {
      kind: "failed",
      result: await failRun({
        input,
        deps,
        now,
        tracker,
        flowAgent: "agent_two",
        errorSummary: agentTwoDraft ? agentTwoDraft.error : "agent_two missing",
      }),
    };
  }

  return {
    kind: "ok",
    agentOneDraft: agentOneDraft.value,
    agentTwoDraft: agentTwoDraft.value,
  };
}
