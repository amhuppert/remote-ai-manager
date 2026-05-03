/**
 * Asymmetric Collaboration Mode slice.
 *
 * Composes the workflow primitive layer (AgentCall, Lane, StatusBus,
 * WorkflowEnvelope, HumanApprovalGate) for the primary-led negotiation
 * state machine described in
 * `memory-bank/COLLABORATION_MODE_FLOW.md` and
 * `memory-bank/COLLABORATION_MODE_IMPLEMENTATION_PLAN.md` phases 3-5.
 *
 * Phase sequence:
 *
 *   1. Initial drafts (parallel) — Agent One and Agent Two each emit an
 *      `initial_draft` against the user prompt, in parallel.
 *   2. Cross-review (Agent Two only) — Agent Two emits a `cross_review` of
 *      Agent One's draft; the result is saved to the output zone but not
 *      delivered to Agent One as a standalone message. Agent Two folds it
 *      into its counter-proposal at message 6.
 *   3. Negotiation rounds (1..n) — Each round runs:
 *        - Agent One `proposed_changes` (sees both drafts but NOT Agent Two's
 *          cross-review)
 *        - Agent Two `counter_proposal` (sees both drafts, its own
 *          cross-review, and Agent One's proposed_changes)
 *        - Agent One `resolution_decision` (sees the LATEST counter-proposal
 *          for the round being resolved — never an earlier round's)
 *      After each resolution, `decideCollaborationNextStep` is consulted
 *      with `negotiationRoundsRemaining` (rounds AFTER this one). The slice
 *      then either continues, finalizes, pauses for user input, or fails.
 *   4. Final answer (Agent One) — when the policy returns `final`, Agent One
 *      emits a `final_answer`. The slice optionally appends a transcript
 *      entry to the originating conversation.
 */

import { createHash as _createHash } from "node:crypto";
import { createLogger } from "@/lib/logging";
import { getErrorMessage } from "@/lib/errors";
import type { AgentSessionRef } from "@/lib/schemas";
import { pauseForHumanApproval } from "@/lib/workflows/primitives/human-approval-gate";
import type {
  AgentCallRequest,
  AgentCallResult,
} from "@/lib/workflows/primitives/agent-call-vocabulary";
import type { LaneScheduler } from "@/lib/workflows/primitives/lane-scheduler";
import type { LaneService } from "@/lib/workflows/primitives/lane-service";
import type { LaneState } from "@/lib/workflows/primitives/lane-vocabulary";
import type { StatusBus } from "@/lib/workflows/primitives/status-bus";
import type {
  WorkflowEnvelope,
  WorkflowEnvelopeStatus,
} from "@/lib/workflows/primitives/workflow-envelope-vocabulary";
import type { WorkflowEnvelopeStore } from "@/lib/workflows/primitives/workflow-envelope-store";
import {
  buildAgentOneFinalAnswerPrompt,
  buildAgentOneInitialDraftPrompt,
  buildAgentOneProposedChangesPrompt,
  buildAgentOneResolutionDecisionPrompt,
  buildAgentTwoCounterProposalPrompt,
  buildAgentTwoCrossReviewPrompt,
  buildAgentTwoInitialDraftPrompt,
  type BuiltCollaborationPrompt,
} from "./prompt-builders";
import {
  decideCollaborationNextStep,
  type CollaborationPolicyDecision,
} from "./policy";
import {
  collaborationCounterProposalOutputSchema,
  collaborationCrossReviewOutputSchema,
  collaborationFinalAnswerOutputSchema,
  collaborationInitialDraftOutputSchema,
  collaborationProposedChangesOutputSchema,
  collaborationResolutionDecisionOutputSchema,
  type CollaborationAgent,
  type CollaborationArtifact,
  type CollaborationAutonomousResolutionThreshold,
  type CollaborationCounterProposalOutput,
  type CollaborationFinalAnswerOutput,
  type CollaborationFlowAgent,
  type CollaborationInitialDraftOutput,
  type CollaborationOpenConflictsOutput,
  type CollaborationResolutionDecisionOutput,
} from "./types";

const logger = createLogger("workflows.collaboration.asymmetric-slice");

const COLLABORATION_WORKFLOW_TYPE = "collaboration";
const COLLABORATION_SCOPE = "collaboration";

interface ArtifactTracker {
  artifacts: CollaborationArtifact[];
  negotiationRoundsCompleted: number;
}

export interface AsymmetricCollaborationSliceInput {
  workflowId: string;
  brief: string;
  worktreePath: string;
  /**
   * Stable scheduling key shared by every lane execution that touches the
   * same session worktree. Two write-capable lanes scheduled with the same
   * `sessionKey` are serialized by the LaneScheduler so they cannot mutate
   * the worktree concurrently.
   */
  sessionKey: string;
  /**
   * The Primary's backend. Agent Two is automatically routed to the opposite
   * backend (`claude` if primary is `codex`, otherwise `codex`).
   */
  primaryAgentBackend: CollaborationAgent;
  negotiationRounds: number;
  autonomousResolutionThreshold: CollaborationAutonomousResolutionThreshold;
  /**
   * Optional originating conversation. When set and `appendTranscriptEntry`
   * is provided, the final answer body is appended back into the conversation
   * transcript as an assistant turn.
   */
  conversationId?: string;
  /**
   * The originating conversation's stored backend session ref. When present
   * and the backend matches `primaryAgentBackend`, the primary lane's
   * `backendState` is seeded with the corresponding `conversationId` /
   * `threadId` so Agent One's first turn resumes the prior session and
   * inherits its full context. Backend mismatches are silently ignored.
   */
  priorBackendRef?: AgentSessionRef;
  /**
   * Optional cooperative cancel signal. When aborted between phases, the
   * slice returns `completed_unresolved` with reason `user_stopped`.
   */
  stopSignal?: AbortSignal;
  /**
   * Resume payload supplied when the slice is being re-entered after a
   * `paused_for_user_input` outcome. The user answers are keyed by the
   * question id from the latest `open_conflicts` artifact and surfaced on
   * the feature snapshot so callers can correlate answers to questions
   * across rounds without depending on round numbers.
   */
  resume?: {
    userAnswersByQuestionId?: Record<string, string>;
  };
}

