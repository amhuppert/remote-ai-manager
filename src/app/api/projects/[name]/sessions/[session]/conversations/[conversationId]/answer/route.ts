import { NextResponse } from "next/server";
import { resolveProjectPath } from "@/lib/project-resolver";
import { getSession, mutateConversation } from "@/lib/state";
import { answerQuestionRequestSchema } from "@/lib/schemas";
import { withTracing } from "@/lib/logging";
import {
  getConversationActor,
  sendConversationEvent,
} from "@/lib/workflows/conversation/manager";
import {
  conversationRuntimeKey,
  getConversationRuntime,
} from "@/lib/workflows/conversation/runtime-state";
import type { ApiError } from "@/types";

export const dynamic = "force-dynamic";

/** POST /api/projects/[name]/sessions/[session]/conversations/[conversationId]/answer — submit answers to Claude's question */
export const POST = withTracing(async (request, { params }) => {
  const resolvedParams = await params;
  const name = resolvedParams["name"] ?? "";
  const sessionSlug = resolvedParams["session"] ?? "";
  const sessionName = decodeURIComponent(sessionSlug);
  const conversationId = resolvedParams["conversationId"] ?? "";

  const projectPath = await resolveProjectPath(name);
  if (!projectPath) {
    return NextResponse.json(
      { error: "Project not found" } satisfies ApiError,
      { status: 404 },
    );
  }

  const session = await getSession(projectPath, sessionName);
  if (!session) {
    return NextResponse.json(
      { error: "Session not found" } satisfies ApiError,
      { status: 404 },
    );
  }

  const conversation = session.conversations.find(
    (c) => c.id === conversationId,
  );
  if (!conversation) {
    return NextResponse.json(
      { error: "Conversation not found" } satisfies ApiError,
      { status: 404 },
    );
  }

  let body: { questionId: string; answers: Record<string, string> };
  try {
    body = answerQuestionRequestSchema.parse(await request.json());
  } catch {
    return NextResponse.json(
      { error: "questionId and answers are required" } satisfies ApiError,
      { status: 400 },
    );
  }

  // Resolve via runtime state's deferred promise (used by actor-implementations.ts canUseTool)
  const key = conversationRuntimeKey(projectPath, sessionName, conversationId);
  const runtime = getConversationRuntime(key);
  const actor = getConversationActor(projectPath, sessionName, conversationId);

  if (runtime?.activeQuestionResolver) {
    // Resolve the deferred promise so the SDK's canUseTool callback returns
    runtime.activeQuestionResolver.resolve(body.answers);
    runtime.activeQuestionResolver = undefined;

    // Send ANSWER event to the machine for state tracking
    sendConversationEvent(projectPath, sessionName, conversationId, {
      type: "ANSWER",
      questionId: body.questionId,
      answers: body.answers,
    });

    return NextResponse.json({ ok: true });
  }

  // No active resolver — check if this is a stale question
  if (!actor) {
    if (
      conversation.pendingQuestionId === body.questionId &&
      conversation.status === "waiting_for_input"
    ) {
      await mutateConversation(
        projectPath,
        sessionName,
        conversationId,
        "answer.resolveStaleQuestion",
        (c) => {
          c.pendingQuestionId = null;
          c.pendingQuestions = null;
          c.status = "awaiting";
        },
      ).catch(() => {});

      return NextResponse.json(
        {
          error:
            "The prompt that asked this question is no longer running. The server may have restarted.",
        } satisfies ApiError,
        { status: 410 },
      );
    }
  }

  return NextResponse.json(
    { error: "No pending question found with that ID" } satisfies ApiError,
    { status: 404 },
  );
});
