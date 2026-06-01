/**
 * Workflow-scoped collaboration envelope.
 *
 * Sibling of the user-triggered `envelope.ts`. The round/collaborator-invocation
 * logic is duplicated locally (controlled duplication per design
 * §Envelope Extraction Decision) so the round loop never reaches
 * `pauseForHumanApproval()` and the no-pause invariant is a construction
 * guarantee, not a runtime check. The lint rule in `eslint.config.mjs`
 * enforces forbidden imports of:
 *
 *  - `@/lib/workflows/primitives/human-approval-gate`
 *  - `@/lib/workflows/collaboration/envelope`
 *
 * The phase sequence mirrors the user envelope (Initial Drafts → Cross-Review
 * → for each round: Proposed Changes → Counter-Proposal → Resolution Decision
 * → Final Answer) so the workflow-triggered run produces the same artifact
 * stream and resolution semantics as the user-triggered run. The collaborator
 * caller is injected; its production implementation lives in
 * `@/lib/workflow-graph/workflow-collaborator-caller`.
 *
 * Observability parity with the user envelope is achieved through:
 *
 *  - `statusBus.publish({ scope: "workflow_collaboration", ... })` — broadcasts
 *    every phase transition on the same SSE pipeline used by the rest of the
 *    dashboard (`scope: "workflow_collaboration"`, `scopeId: workflowId`). A
 *    missing bus disables broadcast; runtime in production always supplies one.
 *  - `appendTranscriptEntry` — when the run terminates with a final answer,
 *    the answer text is appended to the parent `conversationId` so consumers
 *    of the originating conversation transcript see the collaboration result
 *    inline.
 *  - Artifact stream persistence — every phase output is appended to the
 *    workflow `featureSnapshot.artifacts` array (parsed through the
 *    discriminated `CollaborationFeatureSnapshotWorkflow` schema) so the
 *    persisted record carries the full negotiation trail, not just the
 *    workflow-origin metadata.
 *
 * Terminal status is computed by composing the existing `decideCollaborationNextStep`
 * (policy) with `decisionToWorkflowResult` (translator), so the four-value
 * status enum is reachable only through one mapping table (research §10.1).
 */

import { createLogger } from "@/lib/logging";
import { getErrorMessage } from "@/lib/shared/errors";
import {
  resolvedCollaborationConfigSchema,
  workflowCollaborationResultSchema,
  type CollaborationAutonomousResolutionThreshold,
  type CollaborationCounterProposalOutput,
  type CollaborationCrossReviewOutput,
  type CollaborationFinalAnswerOutput,
  type CollaborationInitialDraftOutput,
  type CollaborationProposedChangesOutput,
  type CollaborationResolutionDecisionOutput,
  type ResolvedCollaborationConfig,
  type WorkflowCollaborationOpenConflict,
  type WorkflowCollaborationResult,
} from "@/lib/workflows/schemas";
import type { WorkflowEnvelope } from "@/lib/workflows/primitives/workflow-envelope-vocabulary";
import type { WorkflowEnvelopeStore } from "@/lib/workflows/primitives/workflow-envelope-store";
import type { StatusBus } from "@/lib/workflows/primitives/status-bus";
import type { TranscriptEntry } from "@/lib/prompt/transcript";
import type {
  CollaborationFeatureSnapshotWorkflow,
  CollaborationWorkflowArtifactEntry,
} from "./feature-snapshot";
import { decisionToWorkflowResult } from "./decision-to-workflow-result";
import type { CollaborationPolicyDecision } from "./policy";

const logger = createLogger("workflows.collaboration.workflow-envelope");

const WORKFLOW_TYPE = "workflow_collaboration";
const PHASE_RUNNING = "workflow_collaboration_running";
const PHASE_COMPLETED = "workflow_collaboration_completed";
// Use the same StatusBus scope as the user-triggered envelope so the SSE
// bridge (`publishScopedStatusEvent`) emits a `scoped-status` event whose
// `scope` field the dashboard's `NotificationListener` already routes to
// conversation/session/active-collaboration query invalidations. The
// `scopeId` is the workflow's `workflowId`; payload `kind` strings remain
// `workflow_collaboration_*` so workflow vs. user envelopes are still
// distinguishable in payload-aware consumers.
const COLLABORATION_SCOPE = "collaboration";