export type AsymmetricCollaborationSliceResult =
  | {
      kind: "completed_final";
      finalAnswerArtifactId: string;
      negotiationRoundsCompleted: number;
    }
  | {
      kind: "paused_for_user_input";
      resumeToken: string;
      negotiationRoundsCompleted: number;
      reason:
        | "objective_disagreement"
        | "explicit_ask_user"
        | "rounds_exhausted_above_threshold"
        | "threshold_none_with_remaining";
    }
  | {
      kind: "completed_unresolved";
      reason: "user_stopped";
      negotiationRoundsCompleted: number;
    }
  | {
      kind: "failed";
      agent: CollaborationFlowAgent;
      errorSummary: string;
    };

export type AsymmetricDispatchInfo =
  | { kind: "paused-for-user-input"; workflowId: string }
  | { kind: "completed-final"; workflowId: string }
  | {
      kind: "completed-unresolved";
      workflowId: string;
      reason: "user_stopped";
    }
  | {
      kind: "failed";
      workflowId: string;
      agent: CollaborationFlowAgent;
    };

export interface AsymmetricCollaborationSliceDeps {
  callAgent(request: AgentCallRequest): Promise<AgentCallResult>;
  laneService: LaneService;
  laneScheduler: LaneScheduler;
  envelopeStore: WorkflowEnvelopeStore;
  statusBus: StatusBus;
  /**
   * Optional fire-and-forget hook for sending push notifications when the
   * collaboration enters a user-visible terminal or paused state.
   */
  dispatchPush?(info: AsymmetricDispatchInfo): void;
  /**
   * Appends a transcript entry to the originating conversation's JSONL file.
   * Called once when the slice resolves to `completed_final` so synthesis
   * survives outside the live `CollabPassage`.
   */
  appendTranscriptEntry?(
    conversationId: string,
    entry: {
      timestamp: string;
      type: string;
      role?: "user" | "assistant";
      content?: { type: "text"; text: string }[];
    },
  ): Promise<unknown>;
  /**
   * Marks the originating conversation ready for the next prompt after a
   * terminal final answer has been written. Metadata sync failures are logged
   * and do not invalidate the completed collaboration result.
   */
  markConversationAwaiting?(
    conversationId: string,
    input: { workflowId: string; timestamp: string },
  ): Promise<unknown>;
  /**
   * Persists the primary lane's advanced backend ref onto the originating
   * conversation after the final answer is committed, so subsequent normal
   * turns continue from where collab left off. Failures are logged and do
   * not invalidate the completed run.
   */
  updateConversationBackendRef?(
    conversationId: string,
    ref: AgentSessionRef,
  ): Promise<unknown>;
  now?: () => string;
}

