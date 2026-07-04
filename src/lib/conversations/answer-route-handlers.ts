/**
 * Answer route (docs/design/cc-cli/03 §3): consume the pending question batch
 * and deliver the answers to the asking agent.
 *
 * Two paths, discriminated on the conversation's role:
 *
 * - Ordinary conversation: consuming the marker and enqueuing the answer happen
 *   in ONE durable write (`consumePendingQuestionId` on the standard submission
 *   path), so a crash can never strand a consumed marker without its queued
 *   answer. The cleared `pendingQuestionId`/`pendingQuestions` marker is the
 *   idempotency point — a duplicate POST gets 410. The answers travel through
 *   the standard prompt-submission path (queue + drain), formatted as the
 *   delimited <cc-question-answers> block so they survive queue coalescing.
 *
 * - Graph-workflow lane conversation (role "iteration" | "validator"): the
 *   answer is recorded on the execution's context record via the user-input
 *   gate — no message is queued and auto-drain never fires. The conversation's
 *   pending marker is cleared through a `CLEAR_PENDING_QUESTION` machine
 *   transition; the execution loop resumes the lane from the recorded answers.
 *   A duplicate lane answer is rejected by the gate as already-answered → 410.
 */

import { NextResponse } from "next/server";
import { readConfig } from "@/lib/config/loader";
import { resolveProjectPath } from "@/lib/projects/resolver";
import {
  getConversation,
  getSession,
  getActiveGraphWorkflowExecution,
  mutateActiveGraphWorkflowExecution,
  archiveActiveGraphWorkflowExecution,
  markGraphWorkflowContextEventsPreReset,
} from "@/lib/state-store";
import {
  answerQuestionRequestSchema,
  type AnswerQuestionRequest,
  type ConversationRole,
  type ConversationState,
} from "@/lib/conversations/schemas";
import { createLogger, withTracing } from "@/lib/logging";
import {
  ensureConversationActorAndDrain,
  sendConversationEvent,
} from "@/lib/workflows/conversation/manager";
import type { ConversationEvent } from "@/lib/workflows/conversation/types";
import type { AgentBackendId } from "@/lib/shared/schemas";
import type { ApiError } from "@/lib/api/errors";
import { dispatchPushForGraphWorkflowEvent } from "@/lib/push-notification/dispatcher";
import { createGraphWorkflowExecutionEventPublisher } from "@/lib/workflow-graph/execution-events";
import { createGraphWorkflowExecutionRepository } from "@/lib/workflow-graph/execution-repository";
import {
  createUserInputGateService,
  type RecordAnswersInput,
  type RecordAnswersResult,
} from "@/lib/workflow-graph/user-input-gate";
import {
  queueMessage,
  type QueueMessageParams,
  type QueueMessageResult,
} from "@/lib/prompt/queue";
import { formatQuestionAnswersBlock } from "./question-answers-block";

const logger = createLogger("answer-route-handlers");

/**
 * Graph-workflow lane roles (implementer = "iteration", context-validator =
 * "validator"). A lane answer is diverted onto the execution's context record
 * instead of the conversation's message queue — the loop resumes the lane from
 * there. Mirrors `LANE_ASK_ROLES` in the ask route.
 */
const LANE_ANSWER_ROLES = new Set<ConversationRole>(["iteration", "validator"]);

export interface AnswerRouteDeps {
  resolveProjectPath(name: string): Promise<string | null>;
  getConversation(
    projectPath: string,
    sessionName: string,
    conversationId: string,
  ): Promise<ConversationState | null>;
  sendConversationEvent(
    projectPath: string,
    sessionName: string,
    conversationId: string,
    event: ConversationEvent,
  ): boolean;
  queueMessage(
    params: QueueMessageParams & { consumePendingQuestionId: string },
  ): Promise<QueueMessageResult | null>;
  ensureConversationActorAndDrain(
    projectPath: string,
    sessionName: string,
    conversationId: string,
  ): Promise<void>;
  recordLaneAnswers(input: RecordAnswersInput): Promise<RecordAnswersResult>;
  readConfig(): Promise<{ defaultAgentBackend: AgentBackendId }>;
}

