/**
 * Production `WorkflowCollaborationCollaboratorCaller`.
 *
 * Drives the controlled duplication of the user-envelope phase sequence at
 * workflow scope (design §Envelope Extraction Decision). Every phase is
 * implemented by composing the canonical prompt builders in
 * `@/lib/workflows/collaboration/prompt-builders` with the AgentCall
 * `task_run` primitive so the structured outputs are validated through the
 * authoritative Zod schemas.
 *
 * Calls flow through `WorkflowAgentCaller` (not bare `executeAgentCall`) so
 * each phase participates in the same lane bookkeeping, post-turn outcome
 * recording, and continuity handling that the rest of workflow agent activity
 * uses. The envelope owns the workflow-scoped `LaneService` and seeds the
 * configured backend pair before the first call; subsequent calls reuse
 * those lanes through `agent_one`'s and `agent_two`'s opposite-backend
 * mapping. This is what wires collaboration sub-calls into the "normal
 * workflow agent activity" path observable by the lane service, SSE status
 * bus, and the envelope's transcript writeback.
 *
 * Phase sequence (mirrors the user envelope):
 *
 *   1. `runInitialDrafts`  — agent_one + agent_two draft in parallel
 *      (`CollaborationInitialDraftOutput`).
 *   2. `runCrossReview`    — agent_two cross-reviews both drafts
 *      (`CollaborationCrossReviewOutput`). agent_one's review is folded into
 *      its `proposed_changes` artifact in each round, per
 *      `COLLABORATION_MODE_FLOW.md`.
 *   3. `runRound`          — for each negotiation round:
 *        a. agent_one emits `proposed_changes`
 *        b. agent_two emits `counter_proposal`
 *        c. agent_one emits `resolution_decision`
 *   4. `generateFinalAnswer` — agent_one writes the final answer over the
 *      drafts + the latest counter-proposal/resolution decision.
 *
 * Agent backends mirror the user envelope's contract: `agent_one` and
 * `agent_two` run on opposite backends. Configuration only carries the
 * `secondAgent` (`agent_two`); `agent_one` is derived as the opposite.
 */

import { createLogger } from "@/lib/logging";
import type { AgentBackendId } from "@/lib/shared/schemas";
import {
  buildCollaborationLaneSeeds,
  oppositeCollaborationBackend,
} from "@/lib/workflows/collaboration/backend-pair";
import type {
  AgentCallRequest,
  AgentCallResult,
} from "@/lib/workflows/primitives/agent-call-vocabulary";
import type { LaneService } from "@/lib/workflows/primitives/lane-service";
import type { WorkflowAgentCaller } from "@/lib/workflows/primitives/workflow-agent-caller";
import {
  buildAgentOneFinalAnswerPrompt,
  buildAgentOneInitialDraftPrompt,
  buildAgentOneProposedChangesPrompt,
  buildAgentOneResolutionDecisionPrompt,
  buildAgentTwoCounterProposalPrompt,
  buildAgentTwoCrossReviewPrompt,
  buildAgentTwoInitialDraftPrompt,
  type BuiltCollaborationPrompt,
} from "@/lib/workflows/collaboration/prompt-builders";
import {
  findGeneratedArtifactRef,
  readGeneratedArtifactFile,
  validateGeneratedArtifactFiles,
} from "@/lib/workflows/collaboration/artifact-files";
import {
  parseAndInjectArtifact,
  type ArtifactInjection,
  type ParseSchema,
} from "@/lib/workflows/collaboration/helpers";
import type { WorkflowCollaborationCollaboratorCaller } from "@/lib/workflows/collaboration/workflow-envelope";
import {
  collaborationCounterProposalContentSchema,
  collaborationCounterProposalOutputSchema,
  collaborationCrossReviewContentSchema,
  collaborationCrossReviewOutputSchema,
  collaborationFinalAnswerContentSchema,
  collaborationFinalAnswerOutputSchema,
  collaborationInitialDraftContentSchema,
  collaborationInitialDraftOutputSchema,
  collaborationProposedChangesContentSchema,
  collaborationProposedChangesOutputSchema,
  collaborationResolutionDecisionContentSchema,
  collaborationResolutionDecisionOutputSchema,
  type ResolvedCollaborationConfig,
} from "@/lib/workflow-graph/collaboration-schemas";