export async function runAsymmetricCollaborationSlice(
  input: AsymmetricCollaborationSliceInput,
  deps: AsymmetricCollaborationSliceDeps,
): Promise<AsymmetricCollaborationSliceResult> {
  if (input.negotiationRounds < 1) {
    throw new Error(
      `runAsymmetricCollaborationSlice requires negotiationRounds >= 1, received ${input.negotiationRounds}`,
    );
  }

  const now = deps.now ?? (() => new Date().toISOString());
  const agentTwoBackend: CollaborationAgent =
    input.primaryAgentBackend === "claude" ? "codex" : "claude";
  const backendForAgent = (
    agent: CollaborationFlowAgent,
  ): CollaborationAgent =>
    agent === "agent_one" ? input.primaryAgentBackend : agentTwoBackend;

  const tracker: ArtifactTracker = {
    artifacts: [],
    negotiationRoundsCompleted: 0,
  };

  await initializeLanes(input, deps, now);
  const { resumeArtifacts, resumeNegotiationRoundsCompleted } =
    await initializeEnvelope(input, deps, now, {
      primaryBackend: input.primaryAgentBackend,
      secondaryBackend: agentTwoBackend,
    });
  publishStatus(deps, input.workflowId, "running", {
    kind: "asymmetric_started",
    primaryAgentBackend: input.primaryAgentBackend,
  });

  if (resumeArtifacts !== null) {
    return runResumeFinalAnswer({
      input,
      deps,
      now,
      tracker,
      backendForAgent,
      resumeArtifacts,
      negotiationRoundsCompleted: resumeNegotiationRoundsCompleted,
    });
  }

  // -------------------------------------------------------------
  // Phase 1: Initial drafts in parallel.
  // -------------------------------------------------------------
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
    trackArtifact(tracker, agentOneDraft.value);
    await persistArtifactsSnapshot(input, deps, now, tracker);
  }
  if (agentTwoDraft && agentTwoDraft.success) {
    trackArtifact(tracker, agentTwoDraft.value);
    await persistArtifactsSnapshot(input, deps, now, tracker);
  }

  if (agentOneDraftCall.kind === "failed") {
    return failRun({
      input,
      deps,
      now,
      tracker,
      flowAgent: "agent_one",
      errorSummary: agentOneDraftCall.errorSummary,
    });
  }
  if (agentTwoDraftCall.kind === "failed") {
    return failRun({
      input,
      deps,
      now,
      tracker,
      flowAgent: "agent_two",
      errorSummary: agentTwoDraftCall.errorSummary,
    });
  }
  if (!agentOneDraft || !agentOneDraft.success) {
    return failRun({
      input,
      deps,
      now,
      tracker,
      flowAgent: "agent_one",
      errorSummary: agentOneDraft ? agentOneDraft.error : "agent_one missing",
    });
  }
  if (!agentTwoDraft || !agentTwoDraft.success) {
    return failRun({
      input,
      deps,
      now,
      tracker,
      flowAgent: "agent_two",
      errorSummary: agentTwoDraft ? agentTwoDraft.error : "agent_two missing",
    });
  }

  if (input.stopSignal?.aborted) {
    return finalizeUserStopped({
      input,
      deps,
      now,
      tracker,
      negotiationRoundsCompleted: 0,
    });
  }

  // -------------------------------------------------------------
  // Phase 2: Agent Two's cross-review (saved to output zone only).
  // -------------------------------------------------------------
  const crossReviewPrompt = buildAgentTwoCrossReviewPrompt({
    userPrompt: input.brief,
    ownDraft: agentTwoDraft.value,
    otherDraft: agentOneDraft.value,
  });
  const crossReviewCall = await callPrimitive({
    input,
    deps,
    flowAgent: "agent_two",
    backend: backendForAgent("agent_two"),
    prompt: crossReviewPrompt,
  });
  if (crossReviewCall.kind === "failed") {
    return failRun({
      input,
      deps,
      now,
      tracker,
      flowAgent: "agent_two",
      errorSummary: crossReviewCall.errorSummary,
    });
  }
  const crossReview = parseStructured(
    "cross_review",
    "agent_two",
    crossReviewCall.result,
    collaborationCrossReviewOutputSchema,
  );
  if (!crossReview.success) {
    return failRun({
      input,
      deps,
      now,
      tracker,
      flowAgent: "agent_two",
      errorSummary: crossReview.error,
    });
  }
  trackArtifact(tracker, crossReview.value);
  await persistArtifactsSnapshot(input, deps, now, tracker);

  if (input.stopSignal?.aborted) {
    return finalizeUserStopped({
      input,
      deps,
      now,
      tracker,
      negotiationRoundsCompleted: 0,
    });
  }

  // -------------------------------------------------------------
  // Phase 3: Negotiation rounds.
  // -------------------------------------------------------------
  let latestCounterProposal: CollaborationCounterProposalOutput | null = null;
  let latestResolutionDecision: CollaborationResolutionDecisionOutput | null =
    null;
  let policyDecision: CollaborationPolicyDecision | null = null;
  let roundsCompleted = 0;

  for (let round = 1; round <= input.negotiationRounds; round++) {
    if (input.stopSignal?.aborted) {
      return finalizeUserStopped({
        input,
        deps,
        now,
        tracker,
        negotiationRoundsCompleted: roundsCompleted,
      });
    }

    // Agent One proposed_changes (does NOT see Agent Two's cross-review).
    const proposedChangesPrompt = buildAgentOneProposedChangesPrompt({
      userPrompt: input.brief,
      ownDraft: agentOneDraft.value,
      otherDraft: agentTwoDraft.value,
    });
    const proposedChangesCall = await callPrimitive({
      input,
      deps,
      flowAgent: "agent_one",
      backend: backendForAgent("agent_one"),
      prompt: proposedChangesPrompt,
    });
    if (proposedChangesCall.kind === "failed") {
      return failRun({
        input,
        deps,
        now,
        tracker,
        flowAgent: "agent_one",
        errorSummary: proposedChangesCall.errorSummary,
      });
    }
    const proposedChanges = parseStructured(
      "proposed_changes",
      "agent_one",
      proposedChangesCall.result,
      collaborationProposedChangesOutputSchema,
    );
    if (!proposedChanges.success) {
      return failRun({
        input,
        deps,
        now,
        tracker,
        flowAgent: "agent_one",
        errorSummary: proposedChanges.error,
      });
    }
    trackArtifact(tracker, proposedChanges.value);
    await persistArtifactsSnapshot(input, deps, now, tracker);

    // Agent Two counter_proposal (sees its own cross-review AND
    // Agent One's proposed changes).
    const counterProposalPrompt = buildAgentTwoCounterProposalPrompt({
      userPrompt: input.brief,
      ownDraft: agentTwoDraft.value,
      otherDraft: agentOneDraft.value,
      ownCrossReview: crossReview.value,
      proposedChanges: proposedChanges.value,
    });
    const counterProposalCall = await callPrimitive({
      input,
      deps,
      flowAgent: "agent_two",
      backend: backendForAgent("agent_two"),
      prompt: counterProposalPrompt,
    });
    if (counterProposalCall.kind === "failed") {
      return failRun({
        input,
        deps,
        now,
        tracker,
        flowAgent: "agent_two",
        errorSummary: counterProposalCall.errorSummary,
      });
    }
    const counterProposal = parseStructured(
      "counter_proposal",
      "agent_two",
      counterProposalCall.result,
      collaborationCounterProposalOutputSchema,
    );
    if (!counterProposal.success) {
      return failRun({
        input,
        deps,
        now,
        tracker,
        flowAgent: "agent_two",
        errorSummary: counterProposal.error,
      });
    }
    latestCounterProposal = counterProposal.value;
    trackArtifact(tracker, counterProposal.value);
    await persistArtifactsSnapshot(input, deps, now, tracker);

    // Agent One resolution_decision (sees the LATEST counter-proposal of
    // this round — never an earlier round's).
    const resolutionPrompt = buildAgentOneResolutionDecisionPrompt({
      userPrompt: input.brief,
      ownDraft: agentOneDraft.value,
      otherDraft: agentTwoDraft.value,
      proposedChanges: proposedChanges.value,
      latestCounterProposal: counterProposal.value,
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
      return failRun({
        input,
        deps,
        now,
        tracker,
        flowAgent: "agent_one",
        errorSummary: resolutionCall.errorSummary,
      });
    }
    const resolution = parseStructured(
      "resolution_decision",
      "agent_one",
      resolutionCall.result,
      collaborationResolutionDecisionOutputSchema,
    );
    if (!resolution.success) {
      return failRun({
        input,
        deps,
        now,
        tracker,
        flowAgent: "agent_one",
        errorSummary: resolution.error,
      });
    }
    latestResolutionDecision = resolution.value;
    roundsCompleted = round;
    tracker.negotiationRoundsCompleted = round;
    trackArtifact(tracker, resolution.value);
    await persistArtifactsSnapshot(input, deps, now, tracker);

    const negotiationRoundsRemaining = input.negotiationRounds - round;
    policyDecision = decideCollaborationNextStep({
      decision: resolution.value,
      autonomousResolutionThreshold: input.autonomousResolutionThreshold,
      negotiationRoundsRemaining,
    });

    logger.info("collaboration.asymmetric.policy_decision", {
      workflowId: input.workflowId,
      round,
      negotiationRoundsRemaining,
      policyKind: policyDecision.kind,
      nextAction: resolution.value.nextAction,
    });

    if (policyDecision.kind === "continue_negotiation") {
      continue;
    }
    break;
  }

  if (!policyDecision || !latestResolutionDecision || !latestCounterProposal) {
    // Should be unreachable: we ran at least one round and assigned all
    // three above. Defensive guard so the type narrowing below is sound.
    return failRun({
      input,
      deps,
      now,
      tracker,
      flowAgent: "agent_one",
      errorSummary: "policy decision was never produced",
    });
  }

  // -------------------------------------------------------------
  // Phase 4: Branch on the policy decision.
  // -------------------------------------------------------------
  if (policyDecision.kind === "fail") {
    return failRun({
      input,
      deps,
      now,
      tracker,
      flowAgent: "agent_one",
      errorSummary:
        latestResolutionDecision.rationale ||
        "agent_one returned nextAction=fail",
    });
  }

  if (policyDecision.kind === "ask_user") {
    return await pauseForUserInput({
      input,
      deps,
      now,
      reason: policyDecision.reason,
      negotiationRoundsCompleted: roundsCompleted,
      tracker,
      latestResolutionDecision,
    });
  }

  // policyDecision.kind === "final"
  const latestOpenConflicts = findLatestOpenConflicts(tracker.artifacts);
  const userAnswers = buildUserAnswerList(
    latestOpenConflicts,
    input.resume?.userAnswersByQuestionId,
  );
  const finalAnswerPrompt = buildAgentOneFinalAnswerPrompt({
    userPrompt: input.brief,
    ownDraft: agentOneDraft.value,
    otherDraft: agentTwoDraft.value,
    latestCounterProposal: latestCounterProposal,
    latestResolutionDecision: latestResolutionDecision,
    artifactStream: [...tracker.artifacts],
    ...(latestOpenConflicts !== null
      ? { openConflicts: latestOpenConflicts }
      : {}),
    ...(userAnswers.length > 0 ? { userAnswers } : {}),
  });
  const finalAnswerCall = await callPrimitive({
    input,
    deps,
    flowAgent: "agent_one",
    backend: backendForAgent("agent_one"),
    prompt: finalAnswerPrompt,
  });
  if (finalAnswerCall.kind === "failed") {
    return failRun({
      input,
      deps,
      now,
      tracker,
      flowAgent: "agent_one",
      errorSummary: finalAnswerCall.errorSummary,
    });
  }
  const finalAnswer = parseStructured(
    "final_answer",
    "agent_one",
    finalAnswerCall.result,
    collaborationFinalAnswerOutputSchema,
  );
  if (!finalAnswer.success) {
    return failRun({
      input,
      deps,
      now,
      tracker,
      flowAgent: "agent_one",
      errorSummary: finalAnswer.error,
    });
  }

  return await finalizeFinal({
    input,
    deps,
    now,
    tracker,
    finalAnswer: finalAnswer.value,
    negotiationRoundsCompleted: roundsCompleted,
  });
}

