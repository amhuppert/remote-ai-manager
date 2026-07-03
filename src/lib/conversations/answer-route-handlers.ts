/**
 * Answer route (docs/design/cc-cli/03 §3): consume the pending question batch
 * and submit the answers as the conversation's next user message.
 *
 * Consuming the marker and enqueuing the answer happen in ONE durable write
 * (`consumePendingQuestionId` on the standard submission path), so a crash
 * can never strand a consumed marker without its queued answer. The cleared
 * `pendingQuestionId`/`pendingQuestions` marker is the idempotency point — a
 * duplicate POST gets 410. The answers travel through the standard
 * prompt-submission path (queue + drain), formatted as the delimited
 * <cc-question-answers> block so they survive queue coalescing.
 */

import { NextResponse } from "next/server";
import { readConfig } from "@/lib/config/loader";
import { resolveProjectPath } from "@/lib/projects/resolver";
import { getConversation } from "@/lib/state-store";
import {
  answerQuestionRequestSchema,
  type AnswerQuestionRequest,
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
import {
  queueMessage,
  type QueueMessageParams,
  type QueueMessageResult,
} from "@/lib/prompt/queue";
import { formatQuestionAnswersBlock } from "./question-answers-block";

const logger = createLogger("answer-route-handlers");

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

const defaultHandlers = createAnswerHandlers({
  resolveProjectPath,
  getConversation,
  sendConversationEvent,
  queueMessage,
  ensureConversationActorAndDrain,
  readConfig,
});

/** POST /api/projects/[name]/sessions/[session]/conversations/[conversationId]/answer — submit answers to the pending question batch */
export const submitConversationAnswer = withTracing(defaultHandlers.POST);
