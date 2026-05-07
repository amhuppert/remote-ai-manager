import { NextResponse } from "next/server";
import { resolveProjectPath } from "@/lib/project-resolver";
import { getSession } from "@/lib/state";
import { abortConversation } from "@/lib/abort-registry";
import { rejectQuestionsForConversation } from "@/lib/question-registry";
import { sendConversationEvent } from "@/lib/workflows/conversation/manager";
import {
  conversationRuntimeKey,
  rejectActiveQuestionResolver,
} from "@/lib/workflows/conversation/runtime-state";
import { withTracing } from "@/lib/logging";
import type { ApiError } from "@/types";

export const dynamic = "force-dynamic";

/** POST /api/projects/[name]/sessions/[session]/conversations/[conversationId]/abort — abort a running prompt */
export const POST = withTracing(async (_request, { params }) => {
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

  // Reject any pending AskUserQuestion for this conversation (legacy registry).
  rejectQuestionsForConversation(conversationId, "Prompt aborted by user");

  // Reject the runtime-scoped resolver used by the MCP AskUserQuestion tool.
  rejectActiveQuestionResolver(
    conversationRuntimeKey(projectPath, sessionName, conversationId),
    "Prompt aborted by user",
  );

  // Signal the AbortController to stop SDK execution
  const aborted = abortConversation(conversationId);

  // Send ABORT_TURN to the machine for a clean state transition
  sendConversationEvent(projectPath, sessionName, conversationId, {
    type: "ABORT_TURN",
    reason: "user",
  });

  if (!aborted) {
    return NextResponse.json(
      { error: "No running prompt to abort" } satisfies ApiError,
      { status: 409 },
    );
  }

  return NextResponse.json({ ok: true });
});