// ============================================================
// Lane and envelope initialization.
// ============================================================

async function initializeLanes(
  input: AsymmetricCollaborationSliceInput,
  deps: AsymmetricCollaborationSliceDeps,
  now: () => string,
): Promise<void> {
  const seedClaude =
    input.priorBackendRef?.backend === "claude" &&
    input.primaryAgentBackend === "claude"
      ? { conversationId: input.priorBackendRef.sessionId }
      : {};
  const seedCodex =
    input.priorBackendRef?.backend === "codex" &&
    input.primaryAgentBackend === "codex"
      ? { threadId: input.priorBackendRef.threadId }
      : {};

  const claudeLane: LaneState = {
    workflowId: input.workflowId,
    laneId: "claude",
    backend: "claude",
    writeCapability: "write_capable",
    policy: { continuityEnabled: true },
    backendState: { backend: "claude", ...seedClaude },
    metrics: { backend: "claude", rotateBeforeNextTurn: false },
    lastUsedAt: now(),
  };
  const codexLane: LaneState = {
    workflowId: input.workflowId,
    laneId: "codex",
    backend: "codex",
    writeCapability: "write_capable",
    policy: { continuityEnabled: true },
    backendState: { backend: "codex", ...seedCodex },
    metrics: { backend: "codex", rotateBeforeNextTurn: false },
    lastUsedAt: now(),
  };
  await initializeLaneIfMissing(deps, claudeLane);
  await initializeLaneIfMissing(deps, codexLane);
}

async function initializeLaneIfMissing(
  deps: Pick<AsymmetricCollaborationSliceDeps, "laneService">,
  lane: LaneState,
): Promise<void> {
  const existing = await deps.laneService.resolve({
    workflowId: lane.workflowId,
    laneId: lane.laneId,
  });
  if (!existing) {
    await deps.laneService.initialize(lane);
    return;
  }
  if (existing.backend !== lane.backend) {
    throw new Error(
      `collaboration lane "${lane.laneId}" already exists with backend "${existing.backend}", expected "${lane.backend}"`,
    );
  }
}

async function readPrimaryLaneAdvancedRef(
  input: AsymmetricCollaborationSliceInput,
  deps: Pick<AsymmetricCollaborationSliceDeps, "laneService">,
): Promise<AgentSessionRef | null> {
  const lane = await deps.laneService.resolve({
    workflowId: input.workflowId,
    laneId: input.primaryAgentBackend,
  });
  if (!lane) return null;
  const state = lane.backendState;
  if (state.backend === "claude") {
    return state.conversationId
      ? { backend: "claude", sessionId: state.conversationId }
      : null;
  }
  return state.threadId ? { backend: "codex", threadId: state.threadId } : null;
}

