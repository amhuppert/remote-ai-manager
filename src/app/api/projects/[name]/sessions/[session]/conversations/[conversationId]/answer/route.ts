import { NextResponse } from "next/server";
import { resolveProjectPath } from "@/lib/project-resolver";
import { getSession, updateSession } from "@/lib/state";
import { resolveQuestion } from "@/lib/question-registry";
import { answerQuestionRequestSchema } from "@/lib/schemas";
import { withTracing } from "@/lib/logging";
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

  const resolved = resolveQuestion(body.questionId, body.answers);
  if (!resolved) {
    // Question not in memory — server may have restarted.
    // If the conversation still has matching persisted question data, return 410
    // and clean up the stale state.
    if (
      conversation.pendingQuestionId === body.questionId &&
      conversation.status === "waiting_for_input"
    ) {
      conversation.pendingQuestionId = null;
      conversation.pendingQuestions = null;
      conversation.status = "awaiting";
      conversation.lastActivityAt = new Date().toISOString();
      session.lastActivityAt = new Date().toISOString();
      await updateSession(projectPath, session).catch(() => {});

      return NextResponse.json(
        {
          error:
            "The prompt that asked this question is no longer running. The server may have restarted.",
        } satisfies ApiError,
        { status: 410 },
      );
    }

    return NextResponse.json(
      { error: "No pending question found with that ID" } satisfies ApiError,
      { status: 404 },
    );
  }

  // Clear persisted question data on successful resolution
  conversation.pendingQuestionId = null;
  conversation.pendingQuestions = null;
  conversation.lastActivityAt = new Date().toISOString();
  session.lastActivityAt = new Date().toISOString();
  await updateSession(projectPath, session).catch(() => {});

  return NextResponse.json({ ok: true });
});