export interface WorkflowCollaborationStartArgs {
  brief: string;
  resolvedConfig: ResolvedCollaborationConfig;
  parentImplementerTurnId: string;
  executionContextId: string;
  conversationId: string;
  /**
   * Parent workflow execution id. Threaded onto the transcript writeback's
   * `origin.workflow.executionId` so consumers of the originating conversation
   * transcript can correlate the final answer back to the workflow run that
   * produced it.
   */
  executionId: string;
  /**
   * Implementer iteration index at the moment the collaboration was requested.
   * Threaded onto the transcript writeback's `origin.workflow.iterationIndex`
   * for the same reason as `executionId` — the implementer turn that triggered
   * the collaboration belongs to this iteration.
   */
  iterationIndex: number;
}

export interface WorkflowCollaborationInitialDraftsInput {
  brief: string;
}

export interface WorkflowCollaborationInitialDraftsOutput {
  agentOneDraft: CollaborationInitialDraftOutput;
  agentTwoDraft: CollaborationInitialDraftOutput;
}

export interface WorkflowCollaborationCrossReviewInput {
  brief: string;
  agentOneDraft: CollaborationInitialDraftOutput;
  agentTwoDraft: CollaborationInitialDraftOutput;
}

export interface WorkflowCollaborationCrossReviewOutput {
  agentTwoCrossReview: CollaborationCrossReviewOutput;
}

export interface WorkflowCollaborationRoundInput {
  round: number;
  brief: string;
  agentOneDraft: CollaborationInitialDraftOutput;
  agentTwoDraft: CollaborationInitialDraftOutput;
  agentTwoCrossReview: CollaborationCrossReviewOutput;
}

export interface WorkflowCollaborationRoundOutput {
  proposedChanges: CollaborationProposedChangesOutput;
  counterProposal: CollaborationCounterProposalOutput;
  resolution: CollaborationResolutionDecisionOutput;
}

export interface WorkflowCollaborationFinalAnswerInput {
  brief: string;
  agentOneDraft: CollaborationInitialDraftOutput;
  agentTwoDraft: CollaborationInitialDraftOutput;
  latestCounterProposal: CollaborationCounterProposalOutput;
  latestResolutionDecision: CollaborationResolutionDecisionOutput;
}

export interface WorkflowCollaborationFinalAnswerOutput {
  finalAnswer: CollaborationFinalAnswerOutput;
}

export interface WorkflowCollaborationCollaboratorCaller {
  runInitialDrafts(
    input: WorkflowCollaborationInitialDraftsInput,
  ): Promise<WorkflowCollaborationInitialDraftsOutput>;
  runCrossReview(
    input: WorkflowCollaborationCrossReviewInput,
  ): Promise<WorkflowCollaborationCrossReviewOutput>;
  runRound(
    input: WorkflowCollaborationRoundInput,
  ): Promise<WorkflowCollaborationRoundOutput>;
  generateFinalAnswer(
    input: WorkflowCollaborationFinalAnswerInput,
  ): Promise<WorkflowCollaborationFinalAnswerOutput>;
}

export type WorkflowCollaborationPolicyDecide = (input: {
  decision: CollaborationResolutionDecisionOutput;
  autonomousResolutionThreshold: CollaborationAutonomousResolutionThreshold;
  negotiationRoundsRemaining: number;
}) => CollaborationPolicyDecision;

export interface WorkflowCollaborationEnvelopeDeps {
  envelopeStore: WorkflowEnvelopeStore;
  policyDecide: WorkflowCollaborationPolicyDecide;
  collaboratorCaller: WorkflowCollaborationCollaboratorCaller;
  /**
   * Optional in-process status bus the envelope publishes phase events
   * through. Production callers wire the same bus the rest of the dashboard
   * consumes so consumers can subscribe to `scope: "workflow_collaboration"`
   * for live updates. Tests can omit or inject a fake bus.
   */
  statusBus?: StatusBus;
  /**
   * Optional transcript writeback. When set, the envelope appends the final
   * answer to the originating `conversationId` so the parent conversation
   * transcript shows the collaboration's resolution inline.
   */
  appendTranscriptEntry?(
    conversationId: string,
    entry: TranscriptEntry,
  ): Promise<void>;
  now?: () => string;
  workflowIdFactory?: () => string;
}

export interface WorkflowCollaborationStartOutput {
  result: WorkflowCollaborationResult;
  roundsConsumed: number;
}

export interface WorkflowCollaborationEnvelope {
  start(
    args: WorkflowCollaborationStartArgs,
  ): Promise<WorkflowCollaborationStartOutput>;
}

