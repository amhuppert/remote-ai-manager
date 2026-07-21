/**
 * Agent-facing ask endpoint (docs/design/cc-cli/03 §2.2).
 *
 * POST /api/projects/[name]/sessions/[session]/conversations/[conversationId]/ask
 * Token-gated. Registers a question batch on the running turn's conversation by
 * firing the ASK_QUESTION machine event — the transition persists pending
 * state, broadcasts the ask-question SSE, and dispatches the push. No promise
 * is created and no runtime resolver is touched: the agent ends its turn and
 * the answer arrives as the next queued user message.
 */

import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import { createAgentAuth, type AgentAuth } from "@/lib/agent-gateway/token";
import type { ApiError } from "@/lib/api/errors";
import { createLogger, withTracing } from "@/lib/logging";
import { resolveProjectPath } from "@/lib/projects/resolver";
import {
  getSession,
  getActiveGraphWorkflowExecution,
  mutateActiveGraphWorkflowExecution,
  archiveActiveGraphWorkflowExecution,
  markGraphWorkflowContextEventsPreReset,
} from "@/lib/state-store";
import { sendConversationEvent } from "@/lib/workflows/conversation/manager";
import type { ConversationEvent } from "@/lib/workflows/conversation/types";
import { resolveSessionConversationRoute } from "./route-resolution";
import { dispatchPushForGraphWorkflowEvent } from "@/lib/push-notification/dispatcher";
import { createGraphWorkflowExecutionEventPublisher } from "@/lib/workflow-graph/execution-events";
import { createGraphWorkflowExecutionRepository } from "@/lib/workflow-graph/execution-repository";
import {
  createUserInputGateService,
  type LaneAskPermission,
} from "@/lib/workflow-graph/user-input-gate";
import {
  askQuestionItemSchema,
  type AskQuestionItem,
  type ConversationRole,
  type ConversationState,
} from "./schemas";

const log = createLogger("ask-route-handlers");

export const askQuestionsBodySchema = z.object({
  questions: z.array(askQuestionItemSchema).min(1),
});
export type AskQuestionsBody = z.infer<typeof askQuestionsBodySchema>;

const AUTONOMOUS_DENIAL =
  "autonomous conversation — proceed with best judgment";

export interface AskRouteDeps {
  auth: AgentAuth;
  resolveProjectPath(name: string): Promise<string | null>;
  getSession(
    projectPath: string,
    sessionName: string,
  ): Promise<{ conversations: ConversationState[] } | null>;
  sendConversationEvent(
    projectPath: string,
    sessionName: string,
    conversationId: string,
    event: ConversationEvent,
  ): boolean;
  resolveLaneAskPermission(
    projectPath: string,
    sessionName: string,
    conversationId: string,
  ): Promise<LaneAskPermission>;
  generateQuestionBatchId(): string;
}

const LANE_ASK_ROLES = new Set<ConversationRole>(["iteration", "validator"]);