interface InitializeEnvelopeOutcome {
  /**
   * Pre-existing artifact stream when the envelope was already paused with an
   * `open_conflicts` artifact and the caller supplied a `resume` payload. The
   * slice short-circuits the draft/negotiation phases when this is non-null
   * and jumps straight to the final-answer phase using the rehydrated stream.
   */
  resumeArtifacts: CollaborationArtifact[] | null;
  resumeNegotiationRoundsCompleted: number;
}

async function initializeEnvelope(
  input: AsymmetricCollaborationSliceInput,
  deps: AsymmetricCollaborationSliceDeps,
  now: () => string,
  backends: {
    primaryBackend: CollaborationAgent;
    secondaryBackend: CollaborationAgent;
  },
): Promise<InitializeEnvelopeOutcome> {
  const timestamp = now();
  let resumeArtifacts: CollaborationArtifact[] | null = null;
  let resumeNegotiationRoundsCompleted = 0;

  await deps.envelopeStore.upsert(input.workflowId, (existing) => {
    const previousSnapshot = (existing?.featureSnapshot ?? {}) as Record<
      string,
      unknown
    >;
    const previousArtifactsRaw = previousSnapshot["artifacts"];
    const previousArtifacts: CollaborationArtifact[] = Array.isArray(
      previousArtifactsRaw,
    )
      ? (previousArtifactsRaw as CollaborationArtifact[])
      : [];
    const previousRoundsRaw = previousSnapshot["negotiationRoundsCompleted"];
    const previousRoundsCompleted =
      typeof previousRoundsRaw === "number" ? previousRoundsRaw : 0;
    const previousAnswersRaw = previousSnapshot["userAnswersByQuestionId"];
    const previousAnswers: Record<string, string> =
      previousAnswersRaw && typeof previousAnswersRaw === "object"
        ? (previousAnswersRaw as Record<string, string>)
        : {};
    const mergedAnswers: Record<string, string> = {
      ...previousAnswers,
      ...(input.resume?.userAnswersByQuestionId ?? {}),
    };

    const hasOpenConflictsArtifact = previousArtifacts.some(
      (a) => a.kind === "open_conflicts",
    );
    if (hasOpenConflictsArtifact && input.resume !== undefined) {
      resumeArtifacts = [...previousArtifacts];
      resumeNegotiationRoundsCompleted = previousRoundsCompleted;
    }

    return {
      workflowId: input.workflowId,
      workflowType: COLLABORATION_WORKFLOW_TYPE,
      status: "running",
      phase: "asymmetric_initial_drafts",
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
      featureSnapshot: {
        ...previousSnapshot,
        mode: "asymmetric",
        brief: input.brief,
        primaryAgentBackend: input.primaryAgentBackend,
        primaryBackend: backends.primaryBackend,
        secondaryBackend: backends.secondaryBackend,
        negotiationRounds: input.negotiationRounds,
        negotiationRoundsCompleted: previousRoundsCompleted,
        autonomousResolutionThreshold: input.autonomousResolutionThreshold,
        artifacts: previousArtifacts,
        userAnswersByQuestionId: mergedAnswers,
        ...(input.conversationId !== undefined
          ? { conversationId: input.conversationId }
          : {}),
      },
    };
  });

  return { resumeArtifacts, resumeNegotiationRoundsCompleted };
}

function trackArtifact(
  tracker: ArtifactTracker,
  artifact: CollaborationArtifact,
): void {
  tracker.artifacts.push(artifact);
}

function findLatestOpenConflicts(
  artifacts: readonly CollaborationArtifact[],
): CollaborationOpenConflictsOutput | null {
  for (let i = artifacts.length - 1; i >= 0; i--) {
    const artifact = artifacts[i]!;
    if (artifact.kind === "open_conflicts") return artifact;
  }
  return null;
}

function buildUserAnswerList(
  openConflicts: CollaborationOpenConflictsOutput | null,
  answersByQuestionId: Record<string, string> | undefined,
): { questionId: string; question: string; answer: string }[] {
  if (!openConflicts || !answersByQuestionId) return [];
  const result: { questionId: string; question: string; answer: string }[] = [];
  for (const question of openConflicts.questions) {
    const answer = answersByQuestionId[question.id];
    if (typeof answer === "string" && answer.length > 0) {
      result.push({
        questionId: question.id,
        question: question.question,
        answer,
      });
    }
  }
  return result;
}

async function persistArtifactsSnapshot(
  input: AsymmetricCollaborationSliceInput,
  deps: AsymmetricCollaborationSliceDeps,
  now: () => string,
  tracker: ArtifactTracker,
): Promise<void> {
  await updateEnvelope(input, deps, now, (existing) => {
    const previous = (existing.featureSnapshot ?? {}) as Record<
      string,
      unknown
    >;
    return {
      ...existing,
      featureSnapshot: {
        ...previous,
        artifacts: [...tracker.artifacts],
        negotiationRoundsCompleted: tracker.negotiationRoundsCompleted,
      },
      updatedAt: now(),
    };
  });
}

async function updateEnvelope(
  input: AsymmetricCollaborationSliceInput,
  deps: AsymmetricCollaborationSliceDeps,
  now: () => string,
  mutate: (existing: WorkflowEnvelope) => WorkflowEnvelope,
): Promise<void> {
  await deps.envelopeStore.upsert(input.workflowId, (existing) => {
    if (!existing) {
      throw new Error(
        `asymmetric collaboration slice expected an existing envelope for workflow ${input.workflowId}`,
      );
    }
    if (existing.status === "completed" || existing.status === "failed") {
      return existing;
    }
    const next = mutate(existing);
    if (next.status !== "paused" && next.pause !== undefined) {
      const { pause: _drop, ...rest } = next;
      return { ...rest, updatedAt: now() } as WorkflowEnvelope;
    }
    return next;
  });
}

// ============================================================
// AgentCall facade with lane scheduling and structured-output parse.
// ============================================================

