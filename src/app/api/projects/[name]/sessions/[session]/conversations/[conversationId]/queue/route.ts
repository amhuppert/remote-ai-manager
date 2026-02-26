import { NextResponse } from "next/server";
import { resolveProjectPath } from "@/lib/project-resolver";
import { getSession } from "@/lib/state";
import { getConversation } from "@/lib/conversations";
import { queueMessage } from "@/lib/queue-message";
import { withTracing } from "@/lib/logging";
import type { ApiError } from "@/types";

export const dynamic = "force-dynamic";

/** POST /api/projects/[name]/sessions/[session]/conversations/[conversationId]/queue — queue a message into a running conversation */
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

  // Parse and validate request body
  let text: string;
  try {
    const body = await request.json();
    text = typeof body.text === "string" ? body.text.trim() : "";
  } catch {
    text = "";
  }

  if (!text) {
    return NextResponse.json(
      { error: "Message text is required" } satisfies ApiError,
      { status: 400 },
    );
  }

  // Can only queue into a running conversation
  if (conversation.status !== "running") {
    return NextResponse.json(
      {
        error:
          "Conversation is not running — use the prompt endpoint to send a new message",
        code: "NOT_RUNNING",
      } satisfies ApiError,
      { status: 409 },
    );
  }

  const projectName = projectPath.split("/").pop() ?? projectPath;

  await queueMessage({
    conversationId,
    projectName,
    sessionName,
    text,
  });

  return NextResponse.json({ queued: true });
});
