import { NextResponse } from "next/server";
import { resolveProjectPath } from "@/lib/project-resolver";
import { getSession } from "@/lib/state";
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
    return NextResponse.json(
      { error: "No pending question found with that ID" } satisfies ApiError,
      { status: 404 },
    );
  }

  return NextResponse.json({ ok: true });
});
