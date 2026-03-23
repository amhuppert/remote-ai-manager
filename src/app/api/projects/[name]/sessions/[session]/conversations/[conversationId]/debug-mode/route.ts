import { NextResponse } from "next/server";
import { resolveProjectPath } from "@/lib/project-resolver";
import { getSession } from "@/lib/state";
import { debugModeRequestSchema } from "@/lib/schemas";
import { withTracing } from "@/lib/logging";
import { ensureDebugDir, getDebugLogPath } from "@/lib/debug-log";
import {
  ensureConversationActor,
  sendConversationEvent,
} from "@/lib/workflows/conversation/manager";
import type { ApiError } from "@/types";

export const dynamic = "force-dynamic";

/** POST /api/projects/[name]/sessions/[session]/conversations/[conversationId]/debug-mode — enter/exit debug mode */
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

  let body: {
    action: "enter" | "exit" | "mark_reproduced" | "mark_fix_verified";
  };
  try {
    body = debugModeRequestSchema.parse(await request.json());
  } catch {
    return NextResponse.json(
      { error: "valid action is required" } satisfies ApiError,
      { status: 400 },
    );
  }

  try {
    await ensureConversationActor(projectPath, sessionName, conversationId);

    switch (body.action) {
      case "enter": {
        if (conversation.debugMode?.active) {
          return NextResponse.json(
            { error: "Already in debug mode" } satisfies ApiError,
            { status: 409 },
          );
        }
        ensureDebugDir(session.worktreePath);
        const logFilePath = getDebugLogPath(session.worktreePath);
        sendConversationEvent(projectPath, sessionName, conversationId, {
          type: "ENTER_DEBUG_MODE",
          logFilePath,
        });
        break;
      }
      case "exit":
        sendConversationEvent(projectPath, sessionName, conversationId, {
          type: "EXIT_DEBUG_MODE",
        });
        break;
      case "mark_reproduced":
        sendConversationEvent(projectPath, sessionName, conversationId, {
          type: "MARK_REPRODUCED",
        });
        break;
      case "mark_fix_verified":
        sendConversationEvent(projectPath, sessionName, conversationId, {
          type: "MARK_FIX_VERIFIED",
        });
        break;
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to toggle debug mode";
    return NextResponse.json({ error: message } satisfies ApiError, {
      status: 500,
    });
  }
});
