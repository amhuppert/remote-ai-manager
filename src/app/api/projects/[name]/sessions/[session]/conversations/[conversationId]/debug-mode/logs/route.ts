import { NextResponse } from "next/server";
import { resolveProjectPath } from "@/lib/project-resolver";
import { getSession } from "@/lib/state";
import { clearDebugLog } from "@/lib/debug-log";
import { withTracing } from "@/lib/logging";
import { broadcast } from "@/lib/sse-broadcaster";
import { createDebugLogStatsHandlers } from "@/lib/debug-log-stats-route-handlers";
import type { ApiError } from "@/types";

export const dynamic = "force-dynamic";

/** GET .../debug-mode/logs — return debug log entry count */
export const GET = createDebugLogStatsHandlers().GET;

/** DELETE .../debug-mode/logs — clear the debug log file */
export const DELETE = withTracing(async (_request, { params }) => {
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

  if (!conversation.debugMode?.active) {
    return NextResponse.json(
      { error: "Conversation is not in debug mode" } satisfies ApiError,
      { status: 409 },
    );
  }

  try {
    clearDebugLog(conversation.debugMode.logFilePath);
    broadcast({
      type: "debug-log-received",
      projectName: name,
      sessionName,
      conversationId,
      entryCount: 0,
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to clear debug logs";
    return NextResponse.json({ error: message } satisfies ApiError, {
      status: 500,
    });
  }
});