interface CallPrimitiveContext {
  input: AsymmetricCollaborationSliceInput;
  deps: AsymmetricCollaborationSliceDeps;
  flowAgent: CollaborationFlowAgent;
  backend: CollaborationAgent;
  prompt: BuiltCollaborationPrompt;
  /**
   * Defaults to `write_capable`. Use `read_only` for planning calls that
   * emit structured output without modifying the worktree — `read_only`
   * lets the lane scheduler bypass the per-session write lock so multiple
   * agents can run in parallel.
   */
  writeCapability?: "read_only" | "write_capable";
}

type CallPrimitiveOutcome =
  | { kind: "ok"; result: AgentCallResult }
  | { kind: "failed"; errorSummary: string };

async function callPrimitive(
  ctx: CallPrimitiveContext,
): Promise<CallPrimitiveOutcome> {
  const { input, deps, backend, prompt } = ctx;
  const writeCapability = ctx.writeCapability ?? "write_capable";
  const laneRef = { workflowId: input.workflowId, laneId: backend };
  const request: AgentCallRequest =
    backend === "claude"
      ? {
          kind: "conversation_turn",
          backend: "claude",
          prompt: prompt.prompt,
          laneRef,
          writeCapability,
          outputSchema: prompt.outputSchema,
        }
      : {
          kind: "task_run",
          backend: "codex",
          prompt: prompt.prompt,
          laneRef,
          writeCapability,
          outputSchema: prompt.outputSchema,
        };

  let result: AgentCallResult;
  try {
    result = await deps.laneScheduler.schedule(
      {
        sessionKey: input.sessionKey,
        writeCapability,
        workflowId: input.workflowId,
        laneId: backend,
      },
      () => deps.callAgent(request),
    );
  } catch (err) {
    return { kind: "failed", errorSummary: getErrorMessage(err) };
  }

  if (result.outcome.kind === "failed") {
    return {
      kind: "failed",
      errorSummary: `${result.outcome.error.failureKind}: ${result.outcome.error.message}`,
    };
  }
  if (result.outcome.kind === "paused") {
    return {
      kind: "failed",
      errorSummary: `unexpected pause from lane (pauseKind=${result.outcome.pauseKind}, resumeToken=${result.outcome.resumeToken})`,
    };
  }

  await deps.laneService.recordOutcome(
    laneRef,
    backend === "claude"
      ? {
          backend: "claude",
          ...(result.backendRef && result.backendRef.backend === "claude"
            ? { conversationId: result.backendRef.sessionId }
            : {}),
        }
      : {
          backend: "codex",
          ...(result.backendRef && result.backendRef.backend === "codex"
            ? { threadId: result.backendRef.threadId }
            : {}),
        },
  );

  return { kind: "ok", result };
}

type ParseSuccess<T> = { success: true; value: T };
type ParseFailure = { success: false; error: string };
type ParseOutcome<T> = ParseSuccess<T> | ParseFailure;

interface ParseSchema<T> {
  safeParse(value: unknown):
    | { success: true; data: T }
    | {
        success: false;
        error: {
          issues: ReadonlyArray<{
            path: ReadonlyArray<unknown>;
            message: string;
          }>;
        };
      };
}

function parseStructured<T>(
  artifactKind: string,
  flowAgent: CollaborationFlowAgent,
  result: AgentCallResult,
  schema: ParseSchema<T>,
): ParseOutcome<T> {
  if (result.outcome.kind !== "completed") {
    return {
      success: false,
      error: `${artifactKind} (${flowAgent}) did not complete (outcome=${result.outcome.kind})`,
    };
  }
  const parsed = schema.safeParse(result.outcome.structuredOutput);
  if (parsed.success) {
    return { success: true, value: parsed.data };
  }
  const summary = parsed.error.issues
    .map((i) => `${(i.path.join(".") || "$") as string}: ${i.message}`)
    .join("; ");
  return {
    success: false,
    error: `${artifactKind} (${flowAgent}) schema_validation: ${summary}`,
  };
}

// ============================================================
// Terminal branches.
// ============================================================

interface FailRunContext {
  input: AsymmetricCollaborationSliceInput;
  deps: AsymmetricCollaborationSliceDeps;
  now: () => string;
  flowAgent: CollaborationFlowAgent;
  errorSummary: string;
  tracker?: ArtifactTracker;
}

async function failRun(
  ctx: FailRunContext,
): Promise<Extract<AsymmetricCollaborationSliceResult, { kind: "failed" }>> {
  const { input, deps, now, flowAgent, errorSummary, tracker } = ctx;
  await updateEnvelope(input, deps, now, (existing) => {
    const previous = (existing.featureSnapshot ?? {}) as Record<
      string,
      unknown
    >;
    const featureSnapshot = tracker
      ? {
          ...previous,
          artifacts: [...tracker.artifacts],
          negotiationRoundsCompleted: tracker.negotiationRoundsCompleted,
        }
      : previous;
    return {
      ...existing,
      status: "failed" satisfies WorkflowEnvelopeStatus,
      phase: `failed_${flowAgent}`,
      errorSummary,
      featureSnapshot,
      updatedAt: now(),
    };
  });
  publishStatus(deps, input.workflowId, "failed", {
    kind: "asymmetric_failed",
    flowAgent,
    errorSummary,
  });
  deps.dispatchPush?.({
    kind: "failed",
    workflowId: input.workflowId,
    agent: flowAgent,
  });
  logger.error("collaboration.asymmetric.failed", {
    workflowId: input.workflowId,
    flowAgent,
    errorSummary,
  });
  return { kind: "failed", agent: flowAgent, errorSummary };
}

interface PauseForUserInputContext {
  input: AsymmetricCollaborationSliceInput;
  deps: AsymmetricCollaborationSliceDeps;
  now: () => string;
  reason:
    | "objective_disagreement"
    | "explicit_ask_user"
    | "rounds_exhausted_above_threshold"
    | "threshold_none_with_remaining";
  negotiationRoundsCompleted: number;
  tracker: ArtifactTracker;
  latestResolutionDecision: CollaborationResolutionDecisionOutput;
}

