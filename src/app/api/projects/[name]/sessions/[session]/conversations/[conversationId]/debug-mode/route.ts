import { NextResponse } from "next/server";
import { resolveProjectPath } from "@/lib/project-resolver";
import { getSession } from "@/lib/state";
import { debugModeRequestSchema } from "@/lib/schemas";
import { withTracing } from "@/lib/logging";
import { ensureDebugDir, getDebugLogPath } from "@/lib/debug-log";
import { ensureConversationActor } from "@/lib/workflows/conversation/manager";
import { getDefaultDebugAdapter } from "@/lib/workflows/conversation/debug-adapter";
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

  let body: ReturnType<typeof debugModeRequestSchema.parse>;
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
    const adapter = getDefaultDebugAdapter();
    const target = { projectPath, sessionName, conversationId };

    let dispatched: boolean;
    switch (body.action) {
      case "enter": {
        if (conversation.debugMode?.active) {
          return NextResponse.json(
            { error: "Already in debug mode" } satisfies ApiError,
            { status: 409 },
          );
        }
        ensureDebugDir(session.worktreePath, conversationId);
        const logFilePath = getDebugLogPath(
          session.worktreePath,
          conversationId,
        );
        dispatched = adapter.enterDebugMode(target, { logFilePath });
        break;
      }
      case "exit":
        dispatched = adapter.exitDebugMode(target);
        break;
      case "mark_reproduced":
        dispatched = adapter.markReproduced(target);
        break;
      case "mark_fix_verified":
        dispatched = adapter.markFixVerified(target);
        break;
      case "mark_fix_failed":
        dispatched = adapter.markFixFailed(target);
        break;
      case "revert_to_awaiting_reproduction":
        dispatched = adapter.revertToAwaitingReproduction(target);
        break;
      case "revert_to_awaiting_verification":
        dispatched = adapter.revertToAwaitingVerification(target);
        break;
      case "retry_turn":
        dispatched = adapter.retryDebugTurn(target);
        break;
    }

    if (!dispatched) {
      return NextResponse.json(
        {
          error: `Action '${body.action}' is not valid in the current debug phase`,
        } satisfies ApiError,
        { status: 409 },
      );
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
