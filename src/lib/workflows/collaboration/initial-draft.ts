/**
 * Phase 1 of the asymmetric Collaboration slice: parallel initial drafts.
 *
 * Agent One and Agent Two each emit an `initial_draft` against the user prompt.
 * Each call writes generated markdown artifacts under the session worktree, so
 * calls use the write-capable lane path.
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
  collaborationInitialDraftContentSchema,
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
  parseAndInjectArtifact,
  trackArtifact,
  type ArtifactTracker,
} from "./helpers";
import { validateGeneratedArtifactFiles } from "./artifact-files";

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
    workflowId: input.workflowId,
  });
  const agentTwoInitialPrompt = buildAgentTwoInitialDraftPrompt({
    userPrompt: input.brief,
    workflowId: input.workflowId,
  });

  // Both drafts run concurrently: each agent's writes are confined to its
  // own artifact paths (the prompts forbid touching anything else), so the
  // per-session write lock is deliberately bypassed via `artifact_only`.
  const [agentOneDraftCall, agentTwoDraftCall] = await Promise.all([
    callPrimitive({
      input,
      deps,
      flowAgent: "agent_one",
      backend: backendForAgent("agent_one"),
      prompt: agentOneInitialPrompt,
      writeCapability: "artifact_only",
    }),
    callPrimitive({
      input,
      deps,
      flowAgent: "agent_two",
      backend: backendForAgent("agent_two"),
      prompt: agentTwoInitialPrompt,
      writeCapability: "artifact_only",
    }),
  ]);

  // Process both initial-draft outcomes BEFORE deciding to fail. If one
  // peer failed but the other succeeded, the successful peer's artifact is
  // tracked, registered, and persisted so the partial run remains visible
  // in the snapshot.
  const agentOneDraft =
    agentOneDraftCall.kind === "ok"
      ? parseAndInjectArtifact("agent_one", agentOneDraftCall.result, {
          contentSchema: collaborationInitialDraftContentSchema,
          fullSchema: collaborationInitialDraftOutputSchema,
          injection: { kind: "initial_draft", agent: "agent_one", round: 0 },
        })
      : null;
  const agentTwoDraft =
    agentTwoDraftCall.kind === "ok"
      ? parseAndInjectArtifact("agent_two", agentTwoDraftCall.result, {
          contentSchema: collaborationInitialDraftContentSchema,
          fullSchema: collaborationInitialDraftOutputSchema,
          injection: { kind: "initial_draft", agent: "agent_two", round: 0 },
        })
      : null;

  if (agentOneDraft && agentOneDraft.success) {
    const validation = await validateGeneratedArtifactFiles({
      worktreePath: input.worktreePath,
      workflowId: input.workflowId,
      artifact: agentOneDraft.value,
    });
    if (!validation.success) {
      return {
        kind: "failed",
        result: await failRun({
          input,
          deps,
          now,
          tracker,
          flowAgent: "agent_one",
          errorSummary: `initial_draft (agent_one) artifact_files: ${validation.error}`,
        }),
      };
    }
    await trackArtifact(tracker, agentOneDraft.value);
    await persistArtifactsSnapshot(input, deps, now, tracker);
  }
  if (agentTwoDraft && agentTwoDraft.success) {
    const validation = await validateGeneratedArtifactFiles({
      worktreePath: input.worktreePath,
      workflowId: input.workflowId,
      artifact: agentTwoDraft.value,
    });
    if (!validation.success) {
      return {
        kind: "failed",
        result: await failRun({
          input,
          deps,
          now,
          tracker,
          flowAgent: "agent_two",
          errorSummary: `initial_draft (agent_two) artifact_files: ${validation.error}`,
        }),
      };
    }
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
