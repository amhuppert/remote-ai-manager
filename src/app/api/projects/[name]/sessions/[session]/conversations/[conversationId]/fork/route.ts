import { NextResponse } from "next/server";
import { resolveProjectPath } from "@/lib/project-resolver";
import { getSession } from "@/lib/state";
import { getConversation, forkConversation } from "@/lib/conversations";
import { forkRequestSchema } from "@/lib/schemas";
import { withTracing } from "@/lib/logging";
import type { ApiError } from "@/types";

export const dynamic = "force-dynamic";

/** POST /api/projects/[name]/sessions/[session]/conversations/[conversationId]/fork — fork a conversation */
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

  const conversation = await getConversation(
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

  // Cannot fork while conversation is running
  if (conversation.status === "running") {
    return NextResponse.json(
      { error: "Cannot fork while conversation is running" } satisfies ApiError,
      { status: 409 },
    );
  }

  let body: { messageIndex: number; editedText?: string };
  try {
    body = forkRequestSchema.parse(await request.json());
  } catch {
    return NextResponse.json(
      { error: "Invalid request: messageIndex is required" } satisfies ApiError,
      { status: 400 },
    );
  }

  try {
    const result = await forkConversation({
      projectPath,
      sessionName,
      sourceConversationId: conversationId,
      messageIndex: body.messageIndex,
      editedText: body.editedText,
    });

    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Fork failed";

    // Map domain errors to appropriate HTTP status codes
    if (
      message.includes("no history with Claude") ||
      message.includes("no transcript") ||
      message.includes("Invalid messageIndex")
    ) {
      return NextResponse.json({ error: message } satisfies ApiError, {
        status: 400,
      });
    }

    return NextResponse.json({ error: message } satisfies ApiError, {
      status: 500,
    });
  }
});
