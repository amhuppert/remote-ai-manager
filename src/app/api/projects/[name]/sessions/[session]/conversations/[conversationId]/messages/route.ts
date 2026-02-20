import { NextResponse } from "next/server";
import { resolveProjectPath } from "@/lib/project-resolver";
import { getSession } from "@/lib/state";
import { getConversation } from "@/lib/conversations";
import { readConversationMessages } from "@/lib/transcript";
import { withTracing } from "@/lib/logging";
import type { ApiError } from "@/types";

export const dynamic = "force-dynamic";

/** GET /api/projects/[name]/sessions/[session]/conversations/[conversationId]/messages — get transcript messages */
export const GET = withTracing(async (_request, { params }) => {
  const { name, session, conversationId } = await params;
  const projectPath = await resolveProjectPath(name ?? "");
  if (!projectPath) {
    return NextResponse.json(
      { error: "Project not found" } satisfies ApiError,
      { status: 404 },
    );
  }

  const sessionState = await getSession(projectPath, session ?? "");
  if (!sessionState) {
    return NextResponse.json(
      { error: "Session not found" } satisfies ApiError,
      { status: 404 },
    );
  }

  const conversation = await getConversation(
    projectPath,
    session ?? "",
    conversationId ?? "",
  );
  if (!conversation) {
    return NextResponse.json(
      { error: "Conversation not found" } satisfies ApiError,
      { status: 404 },
    );
  }

  try {
    const messages = await readConversationMessages(
      conversation.transcriptPath,
    );
    return NextResponse.json(messages);
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to read messages";
    return NextResponse.json({ error: message } satisfies ApiError, {
      status: 500,
    });
  }
});
