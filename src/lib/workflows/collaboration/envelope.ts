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

import { createLogger } from "@/lib/logging";
import { getErrorMessage } from "@/lib/shared/errors";
import type { AgentSessionRef } from "@/lib/shared/schemas";
import type { ConversationImageRef } from "@/lib/agent-backends/conversation";
import { pauseForHumanApproval } from "@/lib/workflows/primitives/human-approval-gate";
import type {
  AgentCallRequest,
  AgentCallResult,
} from "@/lib/workflows/primitives/agent-call-vocabulary";
import type { LaneService } from "@/lib/workflows/primitives/lane-service";
import {
  laneSessionRef,
  type LaneState,
} from "@/lib/workflows/primitives/lane-vocabulary";
import type { StatusBus } from "@/lib/events/status-bus";
import type {
  WorkflowEnvelope,
  WorkflowEnvelopeStatus,
} from "@/lib/workflows/primitives/workflow-envelope-vocabulary";
import type { WorkflowEnvelopeStore } from "@/lib/workflows/primitives/workflow-envelope-store";
import { buildAgentOneFinalAnswerPrompt } from "./prompt-builders";
import {
  agentOneLaneSeedRef,
  buildCollaborationLaneSeeds,
  oppositeCollaborationBackend,
} from "./backend-pair";
import {
  decideCollaborationNextStep,
  type CollaborationPolicyDecision,
} from "./policy";
import {
  collaborationFinalAnswerContentSchema,
  collaborationFinalAnswerOutputSchema,
  type CollaborationAgent,
  type CollaborationAgentsMap,
  type CollaborationArtifact,
  type CollaborationAutonomousResolutionThreshold,
  type CollaborationCounterProposalOutput,
  type CollaborationFinalAnswerOutput,
  type CollaborationFlowAgent,
  type CollaborationOpenConflictsOutput,
  type CollaborationResolutionDecisionOutput,
} from "./types";
import {
  produceCollaborationStep,
  trackArtifact,
  type ArtifactTracker,
} from "./helpers";
import {
  collaborationFailureClass,
  type CollaborationFailureCause,
} from "./failure-cause";
import {
  buildCollaborationStepLedger,
  type CollaborationStepLedger,
  type LedgerRejection,
} from "./step-ledger";
import type { CollaborationArtifactStreamRead } from "./artifacts-store";
import type { CollaborationSessionContext } from "./session-context";
import {
  findGeneratedArtifactRef,
  readGeneratedArtifactFile,
} from "./artifact-files";
import { runInitialDraftsPhase } from "./initial-draft";
import { runCrossReviewPhase } from "./cross-review";
import { runCounterProposalStep } from "./counter-proposal";
import {
  runProposedChangesStep,
  runResolutionDecisionStep,
} from "./resolution";

const logger = createLogger("workflows.collaboration.asymmetric-slice");

const COLLABORATION_WORKFLOW_TYPE = "collaboration";
const COLLABORATION_SCOPE = "collaboration";

