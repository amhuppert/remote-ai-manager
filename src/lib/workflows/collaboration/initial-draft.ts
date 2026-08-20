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

import { createLogger } from "@/lib/logging";
import { getErrorMessage } from "@/lib/shared/errors";
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
  produceCollaborationStep,
  trackArtifact,
  type ArtifactTracker,
  type ProduceCollaborationStepOutcome,
} from "./helpers";
import type { CollaborationStepLedger } from "./step-ledger";

const logger = createLogger("workflows.collaboration.initial-draft");

export interface RunInitialDraftsPhaseContext {
  input: AsymmetricCollaborationSliceInput;
  deps: AsymmetricCollaborationSliceDeps;
  now: () => string;
  tracker: ArtifactTracker;
  /** The prior attempt's recorded outputs; null for a run with no history.
   *  A peer whose draft is already recorded is not dispatched again — the
   *  common shape after one model has an outage. */
  ledger: CollaborationStepLedger | null;
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
  // Both peers run concurrently, but nothing is committed until BOTH have
  // settled: the sidecar is append-only, so committing inside the concurrent
  // calls would make its order depend on which model answered first, and a
  // resumed run replays that order.
  const [agentOneStep, agentTwoStep] = await Promise.all([
    produceCollaborationStep<CollaborationInitialDraftOutput>({
      input,
      deps,
      ledger: ctx.ledger,
      key: { kind: "initial_draft", agent: "agent_one" },
      flowAgent: "agent_one",
      backend: backendForAgent("agent_one"),
      prompt: agentOneInitialPrompt,
      contentSchema: collaborationInitialDraftContentSchema,
      fullSchema: collaborationInitialDraftOutputSchema,
      injection: { kind: "initial_draft", agent: "agent_one", round: 0 },
      ...(input.imageRefs !== undefined ? { imageRefs: input.imageRefs } : {}),
      writeCapability: "artifact_only",
    }),
    produceCollaborationStep<CollaborationInitialDraftOutput>({
      input,
      deps,
      ledger: ctx.ledger,
      key: { kind: "initial_draft", agent: "agent_two" },
      flowAgent: "agent_two",
      backend: backendForAgent("agent_two"),
      prompt: agentTwoInitialPrompt,
      contentSchema: collaborationInitialDraftContentSchema,
      fullSchema: collaborationInitialDraftOutputSchema,
      injection: { kind: "initial_draft", agent: "agent_two", round: 0 },
      ...(input.imageRefs !== undefined ? { imageRefs: input.imageRefs } : {}),
      writeCapability: "artifact_only",
    }),
  ]);

  // Commit in canonical agent_one-then-agent_two order, and only what this
  // attempt produced: a replayed draft is already on disk and already in the
  // tracker. A peer that succeeded is preserved even when its sibling failed,
  // so the next attempt re-dispatches only the peer that never finished.
  const steps: Array<
    [
      CollaborationFlowAgent,
      ProduceCollaborationStepOutcome<CollaborationInitialDraftOutput>,
    ]
  > = [
    ["agent_one", agentOneStep],
    ["agent_two", agentTwoStep],
  ];
  for (const [flowAgent, step] of steps) {
    if (step.kind !== "produced") continue;
    await trackArtifact(tracker, step.artifact);
    await persistArtifactsSnapshot(input, deps, now, tracker);
    logger.debug("collaboration.initial_draft.committed", {
      workflowId: input.workflowId,
      flowAgent,
    });
  }

  for (const [flowAgent, step] of steps) {
    if (step.kind !== "failed") continue;
    return {
      kind: "failed",
      result: await failRun({
        input,
        deps,
        now,
        tracker,
        flowAgent,
        errorSummary: step.errorSummary,
        cause: step.cause,
      }),
    };
  }

  const agentOneDraft =
    agentOneStep.kind === "failed" ? null : agentOneStep.artifact;
  const agentTwoDraft =
    agentTwoStep.kind === "failed" ? null : agentTwoStep.artifact;
  if (!agentOneDraft || !agentTwoDraft) {
    return {
      kind: "failed",
      result: await failRun({
        input,
        deps,
        now,
        tracker,
        flowAgent: !agentOneDraft ? "agent_one" : "agent_two",
        errorSummary: "initial_draft did not produce an artifact",
        cause: { kind: "structured_output" },
      }),
    };
  }

  await recordAlignmentSeenForRun(input, deps);

  return { kind: "ok", agentOneDraft, agentTwoDraft };
}

/**
 * Mark the captured charter version as seen by the run.
 *
 * Deliberately placed after both drafts parsed and validated: only then has the
 * charter actually reached both peers, so an Alignment panel reading the
 * seen-version cannot claim currency for a run where one lane never got it.
 * A failure here is audit metadata, not run state — it is logged and the run
 * continues, matching how the ordinary turn path treats post-turn bookkeeping.
 */
async function recordAlignmentSeenForRun(
  input: AsymmetricCollaborationSliceInput,
  deps: AsymmetricCollaborationSliceDeps,
): Promise<void> {
  const alignmentVersion = input.sessionContext.alignment?.version;
  if (alignmentVersion === undefined) return;
  if (!input.conversationId || !deps.recordAlignmentSeen) return;

  try {
    await deps.recordAlignmentSeen(input.conversationId, alignmentVersion);
    logger.info("collaboration.alignment_version_seen", {
      workflowId: input.workflowId,
      conversationId: input.conversationId,
      alignmentVersion,
    });
  } catch (err) {
    logger.warn("collaboration.alignment_version_seen_failed", {
      workflowId: input.workflowId,
      conversationId: input.conversationId,
      alignmentVersion,
      error: getErrorMessage(err),
    });
  }
}
