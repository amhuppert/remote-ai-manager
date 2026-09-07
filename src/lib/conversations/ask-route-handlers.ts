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
import { createLogger, withTracing, type Logger } from "@/lib/logging";
import { resolveProjectPath } from "@/lib/projects/resolver";
import {
  getSession,
  getProjectConversation,
  getActiveGraphWorkflowExecution,
  mutateActiveGraphWorkflowExecution,
  reserveActiveGraphWorkflowExecution,
  archiveActiveGraphWorkflowExecution,
  markGraphWorkflowContextEventsPreReset,
  getGraphWorkflowPendingArtifacts,
  clearGraphWorkflowPendingArtifacts,
} from "@/lib/state-store";
import {
  registerConversationQuestion,
  clearConversationQuestion,
} from "@/lib/workflows/conversation/manager";
import { resolveSessionConversationRoute } from "./route-resolution";
import { resolveProjectConversationRoute } from "@/lib/project-conversations/route-resolution";
import {
  storeSessionNameFromScopeRef,
  type ConversationScopeRef,
} from "./conversation-target";
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

/** What batch registration itself needs — no session lookup, no lane gate. */
export interface AskRegistrationDeps {
  registerConversationQuestion(
    projectPath: string,
    sessionName: string,
    conversationId: string,
    question: { questionId: string; questions: AskQuestionItem[] },
  ): Promise<boolean>;
  generateQuestionBatchId(): string;
  /**
   * Injected so a test can read the diagnostics this path actually emits. The
   * sentinel reaching a log field is the R1.3 defect the module-level logger
   * hid — it is only observable if the log sink is a dependency.
   */
  log: Logger;
}

export interface AskRouteDeps extends AskRegistrationDeps {
  auth: AgentAuth;
  resolveProjectPath(name: string): Promise<string | null>;
  getSession(
    projectPath: string,
    sessionName: string,
  ): Promise<{ conversations: ConversationState[] } | null>;
  resolveLaneAskPermission(
    projectPath: string,
    sessionName: string,
    conversationId: string,
  ): Promise<LaneAskPermission>;
}

const LANE_ASK_ROLES = new Set<ConversationRole>(["iteration", "validator"]);

/**
 * The scope-invariant half of ask: the autonomous, turn, single-batch, and
 * payload gates plus batch registration. Both the session and the project
 * adapter call THIS — the adapters differ only in how they resolve the
 * conversation (and in the session-only graph-lane gate, which stays in the
 * session adapter by spec non-goal).
 *
 * Scope travels as a `ConversationScopeRef`, never as a resolved session name.
 * The sentinel is materialized only at the storage call site
 * (`storeSessionNameFromScopeRef`), so no log line in this file can report it as
 * a session identity (R1.3).
 */