export interface AsymmetricCollaborationSliceInput {
  workflowId: string;
  brief: string;
  imageRefs?: readonly ConversationImageRef[];
  worktreePath: string;
  /**
   * Stable scheduling key shared by every lane execution that touches the
   * same session worktree. Two write-capable lanes scheduled with the same
   * `sessionKey` are serialized by the LaneScheduler so they cannot mutate
   * the worktree concurrently.
   */
  sessionKey: string;
  /**
   * Agent One's backend — the originating conversation's agent. When `agents`
   * is present its `agent_one.backend` must agree with this; when absent,
   * Agent Two defaults to the opposite backend.
   */
  primaryAgentBackend: CollaborationAgent;
  /**
   * Both flow agents' fully resolved runtimes (backend, concrete model,
   * effort, fast mode, optional profile snapshot), resolved by the caller.
   * Authoritative for each lane's backend when present — including
   * same-backend pairs — and written into the envelope's feature snapshot so
   * the UI can label artifacts and resume can replay the exact settings.
   * Optional so test fixtures and legacy callers keep the default
   * opposite-backend derivation.
   */
  agents?: CollaborationAgentsMap;
  negotiationRounds: number;
  autonomousResolutionThreshold: CollaborationAutonomousResolutionThreshold;
  /**
   * The session's governing Alignment charter and linked-ticket view, captured
   * once at kickoff. Required so every caller makes an explicit context
   * decision: a run that silently omitted the charter would look identical to
   * one the session never had a charter for.
   */
  sessionContext: CollaborationSessionContext;
  /**
   * Optional originating conversation. When set and `appendTranscriptEntry`
   * is provided, the final answer body is appended back into the conversation
   * transcript as an assistant turn.
   */
  conversationId?: string;
  /**
   * The originating conversation's stored backend session ref. When present
   * and the backend matches `primaryAgentBackend`, the primary lane's
   * continuity `ref` is seeded with it so Agent One's first turn resumes the
   * prior session and inherits its full context. Backend mismatches are
   * silently ignored.
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
  /**
   * Which attempt of this workflow is running. Every durable write the slice
   * makes is fenced on it, so a superseded attempt that is still winding down
   * cannot mutate state its successor now owns.
   */
  attemptEpoch?: number;
  /**
   * The conversation turn generation this run claimed. Persisted so a later
   * resume can prove no other turn has been admitted in between.
   */
  claimedTurnGeneration?: number;
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
  /**
   * Lane-aware agent execution. Lane scheduling is owned by the
   * `WorkflowAgentCaller` behind this dep — the single acquisition point
   * (D16) — so the slice never schedules around it.
   */
  callAgent(request: AgentCallRequest): Promise<AgentCallResult>;
  laneService: LaneService;
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
   * Marks the originating conversation ready for the next prompt after the
   * collaboration reaches a terminal state. Metadata sync failures are logged
   * and do not invalidate the collaboration result.
   */
  markConversationAwaiting?(
    conversationId: string,
    input: { workflowId: string; timestamp: string },
  ): Promise<unknown>;
  /**
   * Hands the conversation back so the user can type again, fenced on the exact
   * attempt: a superseded attempt finishing late must not free a conversation
   * its successor now holds. Returns whether this call released it.
   */
  releaseConversationOwner?(
    conversationId: string,
    owner: { workflowId: string; attemptEpoch: number },
  ): Promise<boolean>;
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
  /**
   * Records the charter version both peers have now received on the
   * originating conversation, for the Alignment panel's stale detection.
   * Invoked once per run, after both initial drafts succeed — the first moment
   * the charter has actually reached both agents. Omit in tests that do not
   * assert on the seen-version record.
   */
  recordAlignmentSeen?(
    conversationId: string,
    alignmentVersion: number,
  ): Promise<void>;
  /**
   * Appends one artifact to the workflow's durable JSONL sidecar. Called once
   * per tracked artifact (via the tracker's append sink). The persisted
   * envelope blob carries only bounded lifecycle/config state; the sidecar is
   * the durable record. Omit in tests that do not assert on the sidecar.
   */
  appendArtifact?(
    workflowId: string,
    artifact: CollaborationArtifact,
  ): Promise<void>;
  /**
   * Reads the workflow's recorded artifact stream back from the durable
   * sidecar. Load-bearing on resume: it is the whole of what a re-entering run
   * knows about what already happened, and the slice may re-enter in a fresh
   * process. The STRICT read — absence, I/O failure and skipped lines kept
   * apart — because "no entries" and "could not read" must not both mean
   * "start over". Omit in tests that never resume.
   */
  readArtifactStream?(
    workflowId: string,
  ): Promise<CollaborationArtifactStreamRead<CollaborationArtifact>>;
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
    input.agents?.agent_two.backend ??
    oppositeCollaborationBackend(input.primaryAgentBackend);
  const backendForAgent = (
    agent: CollaborationFlowAgent,
  ): CollaborationAgent =>
    agent === "agent_one"
      ? (input.agents?.agent_one.backend ?? input.primaryAgentBackend)
      : agentTwoBackend;