const logger = createLogger("workflow-graph.workflow-collaborator-caller");

const AGENT_ONE_INITIAL_DRAFT_SYSTEM_INSTRUCTIONS = [
  "You are agent_one in a workflow-scoped collaboration run.",
  "Write the full draft into the required generated artifact file before returning structured output.",
  "Produce a single CollaborationInitialDraftOutput JSON object containing only short bounded manifest fields and generated artifact references.",
].join("\n");

const AGENT_TWO_INITIAL_DRAFT_SYSTEM_INSTRUCTIONS = [
  "You are agent_two in a workflow-scoped collaboration run.",
  "Write the full draft into the required generated artifact file before returning structured output.",
  "Produce a single CollaborationInitialDraftOutput JSON object containing only short bounded manifest fields and generated artifact references.",
].join("\n");

const AGENT_TWO_CROSS_REVIEW_SYSTEM_INSTRUCTIONS = [
  "You are agent_two in a workflow-scoped collaboration run.",
  "Read both initial drafts and write the full review into the required generated artifact file before returning structured output.",
  "Emit a single CollaborationCrossReviewOutput JSON object containing only short bounded manifest fields and generated artifact references.",
  "Classify each disagreement as objective or implementation, and assign minor|major|blocking severity.",
].join("\n");

const AGENT_ONE_PROPOSED_CHANGES_SYSTEM_INSTRUCTIONS = [
  "You are agent_one in a workflow-scoped collaboration round.",
  "Write the full proposed-changes analysis into the required generated artifact file before returning structured output.",
  "Emit a single CollaborationProposedChangesOutput JSON object containing only short bounded manifest fields, concrete ids, and generated artifact references.",
].join("\n");

const AGENT_TWO_COUNTER_PROPOSAL_SYSTEM_INSTRUCTIONS = [
  "You are agent_two in a workflow-scoped collaboration round.",
  "Write the full counter-proposal into the required generated artifact file before returning structured output.",
  "Emit a single CollaborationCounterProposalOutput JSON object containing only short bounded manifest fields, concrete ids, and generated artifact references.",
  "Accept or reject every proposed change id, offer alternatives when warranted, and fold your prior cross-review points into agree/disagree as needed.",
].join("\n");

const AGENT_ONE_RESOLUTION_DECISION_SYSTEM_INSTRUCTIONS = [
  "You are agent_one in a workflow-scoped collaboration round.",
  "You are the authoritative resolver. Write the full resolution analysis into the required generated artifact file before returning structured output.",
  "Emit a single CollaborationResolutionDecisionOutput JSON object based on the LATEST counter-proposal for this round.",
  'Choose next_action="final" only when the brief is resolved. Use "continue_negotiation" when implementation disagreements remain and rounds remain; "ask_user" when objective disagreements remain or implementation disagreements exceed the autonomous threshold; "fail" only when the run cannot proceed.',
  "Every remaining_disagreement MUST include category (objective|implementation) and severity (minor|major|blocking).",
].join("\n");

const AGENT_ONE_FINAL_ANSWER_SYSTEM_INSTRUCTIONS = [
  "You are agent_one in a workflow-scoped collaboration run.",
  "Write the user-facing final answer into answer.md and the audit into audit.md before returning structured output.",
  "Synthesize a single CollaborationFinalAnswerOutput JSON object containing only short bounded manifest fields and generated artifact references.",
  'Set answer_artifact_id="answer" and audit_artifact_id="audit".',
].join("\n");

export interface WorkflowCollaboratorCallerInput {
  resolvedConfig: ResolvedCollaborationConfig;
  worktreePath: string;
  brief: string;
  parentImplementerTurnId: string;
  executionContextId: string;
  conversationId: string;
  /**
   * Identifier scoping this collaboration's lanes and SSE/status routing.
   * Owned by the envelope (the workflow-collab workflowId).
   */
  workflowId: string;
  /**
   * Session-scope lane scheduling key. Must match the key the agentCaller's
   * underlying `WorkflowAgentCaller` was constructed against so write-capable
   * lanes serialize at session level.
   */
  sessionKey: string;
  /**
   * Production `WorkflowAgentCaller` wired against the same `LaneService`
   * supplied here. Tests inject a fake to capture per-call lane refs.
   */
  agentCaller: WorkflowAgentCaller;
  /**
   * Lane service the envelope uses to seed `agent_one`/`agent_two` lanes
   * before the first call. Sharing it with the agentCaller's WAC means
   * post-turn lane outcomes recorded by WAC land here.
   */
  laneService: LaneService;
  now?: () => string;
}