async function registerAskBatch(
  deps: AskRegistrationDeps,
  request: Request,
  resolved: {
    projectPath: string;
    scopeRef: ConversationScopeRef;
    conversationId: string;
    conversation: ConversationState;
  },
): Promise<Response> {
  const { projectPath, scopeRef, conversationId, conversation } = resolved;

  if (
    conversation.role !== null ||
    conversation.activeTurnSource === "workflow"
  ) {
    deps.log.info("ask.denied_autonomous", {
      conversationId,
      ...scopeRef,
      role: conversation.role,
      activeTurnSource: conversation.activeTurnSource,
    });
    return NextResponse.json({ error: AUTONOMOUS_DENIAL } satisfies ApiError, {
      status: 403,
    });
  }

  return registerAskBatchAfterRoleGate(deps, request, {
    projectPath,
    scopeRef,
    conversationId,
    conversation,
  });
}

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
        deps.log.info("ask.denied_lane_gate", {
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
      deps.log.info("ask.denied_autonomous", {
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

    // A session route always has a real session name, so its scope ref is the
    // session variant by construction — the sentinel cannot arrive here (the
    // public-param refusal rejects it upstream).
    return registerAskBatchAfterRoleGate(deps, request, {
      projectPath,
      scopeRef: { scope: "session", sessionName },
      conversationId,
      conversation,
    });
  }

  return { POST: post };
}

/** Turn / single-batch / payload gates and registration. Scope-invariant. */
async function registerAskBatchAfterRoleGate(
  deps: AskRegistrationDeps,
  request: Request,
  resolved: {
    projectPath: string;
    scopeRef: ConversationScopeRef;
    conversationId: string;
    conversation: ConversationState;
  },
): Promise<Response> {
  {
    const { projectPath, scopeRef, conversationId, conversation } = resolved;
    // Turn gate: a stray ask from outside a turn has no one to end a turn.
    // waiting_for_input passes through so the single-batch gate below can name
    // the pending batch (a mid-turn re-ask must get that 409, not this one).
    if (
      conversation.status !== "running" &&
      conversation.status !== "waiting_for_input"
    ) {
      deps.log.info("ask.no_running_turn", {
        conversationId,
        ...scopeRef,
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
      deps.log.info("ask.batch_already_pending", {
        conversationId,
        ...scopeRef,
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

    // The one place the sentinel is materialized: the session-keyed storage API
    // (A5). It is passed straight into the call and never bound to a name that a
    // later log line could pick up.
    const accepted = await deps.registerConversationQuestion(
      projectPath,
      storeSessionNameFromScopeRef(scopeRef),
      conversationId,
      { questionId: questionBatchId, questions },
    );
    if (!accepted) {
      deps.log.warn("ask.event_rejected", {
        conversationId,
        ...scopeRef,
        questionBatchId,
      });
      return NextResponse.json(
        {
          error: "no turn is running — ask requires an in-progress turn",
        } satisfies ApiError,
        { status: 409 },
      );
    }

    deps.log.info("ask.registered", {
      conversationId,
      ...scopeRef,
      questionBatchId,
      questionCount: questions.length,
    });
    return NextResponse.json({ ok: true, questionBatchId });
  }
}

export interface ProjectAskRouteDeps extends Omit<
  AskRouteDeps,
  "getSession" | "resolveLaneAskPermission"
> {
  getProjectConversation(
    projectPath: string,
    conversationId: string,
  ): Promise<ConversationState | null>;
}

/**
 * Project-scoped ask (R2.4/D1). Resolves the project conversation directly —
 * no session record is required — and reaches the SAME registration core the
 * session adapter uses. The graph-lane permission branch is deliberately absent:
 * graph workflow execution at project scope is a spec non-goal.
 */
export function createProjectAskQuestionHandlers(deps: ProjectAskRouteDeps) {
  async function post(
    request: Request,
    context: { params: Promise<Record<string, string>> },
  ): Promise<Response> {
    const denied = await deps.auth.requireToken(request);
    if (denied) return denied;

    const resolved = await resolveProjectConversationRoute(deps, context);
    if (!resolved.ok) return resolved.response;

    return registerAskBatch(deps, request, {
      projectPath: resolved.value.projectPath,
      scopeRef: { scope: "project" },
      conversationId: resolved.value.conversationId,
      conversation: resolved.value.conversation,
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
  clearConversationQuestion,
  now: () => new Date().toISOString(),
});

const defaultHandlers = createAskQuestionHandlers({
  auth: createAgentAuth(),
  resolveProjectPath,
  getSession,
  registerConversationQuestion,
  resolveLaneAskPermission: userInputGateService.resolveLaneAskPermission,
  generateQuestionBatchId: () => `q_${randomUUID()}`,
  log,
});

/** POST /api/projects/[name]/sessions/[session]/conversations/[conversationId]/ask */
export const POST = withTracing(defaultHandlers.POST);

const defaultProjectHandlers = createProjectAskQuestionHandlers({
  auth: createAgentAuth(),
  resolveProjectPath,
  getProjectConversation,
  registerConversationQuestion,
  generateQuestionBatchId: () => `q_${randomUUID()}`,
  log,
});

/** POST /api/projects/[name]/conversations/[conversationId]/ask */
export const projectConversationAskPOST = withTracing(
  defaultProjectHandlers.POST,
);
