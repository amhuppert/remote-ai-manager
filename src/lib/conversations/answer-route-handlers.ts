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
 *   pending marker is then cleared durably, and a `CLEAR_PENDING_QUESTION`
 *   machine transition syncs a live actor; with nothing queued to consume the
 *   marker later, the durable write is what makes the clear survive an actor
 *   that has already ended its turn. The execution loop resumes the lane from
 *   the recorded answers. A duplicate lane answer is rejected by the gate as
 *   already-answered → 410.
 *
 * Two scope adapters share the ordinary path: the session adapter resolves
 * project → session → conversation, the project adapter resolves the project
 * conversation directly (no session record). Both reach `deliverAnswers`, so
 * answering is one domain operation with two ways of being addressed (D1). The
 * lane divert stays in the session adapter — graph workflow execution at project
 * scope is a spec non-goal.
 */

import { NextResponse } from "next/server";
import {
  notFound,
  refuseProjectSentinelSessionParam,
  resolveProjectOr404,
} from "@/lib/shared/route-resolution";
import { readConfig } from "@/lib/config/loader";
import { resolveProjectPath } from "@/lib/projects/resolver";
import {
  getConversation,
  getProjectConversation,
  getSession,
  mutateConversation,
  getActiveGraphWorkflowExecution,
  mutateActiveGraphWorkflowExecution,
  reserveActiveGraphWorkflowExecution,
  archiveActiveGraphWorkflowExecution,
  markGraphWorkflowContextEventsPreReset,
  getGraphWorkflowPendingArtifacts,
  clearGraphWorkflowPendingArtifacts,
} from "@/lib/state-store";
import {
  answerQuestionRequestSchema,
  type AnswerQuestionRequest,
  type ConversationRole,
  type ConversationState,
} from "@/lib/conversations/schemas";
import { resolveProjectConversationRoute } from "@/lib/project-conversations/route-resolution";
import {
  storeSessionNameFromScopeRef,
  type ConversationScopeRef,
} from "./conversation-target";
import { createLogger, withTracing, type Logger } from "@/lib/logging";
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

/**
 * What delivering an answer needs, independent of how the conversation was
 * addressed. Both adapters call the same delivery core with these.
 *
 * Scope travels as a `ConversationScopeRef`, never as a resolved session name:
 * the sentinel is materialized only at the session-keyed storage calls, so no
 * log line here can report it as a session identity (R1.3).
 */
export interface AnswerDeliveryDeps {
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
  recordLaneAnswers(input: RecordAnswersInput): Promise<RecordAnswersResult>;
  /**
   * Durably drop the conversation's pending-question marker, but only while it
   * still names `questionBatchId` — a marker that has moved on belongs to a
   * later ask that this answer must not silently retire.
   */
  clearPendingQuestion(input: {
    projectPath: string;
    sessionName: string;
    conversationId: string;
    questionBatchId: string;
  }): Promise<void>;
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

  const backend =
    conversation.agentBackend ?? (await deps.readConfig()).defaultAgentBackend;

  // One durable write consumes the marker AND appends the answer row —
  // `consumePendingQuestionId` makes the enqueue conditional on the marker
  // still being this batch. A null result means a concurrent duplicate won
  // the race (the pre-checks above handle the common stale cases).
  const queued = await deps.queueMessage({
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

  // If the asking turn is still running, clear the machine's pending
  // question too, so finalizingTurn settles to idle instead of
  // waitingForInput. Refusal is fine — a waitingForInput actor clears the
  // question when the queued answer claims its turn.
  deps.sendConversationEvent(projectPath, storeSessionName, conversationId, {
    type: "CLEAR_PENDING_QUESTION",
  });

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

    // Graph-workflow lane answer: record on the execution's context record and
    // clear the conversation marker via a machine transition. No message is
    // queued and auto-drain never fires — the execution loop resumes the lane
    // from the recorded answers (Req 4.3/5.4/7.3). Session-only by spec
    // non-goal: graph workflow execution never runs at project scope.
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
        deps.log.info("answer.lane_rejected", {
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

      // The marker is retired durably, then the machine is told. The ordinary
      // path can lean on a refused transition because its queued answer clears
      // the marker when the row is claimed; a lane answer queues nothing, so a
      // refusal here — the asking turn has ended, so the actor is usually gone
      // — would leave the marker standing forever. The execution loop reads
      // exactly that field to decide whether a resumed lane still owes a
      // question, so a stale marker re-parks the lane on the batch it was just
      // handed answers for, and the run can never move past it.
      await deps.clearPendingQuestion({
        projectPath,
        sessionName,
        conversationId,
        questionBatchId: body.questionId,
      });
      deps.sendConversationEvent(projectPath, sessionName, conversationId, {
        type: "CLEAR_PENDING_QUESTION",
      });

      deps.log.info("answer.lane_recorded", {
        conversationId,
        sessionName,
        questionId: body.questionId,
        answerCount: Object.keys(body.answers).length,
      });
      return NextResponse.json({ ok: true });
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

const eventPublisher = createGraphWorkflowExecutionEventPublisher({
  dispatchPush: dispatchPushForGraphWorkflowEvent,
});

const executionRepository = createGraphWorkflowExecutionRepository({
  getSession,
  getActiveGraphWorkflowExecution,
  mutateActiveGraphWorkflowExecution,
  reserveActiveGraphWorkflowExecution,
  archiveActiveGraphWorkflowExecution,
  markGraphWorkflowContextEventsPreReset,
  getGraphWorkflowPendingArtifacts,
  clearGraphWorkflowPendingArtifacts,
  eventPublisher,
});

const userInputGateService = createUserInputGateService({
  getActive: executionRepository.getActive,
  mutateActive: executionRepository.mutateActive,
  publishUserInputPending: eventPublisher.publishUserInputPending,
  publishUserInputResolved: eventPublisher.publishUserInputResolved,
  deliver: eventPublisher.deliver,
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
  clearPendingQuestion: async ({
    projectPath,
    sessionName,
    conversationId,
    questionBatchId,
  }) => {
    await mutateConversation(
      projectPath,
      sessionName,
      conversationId,
      "answer.clear_pending_question",
      (conversation) => {
        if (conversation.pendingQuestionId !== questionBatchId) return;
        conversation.pendingQuestionId = null;
        conversation.pendingQuestions = null;
      },
    );
  },
  readConfig,
  log: logger,
});

/** POST /api/projects/[name]/sessions/[session]/conversations/[conversationId]/answer — submit answers to the pending question batch */
export const submitConversationAnswer = withTracing(defaultHandlers.POST);

const defaultProjectHandlers = createProjectAnswerHandlers({
  resolveProjectPath,
  getProjectConversation,
  sendConversationEvent,
  queueMessage,
  ensureConversationActorAndDrain,
  readConfig,
  log: logger,
});

/** POST /api/projects/[name]/conversations/[conversationId]/answer — submit answers to a project conversation's pending question batch */
export const submitProjectConversationAnswer = withTracing(
  defaultProjectHandlers.POST,
);