  const tracker: ArtifactTracker = {
    artifacts: [],
    negotiationRoundsCompleted: 0,
    ...(deps.appendArtifact
      ? {
          appendSink: async (artifact: CollaborationArtifact) => {
            // Fenced like every other durable write: a superseded attempt that
            // appended here would put a duplicate key in the log and make the
            // next resume refuse the whole stream.
            const envelope = await deps.envelopeStore.read(input.workflowId);
            if (envelope !== null && !ownsAttempt(input, envelope)) {
              logger.warn("collaboration.asymmetric.fenced_append_refused", {
                workflowId: input.workflowId,
                attemptEpoch: input.attemptEpoch,
                artifactKind: artifact.kind,
              });
              return;
            }
            await deps.appendArtifact!(input.workflowId, artifact);
          },
        }
      : {}),
  };

  await initializeLanes(input, deps, now, backendForAgent);
  const { ledger, rejection } = await initializeEnvelope(input, deps, now);

  if (rejection !== null) {
    // Re-dispatching an untrusted stream would either bill a completed run a
    // second time or splice fresh upstream work onto stale downstream
    // artifacts. Neither is recoverable, so this is terminal.
    return failRun({
      input,
      deps,
      now,
      tracker,
      flowAgent: "agent_one",
      errorSummary: `recorded artifact stream is unusable (${rejection.code}); this collaboration cannot be resumed and must be restarted`,
      cause: { kind: "ledger_unusable", code: rejection.code },
    });
  }

  // Prior outputs seed the in-run accumulator WITHOUT the append sink: those
  // lines are already on disk, and re-appending them would corrupt the very
  // log the next re-entry reads.
  if (ledger !== null) {
    tracker.artifacts.push(...ledger.recorded);
    tracker.negotiationRoundsCompleted = ledger.negotiationRoundsCompleted;
  }

  publishStatus(deps, input.workflowId, "running", {
    kind: "asymmetric_started",
    primaryAgentBackend: input.primaryAgentBackend,
  });

  const initialDraftsOutcome = await runInitialDraftsPhase({
    input,
    deps,
    now,
    tracker,
    ledger,
    backendForAgent,
  });
  if (initialDraftsOutcome.kind === "failed") {
    return initialDraftsOutcome.result;
  }
  const { agentOneDraft, agentTwoDraft } = initialDraftsOutcome;

  if (input.stopSignal?.aborted) {
    return finalizeUserStopped({
      input,
      deps,
      now,
      tracker,
      negotiationRoundsCompleted: 0,
    });
  }

  const crossReviewOutcome = await runCrossReviewPhase({
    input,
    deps,
    now,
    tracker,
    ledger,
    backendForAgent,
    agentOneDraft,
    agentTwoDraft,
  });
  if (crossReviewOutcome.kind === "failed") {
    return crossReviewOutcome.result;
  }
  const crossReview = crossReviewOutcome.crossReview;

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

    const proposedChangesOutcome = await runProposedChangesStep({
      input,
      deps,
      now,
      tracker,
      ledger,
      backendForAgent,
      agentOneDraft,
      agentTwoDraft,
      round,
    });
    if (proposedChangesOutcome.kind === "failed") {
      return proposedChangesOutcome.result;
    }
    const proposedChanges = proposedChangesOutcome.proposedChanges;

    const counterProposalOutcome = await runCounterProposalStep({
      input,
      deps,
      now,
      tracker,
      ledger,
      backendForAgent,
      agentOneDraft,
      agentTwoDraft,
      crossReview,
      proposedChanges,
      round,
    });
    if (counterProposalOutcome.kind === "failed") {
      return counterProposalOutcome.result;
    }
    const counterProposal = counterProposalOutcome.counterProposal;
    latestCounterProposal = counterProposal;