export function createAskQuestionHandlers(deps: AskRouteDeps) {
  async function post(
    request: Request,
    { params }: { params: Promise<Record<string, string>> },
  ): Promise<Response> {
    const denied = await deps.auth.requireToken(request);
    if (denied) return denied;

    const resolved = await resolveSessionConversationRoute(deps, { params });
    if (!resolved.ok) return resolved.response;
    const { projectPath, sessionName, conversationId, conversation } =
      resolved.value;

    // Mode gate. A graph-workflow lane conversation (role "iteration" =
    // implementer, or "validator") may ask only when its context's resolved
    // askUserQuestions toggle is enabled — the gate reverse-looks-up the lane
    // and applies the cascade. An allowed lane ask falls through to the same
    // turn / single-batch / Zod / registration path as an ordinary
    // conversation. Every other conversation (planner, initialization, no role,
    // or a non-lane workflow-driven turn) is autonomous and denied server-side.
    const isLaneConversation =
      conversation.role !== null && LANE_ASK_ROLES.has(conversation.role);

    if (isLaneConversation) {
      const permission = await deps.resolveLaneAskPermission(
        projectPath,
        sessionName,
        conversationId,
      );
      if (!permission.allowed) {
        log.info("ask.denied_lane_gate", {
          conversationId,
          sessionName,
          role: conversation.role,
          reason: "lane_ask_not_permitted",
        });
        return NextResponse.json(
          { error: AUTONOMOUS_DENIAL } satisfies ApiError,
          { status: 403 },
        );
      }
    } else if (
      conversation.role !== null ||
      conversation.activeTurnSource === "workflow"
    ) {
      log.info("ask.denied_autonomous", {
        conversationId,
        sessionName,
        role: conversation.role,
        activeTurnSource: conversation.activeTurnSource,
      });
      return NextResponse.json(
        { error: AUTONOMOUS_DENIAL } satisfies ApiError,
        {
          status: 403,
        },
      );
    }

    // Turn gate: a stray ask from outside a turn has no one to end a turn.
    // waiting_for_input passes through so the single-batch gate below can name
    // the pending batch (a mid-turn re-ask must get that 409, not this one).
    if (
      conversation.status !== "running" &&
      conversation.status !== "waiting_for_input"
    ) {
      log.info("ask.no_running_turn", {
        conversationId,
        sessionName,
        status: conversation.status,
      });
      return NextResponse.json(
        {
          error: "no turn is running — ask requires an in-progress turn",
        } satisfies ApiError,
        { status: 409 },
      );
    }

    // Single-batch gate: one batch per conversation.
    if (conversation.pendingQuestionId != null) {
      log.info("ask.batch_already_pending", {
        conversationId,
        sessionName,
        pendingQuestionId: conversation.pendingQuestionId,
      });
      return NextResponse.json(
        {
          error: `question batch ${conversation.pendingQuestionId} already pending`,
        } satisfies ApiError,
        { status: 409 },
      );
    }

    let rawBody: unknown;
    try {
      rawBody = await request.json();
    } catch {
      return NextResponse.json(
        { error: "Request body must be JSON" } satisfies ApiError,
        { status: 400 },
      );
    }

    const parsed = askQuestionsBodySchema.safeParse(rawBody);
    if (!parsed.success) {
      return NextResponse.json(
        {
          error: "Invalid questions payload",
          issues: parsed.error.issues.map((i) => ({
            path: i.path.join("."),
            message: i.message,
          })),
        },
        { status: 400 },
      );
    }

    // Fill a stable id where the agent omitted one, so answers, navigation,
    // and the status rail key off it instead of question text.
    const questions: AskQuestionItem[] = parsed.data.questions.map((q, i) => ({
      ...q,
      id: q.id ?? String(i),
    }));

    const questionBatchId = deps.generateQuestionBatchId();

    const accepted = deps.sendConversationEvent(
      projectPath,
      sessionName,
      conversationId,
      { type: "ASK_QUESTION", questionId: questionBatchId, questions },
    );
    if (!accepted) {
      log.warn("ask.event_rejected", {
        conversationId,
        sessionName,
        questionBatchId,
      });
      return NextResponse.json(
        {
          error: "no turn is running — ask requires an in-progress turn",
        } satisfies ApiError,
        { status: 409 },
      );
    }

    log.info("ask.registered", {
      conversationId,
      sessionName,
      questionBatchId,
      questionCount: questions.length,
    });
    return NextResponse.json({ ok: true, questionBatchId });
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
  deliver: eventPublisher.deliver,
  sendConversationEvent,
  now: () => new Date().toISOString(),
});

const defaultHandlers = createAskQuestionHandlers({
  auth: createAgentAuth(),
  resolveProjectPath,
  getSession,
  sendConversationEvent,
  resolveLaneAskPermission: userInputGateService.resolveLaneAskPermission,
  generateQuestionBatchId: () => `q_${randomUUID()}`,
});

/** POST /api/projects/[name]/sessions/[session]/conversations/[conversationId]/ask */
export const POST = withTracing(defaultHandlers.POST);
