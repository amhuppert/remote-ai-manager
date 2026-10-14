/**
 * Consumes a question batch and queues its answers in one durable write.
 * The core clears the running turn's marker and drains the queued answer.
 * Session and project routes share the same delivery operation.
 */

import { NextResponse } from "next/server";
import {
  notFound,
  refuseProjectSentinelSessionParam,
  resolveProjectOr404,
} from "@/lib/shared/route-resolution";
import { readConfig } from "@/lib/config/loader";
import { resolveProjectPath } from "@/lib/projects/resolver";
import { getConversation, getProjectConversation } from "@/lib/state-store";
import {
  answerQuestionRequestSchema,
  type AnswerQuestionRequest,
  type ConversationState,
} from "@/lib/conversations/schemas";
import { resolveProjectConversationRoute } from "@/lib/project-conversations/route-resolution";
import {
  storeSessionNameFromScopeRef,
  type ConversationScopeRef,
} from "./conversation-target";
import { createLogger, withTracing, type Logger } from "@/lib/logging";
import type { AgentBackendId } from "@/lib/shared/schemas";
import type { ApiError } from "@/lib/api/errors";
import {
  queueMessage,
  type QueueMessageParams,
  type QueueMessageResult,
} from "@/lib/prompt/queue";
import { formatQuestionAnswersBlock } from "./question-answers-block";
import {
  isInTurnQuestionId,
  type InTurnQuestionScope,
} from "./in-turn-questions";
import {
  coreQuestionCommand,
  drainCoreConversation,
} from "@/lib/supervision/handles";
const clearConversationQuestion = (
  projectPath: string,
  sessionName: string,
  conversationId: string,
  input: { questionId: string },
) =>
  coreQuestionCommand(
    { projectPath, sessionName, conversationId },
    { kind: "clear_question", ...input },
  );
const ensureConversationActorAndDrain = (
  _projectPath: string,
  _sessionName: string,
  conversationId: string,
) => drainCoreConversation(conversationId);

const logger = createLogger("answer-route-handlers");

/**
 * What delivering an answer needs, independent of how the conversation was
 * addressed. Both adapters call the same delivery core with these.
 *
 * Scope travels as a `ConversationScopeRef`, never as a resolved session name:
 * the sentinel is materialized only at the session-keyed storage calls, so no
 * log line here can report it as a session identity (R1.3).
 */
export interface AnswerDeliveryDeps {
  answerInTurnQuestion?(
    scope: InTurnQuestionScope,
    reply: AnswerQuestionRequest,
  ): Promise<boolean>;
  clearConversationQuestion(
    projectPath: string,
    sessionName: string,
    conversationId: string,
    question: { questionId: string },
  ): Promise<boolean>;
  queueMessage(
    params: QueueMessageParams & { consumePendingQuestionId: string },
  ): Promise<QueueMessageResult | null>;
  ensureConversationActorAndDrain(
    projectPath: string,
    sessionName: string,
    conversationId: string,
  ): Promise<void>;
  readConfig(): Promise<{ defaultAgentBackend: AgentBackendId }>;
  /**
   * Injected so a test can read the diagnostics this path actually emits — a
   * sentinel reaching a log field is invisible while the sink is module-level.
   */
  log: Logger;
}

export interface AnswerRouteDeps extends AnswerDeliveryDeps {
  resolveProjectPath(name: string): Promise<string | null>;
  getConversation(
    projectPath: string,
    sessionName: string,
    conversationId: string,
  ): Promise<ConversationState | null>;
}

export interface ProjectAnswerRouteDeps extends AnswerDeliveryDeps {
  resolveProjectPath(name: string): Promise<string | null>;
  getProjectConversation(
    projectPath: string,
    conversationId: string,
  ): Promise<ConversationState | null>;
}

type AnswerGate =
  | { ok: true; body: AnswerQuestionRequest }
  | { ok: false; response: Response };

/**
 * Body validation plus the idempotency pre-checks against the pending marker.
 * Scope-invariant: the marker lives on the conversation, not on its owner.
 */
async function gateAnswerRequest(
  request: Request,
  conversation: ConversationState,
): Promise<AnswerGate> {
  let body: AnswerQuestionRequest;
  try {
    body = answerQuestionRequestSchema.parse(await request.json());
  } catch {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "questionId and answers are required" } satisfies ApiError,
        { status: 400 },
      ),
    };
  }

  if (conversation.pendingQuestionId == null) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "already answered or superseded" } satisfies ApiError,
        { status: 410 },
      ),
    };
  }
  if (conversation.pendingQuestionId !== body.questionId) {
    return {
      ok: false,
      response: notFound("No pending question found with that ID"),
    };
  }
  return { ok: true, body };
}

/**
 * The scope-invariant delivery half: one durable consume+enqueue, the machine's
 * pending-question clear, and the drain. Both the session and the project
 * adapter reach THIS — the adapters differ only in how they resolve the
 * conversation, and in the session-only graph-lane divert.
 */