    const resolutionOutcome = await runResolutionDecisionStep({
      input,
      deps,
      now,
      tracker,
      ledger,
      backendForAgent,
      agentOneDraft,
      agentTwoDraft,
      proposedChanges,
      counterProposal,
      round,
    });
    if (resolutionOutcome.kind === "failed") {
      return resolutionOutcome.result;
    }
    const resolution = resolutionOutcome.resolution;
    latestResolutionDecision = resolution;
    roundsCompleted = round;
    tracker.negotiationRoundsCompleted = round;

    const negotiationRoundsRemaining = input.negotiationRounds - round;
    policyDecision = decideCollaborationNextStep({
      decision: resolution,
      autonomousResolutionThreshold: input.autonomousResolutionThreshold,
      negotiationRoundsRemaining,
    });

    logger.info("collaboration.asymmetric.policy_decision", {
      workflowId: input.workflowId,
      round,
      negotiationRoundsRemaining,
      policyKind: policyDecision.kind,
      nextAction: resolution.next_action,
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
        "agent_one returned next_action=fail",
    });
  }

  if (policyDecision.kind === "ask_user") {
    // A gate is asked once per round. A recorded `open_conflicts` for this
    // round PLUS an explicit resume payload means the user was shown the
    // questions and chose to proceed — the pause was persisted before the
    // resume token that authorized this re-entry was ever handed out. Without
    // that payload the artifact alone proves only that questions were
    // generated, so the run pauses again rather than assuming consent.
    const gateAlreadyServed =
      input.resume !== undefined &&
      ledger?.replay({ kind: "open_conflicts", round: roundsCompleted }) !=
        null;
    if (!gateAlreadyServed) {
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
  }

  // policyDecision.kind === "final"
  const latestOpenConflicts = findLatestOpenConflicts(tracker.artifacts);
  const userAnswers = buildUserAnswerList(
    latestOpenConflicts,
    input.resume?.userAnswersByQuestionId,
  );
  const finalAnswerPrompt = buildAgentOneFinalAnswerPrompt({
    userPrompt: input.brief,
    ownDraft: agentOneDraft,
    otherDraft: agentTwoDraft,
    latestCounterProposal: latestCounterProposal,
    latestResolutionDecision: latestResolutionDecision,
    workflowId: input.workflowId,
    round: roundsCompleted,
    artifactStream: [...tracker.artifacts],
    ...(latestOpenConflicts !== null
      ? { openConflicts: latestOpenConflicts }
      : {}),
    ...(userAnswers.length > 0 ? { userAnswers } : {}),
  });
  const finalAnswerStep =
    await produceCollaborationStep<CollaborationFinalAnswerOutput>({
      input,
      deps,
      ledger,
      key: { kind: "final_answer" },
      flowAgent: "agent_one",
      backend: backendForAgent("agent_one"),
      prompt: finalAnswerPrompt,
      contentSchema: collaborationFinalAnswerContentSchema,
      fullSchema: collaborationFinalAnswerOutputSchema,
      injection: {
        kind: "final_answer",
        agent: "agent_one",
        round: roundsCompleted,
      },
    });
  if (finalAnswerStep.kind === "failed") {
    return failRun({
      input,
      deps,
      now,
      tracker,
      flowAgent: "agent_one",
      errorSummary: finalAnswerStep.errorSummary,
      cause: finalAnswerStep.cause,
    });
  }

  return await finalizeFinal({
    input,
    deps,
    now,
    tracker,
    finalAnswer: finalAnswerStep.artifact,
    alreadyRecorded: finalAnswerStep.kind === "replayed",
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
  backendForAgent: (agent: CollaborationFlowAgent) => CollaborationAgent,
): Promise<void> {
  // Only agent_one inherits the originating conversation's ref; agent_two
  // always starts fresh — even when both agents run the same backend.
  const seeds = buildCollaborationLaneSeeds({
    workflowId: input.workflowId,
    writeCapability: "write_capable",
    policy: { continuityEnabled: true },
    lastUsedAt: now(),
    backendFor: backendForAgent,
    seedRefFor: (agent) =>
      agent === "agent_one"
        ? agentOneLaneSeedRef(
            backendForAgent("agent_one"),
            input.priorBackendRef,
          )
        : null,
  });
  for (const seed of seeds) {
    await initializeLaneIfMissing(deps, seed);
  }
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
    laneId: "agent_one",
  });
  if (!lane) return null;
  return laneSessionRef(lane);
}