export function createWorkflowCollaboratorCaller(
  input: WorkflowCollaboratorCallerInput,
): WorkflowCollaborationCollaboratorCaller {
  const agentTwoConfig = input.resolvedConfig.secondAgent.value;
  const agentTwoBackend = agentTwoConfig.backend;
  const agentOneBackend = oppositeCollaborationBackend(agentTwoBackend);
  // Resolved per-field config from `resolveCollaborationConfigWithProvenance`
  // configures agent_two only; agent_one runs on the opposite backend without
  // explicit overrides so the underlying task runner uses its defaults.
  const agentTwoModelId = agentTwoConfig.model;
  const agentTwoReasoningEffort = agentTwoConfig.reasoningEffort;
  const now = input.now ?? (() => new Date().toISOString());

  let lanesInitialized = false;
  async function ensureLanesInitialized(): Promise<void> {
    if (lanesInitialized) return;
    const seedTs = now();
    const laneSeeds = buildCollaborationLaneSeeds({
      workflowId: input.workflowId,
      writeCapability: "write_capable",
      policy: { continuityEnabled: false },
      lastUsedAt: seedTs,
      seedRefFor: () => null,
    });
    for (const lane of laneSeeds) {
      const existing = await input.laneService.resolve({
        workflowId: lane.workflowId,
        laneId: lane.laneId,
      });
      if (!existing) await input.laneService.initialize(lane);
    }
    lanesInitialized = true;
  }

  async function runStructuredCall(args: {
    backend: AgentBackendId;
    built: BuiltCollaborationPrompt;
    systemInstructions: string;
    agent: "agent_one" | "agent_two";
    phase: string;
    round?: number;
  }): Promise<AgentCallResult> {
    await ensureLanesInitialized();
    const laneRef = {
      workflowId: input.workflowId,
      laneId: args.backend,
    } as const;
    const isAgentTwoCall = args.agent === "agent_two";
    const agentCallRequest: AgentCallRequest = {
      kind: "task_run",
      backend: args.backend,
      prompt: args.built.prompt,
      systemInstructions: args.systemInstructions,
      outputSchema: args.built.outputSchema,
      laneRef,
      ...(isAgentTwoCall ? { modelId: agentTwoModelId } : {}),
      ...(isAgentTwoCall ? { reasoningEffort: agentTwoReasoningEffort } : {}),
    };
    logger.info("workflow-collab.call.invoking", {
      backend: args.backend,
      agent: args.agent,
      phase: args.phase,
      round: args.round,
      workflowId: input.workflowId,
      parentImplementerTurnId: input.parentImplementerTurnId,
      executionContextId: input.executionContextId,
      conversationId: input.conversationId,
    });
    return input.agentCaller.call({
      laneRef,
      sessionKey: input.sessionKey,
      writeCapability: "write_capable",
      agentCallRequest,
    });
  }

  function failureWhy(result: AgentCallResult): string {
    if (result.outcome.kind === "failed") {
      return result.outcome.error.message;
    }
    return `unexpected outcome kind: ${result.outcome.kind}`;
  }

  // Parses the model-authored content for one phase and injects the
  // orchestrator-owned bookkeeping (envelope kind/agent/target_agent/round and
  // each generated artifact's round/agent/phase) to reconstruct the full
  // artifact, mirroring the asymmetric slice's `parseAndInjectArtifact` path.
  function parseArtifact<F>(
    result: AgentCallResult,
    label: string,
    contentSchema: ParseSchema<unknown>,
    fullSchema: ParseSchema<F>,
    injection: ArtifactInjection,
  ): F {
    if (result.outcome.kind !== "completed") {
      throw new Error(
        `workflow collaborator ${label} did not complete: ${failureWhy(result)}`,
      );
    }
    const outcome = parseAndInjectArtifact(injection.agent, result, {
      contentSchema,
      fullSchema,
      injection,
    });
    if (!outcome.success) {
      throw new Error(`workflow collaborator ${label}: ${outcome.error}`);
    }
    return outcome.value;
  }

  async function validateArtifactFiles(
    label: string,
    artifact:
      | ReturnType<typeof collaborationInitialDraftOutputSchema.parse>
      | ReturnType<typeof collaborationCrossReviewOutputSchema.parse>
      | ReturnType<typeof collaborationProposedChangesOutputSchema.parse>
      | ReturnType<typeof collaborationCounterProposalOutputSchema.parse>
      | ReturnType<typeof collaborationResolutionDecisionOutputSchema.parse>
      | ReturnType<typeof collaborationFinalAnswerOutputSchema.parse>,
  ): Promise<void> {
    const validation = await validateGeneratedArtifactFiles({
      worktreePath: input.worktreePath,
      workflowId: input.workflowId,
      artifact,
    });
    if (!validation.success) {
      throw new Error(
        `workflow collaborator ${label} generated invalid artifact files: ${validation.error}`,
      );
    }
  }

  return {
    async runInitialDrafts(draftInput) {
      const [agentOneResult, agentTwoResult] = await Promise.all([
        runStructuredCall({
          backend: agentOneBackend,
          built: buildAgentOneInitialDraftPrompt({
            userPrompt: draftInput.brief,
            workflowId: input.workflowId,
          }),
          systemInstructions: AGENT_ONE_INITIAL_DRAFT_SYSTEM_INSTRUCTIONS,
          agent: "agent_one",
          phase: "initial_draft",
        }),
        runStructuredCall({
          backend: agentTwoBackend,
          built: buildAgentTwoInitialDraftPrompt({
            userPrompt: draftInput.brief,
            workflowId: input.workflowId,
          }),
          systemInstructions: AGENT_TWO_INITIAL_DRAFT_SYSTEM_INSTRUCTIONS,
          agent: "agent_two",
          phase: "initial_draft",
        }),
      ]);
      const agentOneDraft = parseArtifact(
        agentOneResult,
        "agent_one initial draft",
        collaborationInitialDraftContentSchema,
        collaborationInitialDraftOutputSchema,
        { kind: "initial_draft", agent: "agent_one", round: 0 },
      );
      const agentTwoDraft = parseArtifact(
        agentTwoResult,
        "agent_two initial draft",
        collaborationInitialDraftContentSchema,
        collaborationInitialDraftOutputSchema,
        { kind: "initial_draft", agent: "agent_two", round: 0 },
      );
      await validateArtifactFiles("agent_one initial draft", agentOneDraft);
      await validateArtifactFiles("agent_two initial draft", agentTwoDraft);
      return { agentOneDraft, agentTwoDraft };
    },

    async runCrossReview(reviewInput) {
      const reviewResult = await runStructuredCall({
        backend: agentTwoBackend,
        built: buildAgentTwoCrossReviewPrompt({
          userPrompt: reviewInput.brief,
          ownDraft: reviewInput.agentTwoDraft,
          otherDraft: reviewInput.agentOneDraft,
          workflowId: input.workflowId,
          round: 0,
        }),
        systemInstructions: AGENT_TWO_CROSS_REVIEW_SYSTEM_INSTRUCTIONS,
        agent: "agent_two",
        phase: "cross_review",
      });
      const agentTwoCrossReview = parseArtifact(
        reviewResult,
        "agent_two cross review",
        collaborationCrossReviewContentSchema,
        collaborationCrossReviewOutputSchema,
        {
          kind: "cross_review",
          agent: "agent_two",
          target_agent: "agent_one",
          round: 0,
        },
      );
      await validateArtifactFiles(
        "agent_two cross review",
        agentTwoCrossReview,
      );
      return { agentTwoCrossReview };
    },

    async runRound(roundInput) {
      const proposedResult = await runStructuredCall({
        backend: agentOneBackend,
        built: buildAgentOneProposedChangesPrompt({
          userPrompt: roundInput.brief,
          ownDraft: roundInput.agentOneDraft,
          otherDraft: roundInput.agentTwoDraft,
          workflowId: input.workflowId,
          round: roundInput.round,
        }),
        systemInstructions: AGENT_ONE_PROPOSED_CHANGES_SYSTEM_INSTRUCTIONS,
        agent: "agent_one",
        phase: "proposed_changes",
        round: roundInput.round,
      });
      const proposedChanges = parseArtifact(
        proposedResult,
        `round ${roundInput.round} agent_one proposed changes`,
        collaborationProposedChangesContentSchema,
        collaborationProposedChangesOutputSchema,
        {
          kind: "proposed_changes",
          agent: "agent_one",
          target_agent: "agent_two",
          round: roundInput.round,
        },
      );
      await validateArtifactFiles(
        `round ${roundInput.round} agent_one proposed changes`,
        proposedChanges,
      );

      const counterResult = await runStructuredCall({
        backend: agentTwoBackend,
        built: buildAgentTwoCounterProposalPrompt({
          userPrompt: roundInput.brief,
          ownDraft: roundInput.agentTwoDraft,
          otherDraft: roundInput.agentOneDraft,
          ownCrossReview: roundInput.agentTwoCrossReview,
          proposedChanges,
          workflowId: input.workflowId,
          round: roundInput.round,
        }),
        systemInstructions: AGENT_TWO_COUNTER_PROPOSAL_SYSTEM_INSTRUCTIONS,
        agent: "agent_two",
        phase: "counter_proposal",
        round: roundInput.round,
      });
      const counterProposal = parseArtifact(
        counterResult,
        `round ${roundInput.round} agent_two counter proposal`,
        collaborationCounterProposalContentSchema,
        collaborationCounterProposalOutputSchema,
        {
          kind: "counter_proposal",
          agent: "agent_two",
          target_agent: "agent_one",
          round: roundInput.round,
        },
      );
      await validateArtifactFiles(
        `round ${roundInput.round} agent_two counter proposal`,
        counterProposal,
      );

      const resolutionResult = await runStructuredCall({
        backend: agentOneBackend,
        built: buildAgentOneResolutionDecisionPrompt({
          userPrompt: roundInput.brief,
          ownDraft: roundInput.agentOneDraft,
          otherDraft: roundInput.agentTwoDraft,
          proposedChanges,
          latestCounterProposal: counterProposal,
          negotiationRound: roundInput.round,
          workflowId: input.workflowId,
        }),
        systemInstructions: AGENT_ONE_RESOLUTION_DECISION_SYSTEM_INSTRUCTIONS,
        agent: "agent_one",
        phase: "resolution_decision",
        round: roundInput.round,
      });
      const resolution = parseArtifact(
        resolutionResult,
        `round ${roundInput.round} agent_one resolution decision`,
        collaborationResolutionDecisionContentSchema,
        collaborationResolutionDecisionOutputSchema,
        {
          kind: "resolution_decision",
          agent: "agent_one",
          target_agent: "agent_two",
          round: roundInput.round,
        },
      );
      await validateArtifactFiles(
        `round ${roundInput.round} agent_one resolution decision`,
        resolution,
      );

      return { proposedChanges, counterProposal, resolution };
    },

    async generateFinalAnswer(finalInput) {
      const finalResult = await runStructuredCall({
        backend: agentOneBackend,
        built: buildAgentOneFinalAnswerPrompt({
          userPrompt: finalInput.brief,
          ownDraft: finalInput.agentOneDraft,
          otherDraft: finalInput.agentTwoDraft,
          latestCounterProposal: finalInput.latestCounterProposal,
          latestResolutionDecision: finalInput.latestResolutionDecision,
          workflowId: input.workflowId,
          round: finalInput.latestResolutionDecision.round,
        }),
        systemInstructions: AGENT_ONE_FINAL_ANSWER_SYSTEM_INSTRUCTIONS,
        agent: "agent_one",
        phase: "final_answer",
      });
      const final = parseArtifact(
        finalResult,
        "final answer",
        collaborationFinalAnswerContentSchema,
        collaborationFinalAnswerOutputSchema,
        {
          kind: "final_answer",
          agent: "agent_one",
          round: finalInput.latestResolutionDecision.round,
        },
      );
      await validateArtifactFiles("final answer", final);
      const answerRef = findGeneratedArtifactRef(
        final,
        final.answer_artifact_id,
      );
      if (!answerRef) {
        throw new Error(
          `workflow collaborator final answer did not include artifact ${final.answer_artifact_id}`,
        );
      }
      const finalAnswerText = await readGeneratedArtifactFile(
        input.worktreePath,
        answerRef,
      );
      return { finalAnswer: final, finalAnswerText };
    },
  };
}