export function createAnswerHandlers(deps: AnswerRouteDeps) {
  async function post(
    request: Request,
    { params }: { params: Promise<Record<string, string>> },
  ): Promise<Response> {
    const resolvedParams = await params;
    const name = resolvedParams["name"] ?? "";
    const sessionName = decodeURIComponent(resolvedParams["session"] ?? "");
    const conversationId = resolvedParams["conversationId"] ?? "";

    const projectPath = await deps.resolveProjectPath(name);
    if (!projectPath) {
      return NextResponse.json(
        { error: "Project not found" } satisfies ApiError,
        { status: 404 },
      );
    }

    const conversation = await deps.getConversation(
      projectPath,
      sessionName,
      conversationId,
    );
    if (!conversation) {
      return NextResponse.json(
        { error: "Conversation not found" } satisfies ApiError,
        { status: 404 },
      );
    }

    let body: AnswerQuestionRequest;
    try {
      body = answerQuestionRequestSchema.parse(await request.json());
    } catch {
      return NextResponse.json(
        { error: "questionId and answers are required" } satisfies ApiError,
        { status: 400 },
      );
    }

    if (conversation.pendingQuestionId == null) {
      return NextResponse.json(
        { error: "already answered or superseded" } satisfies ApiError,
        { status: 410 },
      );
    }
    if (conversation.pendingQuestionId !== body.questionId) {
      return NextResponse.json(
        { error: "No pending question found with that ID" } satisfies ApiError,
        { status: 404 },
      );
    }

    // Graph-workflow lane answer: record on the execution's context record and
    // clear the conversation marker via a machine transition. No message is
    // queued and auto-drain never fires — the execution loop resumes the lane
    // from the recorded answers (Req 4.3/5.4/7.3).
    if (
      conversation.role !== null &&
      LANE_ANSWER_ROLES.has(conversation.role)
    ) {
      const recorded = await deps.recordLaneAnswers({
        projectPath,
        sessionName,
        conversationId,
        questionBatchId: body.questionId,
        answers: body.answers,
      });
      if (!recorded.ok) {
        logger.info("answer.lane_rejected", {
          conversationId,
          sessionName,
          questionId: body.questionId,
          reason: recorded.reason,
        });
        return NextResponse.json(
          { error: "already answered or superseded" } satisfies ApiError,
          { status: 410 },
        );
      }

      deps.sendConversationEvent(projectPath, sessionName, conversationId, {
        type: "CLEAR_PENDING_QUESTION",
      });

      logger.info("answer.lane_recorded", {
        conversationId,
        sessionName,
        questionId: body.questionId,
        answerCount: Object.keys(body.answers).length,
      });
      return NextResponse.json({ ok: true });
    }

    const backend =
      conversation.agentBackend ??
      (await deps.readConfig()).defaultAgentBackend;

    // One durable write consumes the marker AND appends the answer row —
    // `consumePendingQuestionId` makes the enqueue conditional on the marker
    // still being this batch. A null result means a concurrent duplicate won
    // the race (the pre-checks above handle the common stale cases).
    const queued = await deps.queueMessage({
      projectPath,
      sessionName,
      conversationId,
      text: formatQuestionAnswersBlock(body.questionId, body.answers),
      backend,
      metadata: {
        kind: "question_answers",
        questionBatchId: body.questionId,
      },
      consumePendingQuestionId: body.questionId,
    });
    if (!queued) {
      return NextResponse.json(
        { error: "already answered or superseded" } satisfies ApiError,
        { status: 410 },
      );
    }

    // If the asking turn is still running, clear the machine's pending
    // question too, so finalizingTurn settles to idle instead of
    // waitingForInput. Refusal is fine — a waitingForInput actor clears the
    // question when the queued answer claims its turn.
    deps.sendConversationEvent(projectPath, sessionName, conversationId, {
      type: "CLEAR_PENDING_QUESTION",
    });

    // Deliver now when no turn is running (idle/waiting drains immediately);
    // otherwise the row waits FIFO for the running turn to settle.
    await deps.ensureConversationActorAndDrain(
      projectPath,
      sessionName,
      conversationId,
    );

    logger.info("answer.enqueued", {
      conversationId,
      sessionName,
      questionId: body.questionId,
      answerCount: Object.keys(body.answers).length,
    });
    return NextResponse.json({ ok: true });
  }

  return { POST: post };
}

const eventPublisher = createGraphWorkflowExecutionEventPublisher({
  dispatchPush: dispatchPushForGraphWorkflowEvent,
});

const executionRepository = createGraphWorkflowExecutionRepository({
  getSession,
  getActiveGraphWorkflowExecution,
  mutateActiveGraphWorkflowExecution,
  archiveActiveGraphWorkflowExecution,
  markGraphWorkflowContextEventsPreReset,
  eventPublisher,
});

const userInputGateService = createUserInputGateService({
  getActive: executionRepository.getActive,
  mutateActive: executionRepository.mutateActive,
  publishUserInputPending: eventPublisher.publishUserInputPending,
  publishUserInputResolved: eventPublisher.publishUserInputResolved,
  sendConversationEvent,
  now: () => new Date().toISOString(),
});

const defaultHandlers = createAnswerHandlers({
  resolveProjectPath,
  getConversation,
  sendConversationEvent,
  queueMessage,
  ensureConversationActorAndDrain,
  recordLaneAnswers: userInputGateService.recordAnswers,
  readConfig,
});

/** POST /api/projects/[name]/sessions/[session]/conversations/[conversationId]/answer — submit answers to the pending question batch */
export const submitConversationAnswer = withTracing(defaultHandlers.POST);