async function pauseForUserInput(
  ctx: PauseForUserInputContext,
): Promise<
  Extract<AsymmetricCollaborationSliceResult, { kind: "paused_for_user_input" }>
> {
  const {
    input,
    deps,
    now,
    reason,
    negotiationRoundsCompleted,
    tracker,
    latestResolutionDecision,
  } = ctx;
  const resumeToken = `${input.workflowId}-asymmetric-ask-user`;
  const pauseGate = pauseForHumanApproval({
    resumeToken,
    details: { reason },
  });
  const openConflicts: CollaborationOpenConflictsOutput = {
    kind: "open_conflicts",
    disagreements: latestResolutionDecision.remainingDisagreements,
    questions: latestResolutionDecision.userQuestions,
  };
  trackArtifact(tracker, openConflicts);
  await updateEnvelope(input, deps, now, (existing) => {
    const previous = (existing.featureSnapshot ?? {}) as Record<
      string,
      unknown
    >;
    return {
      ...existing,
      status: "paused" satisfies WorkflowEnvelopeStatus,
      phase: "asymmetric_paused_for_user",
      pause: {
        pauseKind: pauseGate.pauseKind,
        gateKind: pauseGate.kind,
        resumeToken: pauseGate.resumeToken,
        reason: "user_input_required",
        ...(pauseGate.details !== undefined
          ? { details: pauseGate.details }
          : {}),
      },
      featureSnapshot: {
        ...previous,
        artifacts: [...tracker.artifacts],
        negotiationRoundsCompleted: tracker.negotiationRoundsCompleted,
        currentOpenConflicts: openConflicts,
      },
      updatedAt: now(),
    };
  });
  publishStatus(deps, input.workflowId, "paused", {
    kind: "asymmetric_paused_for_user",
    reason,
  });
  deps.dispatchPush?.({
    kind: "paused-for-user-input",
    workflowId: input.workflowId,
  });
  logger.info("collaboration.asymmetric.paused", {
    workflowId: input.workflowId,
    reason,
  });
  return {
    kind: "paused_for_user_input",
    resumeToken,
    negotiationRoundsCompleted,
    reason,
  };
}

interface FinalizeFinalContext {
  input: AsymmetricCollaborationSliceInput;
  deps: AsymmetricCollaborationSliceDeps;
  now: () => string;
  finalAnswer: CollaborationFinalAnswerOutput;
  negotiationRoundsCompleted: number;
  tracker: ArtifactTracker;
}

async function finalizeFinal(
  ctx: FinalizeFinalContext,
): Promise<
  Extract<
    AsymmetricCollaborationSliceResult,
    { kind: "completed_final" } | { kind: "failed" }
  >
> {
  const { input, deps, now, finalAnswer, negotiationRoundsCompleted, tracker } =
    ctx;
  trackArtifact(tracker, finalAnswer);

  // Transcript writeback runs first so the user-facing answer survives any
  // downstream failure: `finalAnswer.report` and `supporting` are inline
  // content (markdown the UI renders as the collapsed audit), not on-disk
  // artifact paths. The artifact stream itself is the canonical record.
  if (input.conversationId && deps.appendTranscriptEntry) {
    try {
      await deps.appendTranscriptEntry(input.conversationId, {
        timestamp: now(),
        type: "assistant",
        role: "assistant",
        content: [{ type: "text", text: finalAnswer.answer }],
      });
    } catch (err) {
      logger.warn("collaboration.asymmetric.transcript_writeback_failed", {
        workflowId: input.workflowId,
        conversationId: input.conversationId,
        error: getErrorMessage(err),
      });
    }
  }

  if (input.conversationId && deps.markConversationAwaiting) {
    try {
      await deps.markConversationAwaiting(input.conversationId, {
        workflowId: input.workflowId,
        timestamp: now(),
      });
    } catch (err) {
      logger.warn(
        "collaboration.asymmetric.conversation_metadata_sync_failed",
        {
          workflowId: input.workflowId,
          conversationId: input.conversationId,
          error: getErrorMessage(err),
        },
      );
    }
  }

  if (input.conversationId && deps.updateConversationBackendRef) {
    const advancedRef = await readPrimaryLaneAdvancedRef(input, deps);
    if (advancedRef) {
      try {
        await deps.updateConversationBackendRef(
          input.conversationId,
          advancedRef,
        );
      } catch (err) {
        logger.warn(
          "collaboration.asymmetric.conversation_backendref_advance_failed",
          {
            workflowId: input.workflowId,
            conversationId: input.conversationId,
            error: getErrorMessage(err),
          },
        );
      }
    }
  }

  await updateEnvelope(input, deps, now, (existing) => {
    const previous = (existing.featureSnapshot ?? {}) as Record<
      string,
      unknown
    >;
    return {
      ...existing,
      status: "completed" satisfies WorkflowEnvelopeStatus,
      phase: "asymmetric_completed_final",
      featureSnapshot: {
        ...previous,
        artifacts: [...tracker.artifacts],
        negotiationRoundsCompleted: tracker.negotiationRoundsCompleted,
      },
      completedAt: now(),
      updatedAt: now(),
    };
  });
  publishStatus(deps, input.workflowId, "completed", {
    kind: "asymmetric_completed_final",
    negotiationRoundsCompleted,
  });
  deps.dispatchPush?.({
    kind: "completed-final",
    workflowId: input.workflowId,
  });
  logger.info("collaboration.asymmetric.completed_final", {
    workflowId: input.workflowId,
    negotiationRoundsCompleted,
  });

  return {
    kind: "completed_final",
    finalAnswerArtifactId: `${input.workflowId}-final-answer`,
    negotiationRoundsCompleted,
  };
}

interface FinalizeUserStoppedContext {
  input: AsymmetricCollaborationSliceInput;
  deps: AsymmetricCollaborationSliceDeps;
  now: () => string;
  negotiationRoundsCompleted: number;
  tracker: ArtifactTracker;
}

async function finalizeUserStopped(
  ctx: FinalizeUserStoppedContext,
): Promise<
  Extract<AsymmetricCollaborationSliceResult, { kind: "completed_unresolved" }>