interface InitializeEnvelopeOutcome {
  /**
   * The prior attempt's recorded outputs, or null for a run with no usable
   * history. Every step consults it before dispatching, so a re-entering run
   * pays the model only for what never completed.
   */
  ledger: CollaborationStepLedger | null;
  /** Set when a recorded stream exists but cannot be trusted to replay. The
   *  run fails terminally rather than re-dispatching as if it were fresh. */
  rejection: LedgerRejection | null;
}

async function initializeEnvelope(
  input: AsymmetricCollaborationSliceInput,
  deps: AsymmetricCollaborationSliceDeps,
  now: () => string,
): Promise<InitializeEnvelopeOutcome> {
  const timestamp = now();

  // The recorded stream comes from the durable sidecar, not the envelope blob:
  // the slice may re-enter in a fresh process, so this read MUST come from
  // durable storage. Read before the upsert so the mutator sees a settled
  // decision.
  const read = deps.readArtifactStream
    ? await deps.readArtifactStream(input.workflowId)
    : ({ kind: "absent" } as const);

  let ledger: CollaborationStepLedger | null = null;
  let rejection: LedgerRejection | null = null;

  if (read.kind === "unreadable") {
    rejection = { code: "unreadable", detail: read.error };
  } else if (read.kind === "ok") {
    const outcome = buildCollaborationStepLedger({
      stream: read.entries,
      negotiationRounds: input.negotiationRounds,
      corruptLineIndexes: read.skipped,
    });
    if (outcome.kind === "ok") ledger = outcome.ledger;
    else if (outcome.kind === "unusable") rejection = outcome.reason;
  }

  await deps.envelopeStore.upsert(input.workflowId, (existing) => {
    const previousSnapshot = (existing?.featureSnapshot ?? {}) as Record<
      string,
      unknown
    >;
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
        ...(input.agents !== undefined ? { agents: input.agents } : {}),
        negotiationRounds: input.negotiationRounds,
        // Derived from the recorded stream when there is one, so the counter
        // can never disagree with the log it summarizes.
        negotiationRoundsCompleted:
          ledger?.negotiationRoundsCompleted ?? previousRoundsCompleted,
        autonomousResolutionThreshold: input.autonomousResolutionThreshold,
        // The run's captured premises. Written on every entry with the same
        // snapshot the caller resolved once — on resume that is the value
        // parsed back out of this field, so the record never drifts.
        sessionContext: input.sessionContext,
        userAnswersByQuestionId: mergedAnswers,
        ...(input.conversationId !== undefined
          ? { conversationId: input.conversationId }
          : {}),
        ...(input.attemptEpoch !== undefined
          ? { attemptEpoch: input.attemptEpoch }
          : {}),
        ...(input.claimedTurnGeneration !== undefined
          ? { claimedTurnGeneration: input.claimedTurnGeneration }
          : {}),
        // Durable image replay refs. Without these a resumed run that must
        // re-run an initial draft would send a different prompt than the one
        // the original attempt sent.
        ...(input.imageRefs !== undefined
          ? { imageRefs: input.imageRefs }
          : {}),
      },
    };
  });

  return { ledger, rejection };
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

export async function persistArtifactsSnapshot(
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
        negotiationRoundsCompleted: tracker.negotiationRoundsCompleted,
      },
      updatedAt: now(),
    };
  });
  // Broadcast a progress envelope so SSE consumers can refetch the envelope
  // between lifecycle transitions. Without this, the inline collab UI sticks
  // on whatever phase the last lifecycle event reported (typically the
  // initial "drafting" frame) until the run pauses, completes, or fails.
  const latestArtifact = tracker.artifacts[tracker.artifacts.length - 1];
  publishStatus(deps, input.workflowId, "running", {
    kind: "asymmetric_progress",
    artifactCount: tracker.artifacts.length,
    negotiationRoundsCompleted: tracker.negotiationRoundsCompleted,
    ...(latestArtifact !== undefined
      ? { latestArtifactKind: latestArtifact.kind }
      : {}),
  });
}

