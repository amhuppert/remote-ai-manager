/**
 * Token-gated agent question endpoint. The core records the pending batch,
 * publishes it, and receives the answer as the next queued user message.
 * Run seats ask their owner through the context request channel.
 */

import { randomUUID } from "node:crypto";
import { getSupervision } from "@/lib/supervision/production";
import { NextResponse } from "next/server";
import { createAgentAuth, type AgentAuth } from "@/lib/agent-gateway/token";
import type { ApiError } from "@/lib/api/errors";
import { createLogger, withTracing, type Logger } from "@/lib/logging";
import { resolveProjectPath } from "@/lib/projects/resolver";
import { getSession, getProjectConversation } from "@/lib/state-store";
import { resolveSessionConversationRoute } from "./route-resolution";
import { resolveProjectConversationRoute } from "@/lib/project-conversations/route-resolution";
import {
  storeSessionNameFromScopeRef,
  type ConversationScopeRef,
} from "./conversation-target";
import {
  askQuestionsBodySchema,
  type AskQuestionItem,
  type ConversationState,
} from "./schemas";
import { coreQuestionCommand } from "@/lib/supervision/handles";
const registerConversationQuestion = (
  projectPath: string,
  sessionName: string,
  conversationId: string,
  input: {
    questionId: string;
    questions: import("@/lib/conversations/schemas").AskQuestionItem[];
  },
) =>
  coreQuestionCommand(
    { projectPath, sessionName, conversationId },
    { kind: "register_question", ...input },
  );
const log = createLogger("ask-route-handlers");

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

/** A supervised seat conversation's question channel: its Context's Requests. */
export interface SeatAskPort {
  /** Null when the conversation is not a supervised seat. */
  seatFor(conversationId: string): {
    canAsk: boolean;
    /** The seat turn running now, or null between turns. */
    attemptId: string | null;
    /** A question this turn already opened. */
    openQuestionId: string | null;
  } | null;
  open(input: {
    conversationId: string;
    attemptId: string;
    questionText: string;
    questions: AskQuestionItem[];
  }): string;
}

export interface AskRouteDeps extends AskRegistrationDeps {
  auth: AgentAuth;
  seatAsk: SeatAskPort;
  resolveProjectPath(name: string): Promise<string | null>;
  getSession(
    projectPath: string,
    sessionName: string,
  ): Promise<{ conversations: ConversationState[] } | null>;
}

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

    // A supervised seat asks its owner through its Context, which decides what
    // the answer resumes; the conversation itself never parks on the question.
    const seat = deps.seatAsk.seatFor(conversationId);
    if (seat !== null) {
      return registerSeatAsk(deps, request, {
        conversationId,
        sessionName,
        seat,
      });
    }

    if (
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

/**
 * A seat's questions as the owner reads them in its wake, `run show` and the
 * run page: each question with its options, since the owner answers in text
 * and sees no other part of the batch.
 */
function seatQuestionText(questions: readonly AskQuestionItem[]): string {
  return questions
    .map((q) =>
      [
        q.question,
        ...q.options.map((option) => {
          const label = option.recommended
            ? `${option.label} (recommended)`
            : option.label;
          return option.description === undefined
            ? `- ${label}`
            : `- ${label}: ${option.description}`;
        }),
      ].join("\n"),
    )
    .join("\n\n");
}

async function registerSeatAsk(
  deps: AskRouteDeps,
  request: Request,
  input: {
    conversationId: string;
    sessionName: string;
    seat: NonNullable<ReturnType<SeatAskPort["seatFor"]>>;
  },
): Promise<Response> {
  const { conversationId, sessionName, seat } = input;
  if (!seat.canAsk) {
    deps.log.info("ask.denied_seat", { conversationId, sessionName });
    return NextResponse.json({ error: AUTONOMOUS_DENIAL } satisfies ApiError, {
      status: 403,
    });
  }
  if (seat.attemptId === null) {
    return NextResponse.json(
      {
        error: "no turn is running — ask requires an in-progress turn",
      } satisfies ApiError,
      { status: 409 },
    );
  }
  if (seat.openQuestionId !== null) {
    return NextResponse.json(
      {
        error: `question batch ${seat.openQuestionId} already pending`,
        code: "question_batch_pending",
        details: { questionBatchId: seat.openQuestionId },
        instruction:
          "You already asked — end your turn; the answer will arrive as your next user message.",
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
  const questions: AskQuestionItem[] = parsed.data.questions.map((q, i) => ({
    ...q,
    id: q.id ?? String(i),
  }));
  const questionBatchId = deps.seatAsk.open({
    conversationId,
    attemptId: seat.attemptId,
    questionText: seatQuestionText(questions),
    questions,
  });
  deps.log.info("ask.seat_registered", {
    conversationId,
    sessionName,
    questionBatchId,
    questionCount: questions.length,
  });
  return NextResponse.json({ ok: true, questionBatchId });
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
          code: "question_batch_pending",
          details: { questionBatchId: conversation.pendingQuestionId },
          instruction:
            "You already asked — end your turn; the answer will arrive as your next user message.",
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
  "getSession" | "seatAsk"
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

const defaultHandlers = createAskQuestionHandlers({
  auth: createAgentAuth(),
  resolveProjectPath,
  getSession,
  registerConversationQuestion,
  seatAsk: {
    seatFor: (conversationId) => getSupervision().seatFor(conversationId),
    open: (input) => getSupervision().requests.open(input),
  },
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