export function createWorkflowCollaborationEnvelope(
  deps: WorkflowCollaborationEnvelopeDeps,
): WorkflowCollaborationEnvelope {
  const now = deps.now ?? (() => new Date().toISOString());
  const workflowIdFactory =
    deps.workflowIdFactory ?? (() => crypto.randomUUID());

  function publishPhase(
    workflowId: string,
    status: "running" | "paused" | "completed" | "failed",
    payload: Record<string, unknown>,
  ): void {
    if (!deps.statusBus) return;
    deps.statusBus.publish({
      scope: COLLABORATION_SCOPE,
      scopeId: workflowId,
      status,
      payload,
    });
  }

  return {
    async start(args) {
      const workflowId = workflowIdFactory();
      const resolvedConfig = resolvedCollaborationConfigSchema.parse(
        args.resolvedConfig,
      );
      const negotiationRounds = resolvedConfig.negotiationRounds.value;
      const autonomousResolutionThreshold =
        resolvedConfig.autonomousResolutionThreshold.value;

      const artifacts: CollaborationWorkflowArtifactEntry[] = [];

      function snapshot(): CollaborationFeatureSnapshotWorkflow {
        return {
          origin: "workflow",
          parentImplementerTurnId: args.parentImplementerTurnId,
          executionContextId: args.executionContextId,
          conversationId: args.conversationId,
          resolvedConfig,
          artifacts: [...artifacts],
        };
      }

      const createdAt = now();
      await deps.envelopeStore.upsert(
        workflowId,
        (): WorkflowEnvelope => ({
          workflowId,
          workflowType: WORKFLOW_TYPE,
          status: "running",
          phase: PHASE_RUNNING,
          createdAt,
          updatedAt: createdAt,
          featureSnapshot: snapshot(),
        }),
      );

      publishPhase(workflowId, "running", {
        kind: "workflow_collaboration_started",
        parentImplementerTurnId: args.parentImplementerTurnId,
        executionContextId: args.executionContextId,
        conversationId: args.conversationId,
        negotiationRounds,
      });

      // Phase 1: Initial drafts (parallel).
      const { agentOneDraft, agentTwoDraft } =
        await deps.collaboratorCaller.runInitialDrafts({ brief: args.brief });
      artifacts.push({
        kind: "initial_draft",
        agent: "agent_one",
        value: agentOneDraft,
      });
      artifacts.push({
        kind: "initial_draft",
        agent: "agent_two",
        value: agentTwoDraft,
      });
      publishPhase(workflowId, "running", {
        kind: "workflow_collaboration_initial_drafts_completed",
        parentImplementerTurnId: args.parentImplementerTurnId,
      });
      logger.info("workflow-collab.initial_drafts.completed", {
        workflowId,
        parentImplementerTurnId: args.parentImplementerTurnId,
      });

      // Phase 2: Cross-review (agent_two only; agent_one's review is folded
      // into proposed_changes per the asymmetric flow contract).
      const { agentTwoCrossReview } =
        await deps.collaboratorCaller.runCrossReview({
          brief: args.brief,
          agentOneDraft,
          agentTwoDraft,
        });
      artifacts.push({
        kind: "cross_review",
        agent: "agent_two",
        value: agentTwoCrossReview,
      });
      publishPhase(workflowId, "running", {
        kind: "workflow_collaboration_cross_review_completed",
        parentImplementerTurnId: args.parentImplementerTurnId,
      });
      logger.info("workflow-collab.cross_review.completed", {
        workflowId,
        parentImplementerTurnId: args.parentImplementerTurnId,
      });

      // Phase 3: Negotiation rounds (proposed_changes → counter_proposal →
      // resolution_decision).
      const resolutions: CollaborationResolutionDecisionOutput[] = [];
      let latestCounterProposal: CollaborationCounterProposalOutput | null =
        null;
      let latestResolutionDecision: CollaborationResolutionDecisionOutput | null =
        null;
      let policyDecision: CollaborationPolicyDecision | null = null;

      for (let round = 1; round <= negotiationRounds; round++) {
        publishPhase(workflowId, "running", {
          kind: "workflow_collaboration_round_started",
          round,
          parentImplementerTurnId: args.parentImplementerTurnId,
        });
        const roundOutput = await deps.collaboratorCaller.runRound({
          round,
          brief: args.brief,
          agentOneDraft,
          agentTwoDraft,
          agentTwoCrossReview,
        });
        latestCounterProposal = roundOutput.counterProposal;
        latestResolutionDecision = roundOutput.resolution;
        resolutions.push(roundOutput.resolution);
        artifacts.push({
          kind: "proposed_changes",
          agent: "agent_one",
          round,
          value: roundOutput.proposedChanges,
        });
        artifacts.push({
          kind: "counter_proposal",
          agent: "agent_two",
          round,
          value: roundOutput.counterProposal,
        });
        artifacts.push({
          kind: "resolution_decision",
          agent: "agent_one",
          round,
          value: roundOutput.resolution,
        });

        const negotiationRoundsRemaining = negotiationRounds - round;
        const decision = deps.policyDecide({
          decision: roundOutput.resolution,
          autonomousResolutionThreshold,
          negotiationRoundsRemaining,
        });
        policyDecision = decision;

        publishPhase(workflowId, "running", {
          kind: "workflow_collaboration_round_completed",
          round,
          negotiationRoundsRemaining,
          policyKind: decision.kind,
          parentImplementerTurnId: args.parentImplementerTurnId,
        });

        logger.info("workflow-collab.policy_decision", {
          workflowId,
          round,
          negotiationRoundsRemaining,
          policyKind: decision.kind,
        });

        if (decision.kind === "continue_negotiation") continue;
        break;
      }

      if (
        !policyDecision ||
        !latestResolutionDecision ||
        !latestCounterProposal
      ) {
        throw new Error(
          "workflow collaboration envelope finished without a terminal policy decision",
        );
      }
      if (policyDecision.kind === "continue_negotiation") {
        throw new Error(
          "workflow collaboration envelope exhausted rounds with continue_negotiation as the last decision; the policy contract requires a terminal decision when rounds are exhausted",
        );
      }

      // Phase 4: Final answer (only on final policy decision).
      let finalAnswer: string | null = null;
      if (policyDecision.kind === "final") {
        const fa = await deps.collaboratorCaller.generateFinalAnswer({
          brief: args.brief,
          agentOneDraft,
          agentTwoDraft,
          latestCounterProposal,
          latestResolutionDecision,
        });
        finalAnswer = fa.finalAnswer.answer;
        artifacts.push({
          kind: "final_answer",
          agent: "agent_one",
          value: fa.finalAnswer,
        });
      }

      const openConflicts = buildOpenConflicts(policyDecision, resolutions);

      const result = decisionToWorkflowResult({
        decision: policyDecision,
        finalAnswer,
        openConflicts,
      });

      // Transcript writeback: append the final answer to the originating
      // conversation so the parent transcript shows the resolution inline.
      // Failures are logged but do not fail the run — the canonical answer
      // record is the envelope result and the persisted artifact stream.
      if (finalAnswer && args.conversationId && deps.appendTranscriptEntry) {
        try {
          await deps.appendTranscriptEntry(args.conversationId, {
            timestamp: now(),
            type: "assistant",
            role: "assistant",
            content: [{ type: "text", text: finalAnswer }],
            origin: {
              source: "workflow",
              workflow: {
                executionId: args.executionId,
                nodeId: args.executionContextId,
                iterationIndex: args.iterationIndex,
              },
            },
          });
        } catch (err) {
          logger.warn("workflow-collab.transcript_writeback_failed", {
            workflowId,
            conversationId: args.conversationId,
            error: getErrorMessage(err),
          });
        }
      }

      const completedAt = now();
      const completedSnapshot = snapshot();
      await deps.envelopeStore.upsert(
        workflowId,
        (existing): WorkflowEnvelope => {
          if (!existing) {
            throw new Error(
              `workflow collaboration envelope ${workflowId} disappeared between rounds`,
            );
          }
          return {
            ...existing,
            status: "completed",
            phase: PHASE_COMPLETED,
            updatedAt: completedAt,
            completedAt,
            featureSnapshot: completedSnapshot,
          };
        },
      );

      workflowCollaborationResultSchema.parse(result);
      const roundsConsumed = resolutions.length;
      const terminalStatusForBus =
        result.status === "converged" ? "completed" : "failed";
      publishPhase(workflowId, terminalStatusForBus, {
        kind: "workflow_collaboration_completed",
        status: result.status,
        negotiationRoundsConsumed: roundsConsumed,
        finalAnswer,
        openConflictsCount: openConflicts.length,
        parentImplementerTurnId: args.parentImplementerTurnId,
      });
      logger.info("workflow-collab.completed", {
        workflowId,
        status: result.status,
        negotiationRoundsConsumed: roundsConsumed,
      });
      return { result, roundsConsumed };
    },
  };
}

function buildOpenConflicts(
  policyDecision: CollaborationPolicyDecision,
  resolutions: ReadonlyArray<CollaborationResolutionDecisionOutput>,
): WorkflowCollaborationOpenConflict[] {
  if (policyDecision.kind === "final") return [];
  const lastResolution = resolutions[resolutions.length - 1];
  if (!lastResolution) return [];
  return lastResolution.remainingDisagreements.map((d) => ({
    rejectingAgent: "agent_one" as const,
    disputedPoint: d.claim,
    severity: d.severity,
    category: d.category,
  }));
}