> {
  const { input, deps, now, negotiationRoundsCompleted, tracker } = ctx;
  await updateEnvelope(input, deps, now, (existing) => {
    const previous = (existing.featureSnapshot ?? {}) as Record<
      string,
      unknown
    >;
    return {
      ...existing,
      status: "completed" satisfies WorkflowEnvelopeStatus,
      phase: "asymmetric_user_stopped",
      featureSnapshot: {
        ...previous,
        artifacts: [...tracker.artifacts],
        negotiationRoundsCompleted: tracker.negotiationRoundsCompleted,
      },
      completedAt: now(),
      updatedAt: now(),
    };
  });
  publishStatus(deps, input.workflowId, "completed", {
    kind: "asymmetric_user_stopped",
    negotiationRoundsCompleted,
  });
  deps.dispatchPush?.({
    kind: "completed-unresolved",
    workflowId: input.workflowId,
    reason: "user_stopped",
  });
  return {
    kind: "completed_unresolved",
    reason: "user_stopped",
    negotiationRoundsCompleted,
  };
}

interface RunResumeFinalAnswerContext {
  input: AsymmetricCollaborationSliceInput;
  deps: AsymmetricCollaborationSliceDeps;
  now: () => string;
  tracker: ArtifactTracker;
  backendForAgent: (agent: CollaborationFlowAgent) => CollaborationAgent;
  resumeArtifacts: CollaborationArtifact[];
  negotiationRoundsCompleted: number;
}

async function runResumeFinalAnswer(
  ctx: RunResumeFinalAnswerContext,
): Promise<AsymmetricCollaborationSliceResult> {
  const {
    input,
    deps,
    now,
    tracker,
    backendForAgent,
    resumeArtifacts,
    negotiationRoundsCompleted,
  } = ctx;

  tracker.artifacts.push(...resumeArtifacts);
  tracker.negotiationRoundsCompleted = negotiationRoundsCompleted;

  const agentOneInitialDraft = findInitialDraftByAgent(
    resumeArtifacts,
    "agent_one",
  );
  const agentTwoInitialDraft = findInitialDraftByAgent(
    resumeArtifacts,
    "agent_two",
  );
  const latestCounterProposal = findLatestCounterProposal(resumeArtifacts);
  const latestResolutionDecision =
    findLatestResolutionDecision(resumeArtifacts);

  if (
    !agentOneInitialDraft ||
    !agentTwoInitialDraft ||
    !latestCounterProposal ||
    !latestResolutionDecision
  ) {
    return failRun({
      input,
      deps,
      now,
      tracker,
      flowAgent: "agent_one",
      errorSummary:
        "resume requested but the persisted artifact stream is missing required prerequisites for the final-answer phase",
    });
  }

  const latestOpenConflicts = findLatestOpenConflicts(tracker.artifacts);
  const userAnswers = buildUserAnswerList(
    latestOpenConflicts,
    input.resume?.userAnswersByQuestionId,
  );
  const finalAnswerPrompt = buildAgentOneFinalAnswerPrompt({
    userPrompt: input.brief,
    ownDraft: agentOneInitialDraft,
    otherDraft: agentTwoInitialDraft,
    latestCounterProposal,
    latestResolutionDecision,
    artifactStream: [...tracker.artifacts],
    ...(latestOpenConflicts !== null
      ? { openConflicts: latestOpenConflicts }
      : {}),
    ...(userAnswers.length > 0 ? { userAnswers } : {}),
  });

  logger.info("collaboration.asymmetric.resume_short_circuit", {
    workflowId: input.workflowId,
    resumedArtifactCount: resumeArtifacts.length,
    userAnswerCount: userAnswers.length,
  });

  const finalAnswerCall = await callPrimitive({
    input,
    deps,
    flowAgent: "agent_one",
    backend: backendForAgent("agent_one"),
    prompt: finalAnswerPrompt,
  });
  if (finalAnswerCall.kind === "failed") {
    return failRun({
      input,
      deps,
      now,
      tracker,
      flowAgent: "agent_one",
      errorSummary: finalAnswerCall.errorSummary,
    });
  }
  const finalAnswer = parseStructured(
    "final_answer",
    "agent_one",
    finalAnswerCall.result,
    collaborationFinalAnswerOutputSchema,
  );
  if (!finalAnswer.success) {
    return failRun({
      input,
      deps,
      now,
      tracker,
      flowAgent: "agent_one",
      errorSummary: finalAnswer.error,
    });
  }
  return finalizeFinal({
    input,
    deps,
    now,
    tracker,
    finalAnswer: finalAnswer.value,
    negotiationRoundsCompleted,
  });
}

function findInitialDraftByAgent(
  artifacts: readonly CollaborationArtifact[],
  agent: CollaborationFlowAgent,
): CollaborationInitialDraftOutput | null {
  for (const artifact of artifacts) {
    if (artifact.kind === "initial_draft" && artifact.agent === agent) {
      return artifact;
    }
  }
  return null;
}

function findLatestCounterProposal(
  artifacts: readonly CollaborationArtifact[],
): CollaborationCounterProposalOutput | null {
  for (let i = artifacts.length - 1; i >= 0; i--) {
    const artifact = artifacts[i]!;
    if (artifact.kind === "counter_proposal") return artifact;
  }
  return null;
}

function findLatestResolutionDecision(
  artifacts: readonly CollaborationArtifact[],
): CollaborationResolutionDecisionOutput | null {
  for (let i = artifacts.length - 1; i >= 0; i--) {
    const artifact = artifacts[i]!;
    if (artifact.kind === "resolution_decision") return artifact;
  }
  return null;
}

function publishStatus(
  deps: AsymmetricCollaborationSliceDeps,
  workflowId: string,
  status: "running" | "paused" | "completed" | "failed",
  payload: Record<string, unknown>,
): void {
  deps.statusBus.publish({
    scope: COLLABORATION_SCOPE,
    scopeId: workflowId,
    status,
    payload,
  });
}