async function deliverAnswers(
  deps: AnswerDeliveryDeps,
  resolved: {
    projectPath: string;
    scopeRef: ConversationScopeRef;
    conversationId: string;
    conversation: ConversationState;
    body: AnswerQuestionRequest;
  },
): Promise<Response> {
  const { projectPath, scopeRef, conversationId, conversation, body } =
    resolved;
  // The one place the sentinel is materialized: the session-keyed storage APIs
  // (A5). Bound to a name that says so, so no log line can pick it up as a
  // session identity.
  const storeSessionName = storeSessionNameFromScopeRef(scopeRef);

  if (isInTurnQuestionId(body.questionId)) {
    const answer =
      deps.answerInTurnQuestion ??
      (await import("./in-turn-question-service")).inTurnQuestionService.answer;
    const delivered = await answer(
      { projectPath, sessionName: storeSessionName, conversationId },
      body,
    );
    deps.log.info("answer.in_turn", {
      conversationId,
      ...scopeRef,
      questionId: body.questionId,
      delivered,
    });
    return delivered
      ? NextResponse.json({ ok: true })
      : NextResponse.json(
          {
            error:
              "The requesting run stopped, expired, or already received an answer",
          },
          { status: 410 },
        );
  }

  const backend =
    conversation.agentBackend ?? (await deps.readConfig()).defaultAgentBackend;

  // One durable write consumes the marker AND appends the answer row —
  // `consumePendingQuestionId` makes the enqueue conditional on the marker
  // still being this batch. A null result means a concurrent duplicate won
  // the race (the pre-checks above handle the common stale cases).
  const queued = await deps.queueMessage({
    inputOrigin: "generated",
    projectPath,
    sessionName: storeSessionName,
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

  // Clear the running turn's marker before it settles. The queued answer
  // already consumed the durable marker under the same question identity.
  await deps.clearConversationQuestion(
    projectPath,
    storeSessionName,
    conversationId,
    {
      questionId: body.questionId,
    },
  );

  // Deliver now when no turn is running (idle/waiting drains immediately);
  // otherwise the row waits FIFO for the running turn to settle.
  await deps.ensureConversationActorAndDrain(
    projectPath,
    storeSessionName,
    conversationId,
  );

  deps.log.info("answer.enqueued", {
    conversationId,
    ...scopeRef,
    questionId: body.questionId,
    answerCount: Object.keys(body.answers).length,
  });
  return NextResponse.json({ ok: true });
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

    // The sentinel used to resolve here by accident: `getConversation` is
    // sentinel-aware, so a session-shaped URL reached the project conversation
    // and answered it. That alias is refused — the project route is the contract.
    const refusal = refuseProjectSentinelSessionParam(
      sessionName,
      name,
      conversationId,
    );
    if (refusal) return refusal;

    const project = await resolveProjectOr404(deps, name);
    if (!project.ok) return project.response;
    const projectPath = project.value;

    const conversation = await deps.getConversation(
      projectPath,
      sessionName,
      conversationId,
    );
    if (!conversation) {
      return notFound("Conversation not found");
    }

    const gate = await gateAnswerRequest(request, conversation);
    if (!gate.ok) return gate.response;
    const body = gate.body;

    if (isInTurnQuestionId(body.questionId)) {
      return deliverAnswers(deps, {
        projectPath,
        scopeRef: { scope: "session", sessionName },
        conversationId,
        conversation,
        body,
      });
    }

    // A session route always has a real session name — the public-param refusal
    // above rejects the sentinel, so the scope ref is the session variant by
    // construction.
    return deliverAnswers(deps, {
      projectPath,
      scopeRef: { scope: "session", sessionName },
      conversationId,
      conversation,
      body,
    });
  }

  return { POST: post };
}

/**
 * Project-scoped answer (R1.1/D1). Resolves the project conversation directly —
 * no session record is required — and reaches the SAME delivery core the session
 * adapter uses. The graph-lane divert is deliberately absent: graph workflow
 * execution at project scope is a spec non-goal.
 */
export function createProjectAnswerHandlers(deps: ProjectAnswerRouteDeps) {
  async function post(
    request: Request,
    context: { params: Promise<Record<string, string>> },
  ): Promise<Response> {
    const resolved = await resolveProjectConversationRoute(deps, context);
    if (!resolved.ok) return resolved.response;

    const gate = await gateAnswerRequest(request, resolved.value.conversation);
    if (!gate.ok) return gate.response;

    return deliverAnswers(deps, {
      projectPath: resolved.value.projectPath,
      scopeRef: { scope: "project" },
      conversationId: resolved.value.conversationId,
      conversation: resolved.value.conversation,
      body: gate.body,
    });
  }

  return { POST: post };
}

const defaultHandlers = createAnswerHandlers({
  resolveProjectPath,
  getConversation,
  clearConversationQuestion,
  queueMessage,
  ensureConversationActorAndDrain,
  readConfig,
  log: logger,
});

/** POST /api/projects/[name]/sessions/[session]/conversations/[conversationId]/answer — submit answers to the pending question batch */
export const submitConversationAnswer = withTracing(defaultHandlers.POST);

const defaultProjectHandlers = createProjectAnswerHandlers({
  resolveProjectPath,
  getProjectConversation,
  clearConversationQuestion,
  queueMessage,
  ensureConversationActorAndDrain,
  readConfig,
  log: logger,
});

/** POST /api/projects/[name]/conversations/[conversationId]/answer — submit answers to a project conversation's pending question batch */
export const submitProjectConversationAnswer = withTracing(
  defaultProjectHandlers.POST,
);