/**
 * Whether this attempt is still the one the envelope belongs to.
 *
 * Terminal status alone cannot answer it. Once a resume moves the envelope back
 * to `running`, a superseded attempt's late write would pass a status check and
 * clobber its successor's state — status is not worker identity. The epoch is.
 */
function ownsAttempt(
  input: AsymmetricCollaborationSliceInput,
  existing: WorkflowEnvelope,
): boolean {
  if (input.attemptEpoch === undefined) return true;
  const snapshot = existing.featureSnapshot;
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    return true;
  }
  const recorded = (snapshot as Record<string, unknown>)["attemptEpoch"];
  if (typeof recorded !== "number") return true;
  return recorded === input.attemptEpoch;
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
    if (!ownsAttempt(input, existing)) {
      logger.warn("collaboration.asymmetric.fenced_write_refused", {
        workflowId: input.workflowId,
        attemptEpoch: input.attemptEpoch,
      });
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
// Terminal branches.
// ============================================================

export interface FailRunContext {
  input: AsymmetricCollaborationSliceInput;
  deps: AsymmetricCollaborationSliceDeps;
  now: () => string;
  flowAgent: CollaborationFlowAgent;
  errorSummary: string;
  /**
   * Why the run failed, in the vocabulary that decides whether the user is
   * offered a resume. Defaults to `unhandled` (operational) so a caller that
   * has not yet been taught the distinction errs toward letting the user try
   * again rather than silently declaring the work unrecoverable.
   */
  cause?: CollaborationFailureCause;
  tracker?: ArtifactTracker;
}

export async function failRun(
  ctx: FailRunContext,
): Promise<Extract<AsymmetricCollaborationSliceResult, { kind: "failed" }>> {
  const { input, deps, now, flowAgent, errorSummary, tracker } = ctx;
  const cause: CollaborationFailureCause = ctx.cause ?? { kind: "unhandled" };
  const failureClass = collaborationFailureClass(cause);
  const timestamp = now();
  await updateEnvelope(input, deps, now, (existing) => {
    const previous = (existing.featureSnapshot ?? {}) as Record<
      string,
      unknown
    >;
    const featureSnapshot = {
      ...previous,
      ...(tracker
        ? { negotiationRoundsCompleted: tracker.negotiationRoundsCompleted }
        : {}),
      failureCause: cause,
      failureClass,
    };
    return {
      ...existing,
      status: "failed" satisfies WorkflowEnvelopeStatus,
      phase: `failed_${flowAgent}`,
      errorSummary,
      featureSnapshot,
      updatedAt: timestamp,
    };
  });
  await markOriginatingConversationAwaiting(input, deps, timestamp, {
    reason: "failed",
    errorSummary,
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
    round: negotiationRoundsCompleted,
    summary: "Collaboration requires user clarification.",
    disagreements: latestResolutionDecision.remaining_disagreements,
    questions: latestResolutionDecision.user_questions,
  };
  await trackArtifact(tracker, openConflicts);
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
  /** True when the artifact came from the recorded log rather than a fresh
   *  call. Its line is already on disk, so committing it again would put two
   *  `final_answer` entries in the stream and make the next read unusable. */
  alreadyRecorded?: boolean;
  negotiationRoundsCompleted: number;
  tracker: ArtifactTracker;
}

export async function finalizeFinal(
  ctx: FinalizeFinalContext,
): Promise<
  Extract<
    AsymmetricCollaborationSliceResult,
    { kind: "completed_final" } | { kind: "failed" }
  >
> {
  const { input, deps, now, finalAnswer, negotiationRoundsCompleted, tracker } =
    ctx;
  if (ctx.alreadyRecorded !== true) {
    await trackArtifact(tracker, finalAnswer);
  }

  const answerRef = findGeneratedArtifactRef(
    finalAnswer,
    finalAnswer.answer_artifact_id,
  );
  if (!answerRef) {
    return failRun({
      input,
      deps,
      now,
      tracker,
      flowAgent: "agent_one",
      errorSummary:
        "final_answer (agent_one) artifact_files: missing answer artifact ref",
    });
  }

  let finalAnswerText = "";
  try {
    finalAnswerText = await readGeneratedArtifactFile(
      input.worktreePath,
      answerRef,
    );
  } catch (err) {
    return failRun({
      input,
      deps,
      now,
      tracker,
      flowAgent: "agent_one",
      errorSummary: `final_answer (agent_one) artifact_files: ${getErrorMessage(err)}`,
    });
  }

  // Transcript writeback runs first so the user-facing answer survives any
  // downstream failure. The answer body lives in the generated markdown file;
  // the structured artifact stores only the file reference.
  if (input.conversationId && deps.appendTranscriptEntry) {
    try {
      await deps.appendTranscriptEntry(input.conversationId, {
        timestamp: now(),
        type: "assistant",
        role: "assistant",
        content: [{ type: "text", text: finalAnswerText }],
      });
    } catch (err) {
      logger.warn("collaboration.asymmetric.transcript_writeback_failed", {
        workflowId: input.workflowId,
        conversationId: input.conversationId,
        error: getErrorMessage(err),
      });
    }
  }

  await releaseOriginatingConversationOwner(input, deps);

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
    finalAnswerArtifactId: `${input.workflowId}:final_answer:${finalAnswer.round}:answer`,
    negotiationRoundsCompleted,
  };
}

async function markOriginatingConversationAwaiting(
  input: Pick<
    AsymmetricCollaborationSliceInput,
    "conversationId" | "workflowId" | "attemptEpoch"
  >,
  deps: Pick<
    AsymmetricCollaborationSliceDeps,
    "markConversationAwaiting" | "releaseConversationOwner"
  >,
  timestamp: string,
  logContext: { reason: "failed" | "user_stopped"; errorSummary?: string },
): Promise<void> {
  if (!input.conversationId) return;

  await releaseOriginatingConversationOwner(input, deps);

  if (!deps.markConversationAwaiting) return;

  try {
    await deps.markConversationAwaiting(input.conversationId, {
      workflowId: input.workflowId,
      timestamp,
    });
  } catch (err) {
    logger.warn("collaboration.asymmetric.conversation_metadata_sync_failed", {
      workflowId: input.workflowId,
      conversationId: input.conversationId,
      reason: logContext.reason,
      ...(logContext.errorSummary
        ? { errorSummary: logContext.errorSummary }
        : {}),
      error: getErrorMessage(err),
    });
  }
}

/**
 * Free the conversation for the next prompt. Idempotent and attempt-fenced, so
 * a late release from a superseded attempt is a no-op rather than a hand-back
 * of a conversation its successor is actively using.
 */
async function releaseOriginatingConversationOwner(
  input: Pick<
    AsymmetricCollaborationSliceInput,
    "conversationId" | "workflowId" | "attemptEpoch"
  >,
  deps: Pick<AsymmetricCollaborationSliceDeps, "releaseConversationOwner">,
): Promise<void> {
  if (!input.conversationId || !deps.releaseConversationOwner) return;
  if (input.attemptEpoch === undefined) return;
  try {
    await deps.releaseConversationOwner(input.conversationId, {
      workflowId: input.workflowId,
      attemptEpoch: input.attemptEpoch,
    });
  } catch (err) {
    logger.warn("collaboration.asymmetric.conversation_release_failed", {
      workflowId: input.workflowId,
      conversationId: input.conversationId,
      error: getErrorMessage(err),
    });
  }
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
  const timestamp = now();
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
        negotiationRoundsCompleted: tracker.negotiationRoundsCompleted,
      },
      completedAt: timestamp,
      updatedAt: timestamp,
    };
  });
  await markOriginatingConversationAwaiting(input, deps, timestamp, {
    reason: "user_stopped",
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
