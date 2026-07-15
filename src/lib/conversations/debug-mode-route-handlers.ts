/**
 * Debug-mode route handlers for a conversation.
 *
 * - POST .../debug-mode — enter/exit debug mode and dispatch phase actions
 * - GET  .../debug-mode/logs — return debug log entry count
 * - DELETE .../debug-mode/logs — clear the debug log file
 * - POST .../debug-mode/recording — start/stop debug log recording
 */

import { NextResponse } from "next/server";
import { resolveProjectPath } from "@/lib/projects/resolver";
import { getSession } from "@/lib/state-store";
import {
  debugModeRequestSchema,
  debugRecordingRequestSchema,
} from "@/lib/debug-log/schemas";
import { withTracing } from "@/lib/logging";
import {
  ensureDebugDir,
  getDebugLogPath,
  clearDebugLog,
} from "@/lib/debug-log/service";
import { ensureConversationActor } from "@/lib/workflows/conversation/manager";
import { getDefaultDebugAdapter } from "@/lib/workflows/conversation/debug-adapter";
import { createDebugLogStatsHandlers } from "@/lib/debug-log/stats-route-handlers";
import { resolveSessionConversationRoute } from "./route-resolution";
import type { ApiError } from "@/lib/api/errors";

/** POST /api/projects/[name]/sessions/[session]/conversations/[conversationId]/debug-mode — enter/exit debug mode */
export const updateDebugMode = withTracing(async (request, { params }) => {
  const resolved = await resolveSessionConversationRoute(
    { resolveProjectPath, getSession },
    { params },
  );
  if (!resolved.ok) return resolved.response;
  const { projectPath, sessionName, conversationId, session, conversation } =
    resolved.value;

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

/** GET .../debug-mode/logs — return debug log entry count */
export const getDebugModeLogs = createDebugLogStatsHandlers().GET;

/** DELETE .../debug-mode/logs — clear the debug log file */
export const deleteDebugModeLogs = withTracing(async (_request, { params }) => {
  const name = (await params)["name"] ?? "";
  const resolved = await resolveSessionConversationRoute(
    { resolveProjectPath, getSession },
    { params },
  );
  if (!resolved.ok) return resolved.response;
  const { sessionName, conversationId, conversation } = resolved.value;

  if (!conversation.debugMode?.active) {
    return NextResponse.json(
      { error: "Conversation is not in debug mode" } satisfies ApiError,
      { status: 409 },
    );
  }

  try {
    clearDebugLog(conversation.debugMode.logFilePath);
    getDefaultDebugAdapter().publishDebugLogReceived({
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

/** POST .../debug-mode/recording — start/stop debug log recording */
export const updateDebugModeRecording = withTracing(
  async (request, { params }) => {
    const resolved = await resolveSessionConversationRoute(
      { resolveProjectPath, getSession },
      { params },
    );
    if (!resolved.ok) return resolved.response;
    const { projectPath, sessionName, conversationId, conversation } =
      resolved.value;

    if (!conversation.debugMode?.active) {
      return NextResponse.json(
        { error: "Conversation is not in debug mode" } satisfies ApiError,
        { status: 409 },
      );
    }

    let body: { recording: boolean };
    try {
      body = debugRecordingRequestSchema.parse(await request.json());
    } catch {
      return NextResponse.json(
        { error: "recording (boolean) is required" } satisfies ApiError,
        { status: 400 },
      );
    }

    try {
      getDefaultDebugAdapter().setRecording(
        { projectPath, sessionName, conversationId },
        body.recording,
      );

      // syncDerivedFields is fire-and-forget in the machine, so the SSE broadcast
      // and query invalidation can race ahead of the persisted write. Await the
      // write here so callers always re-fetch up-to-date recording state.
      const { mutateConversation } = await import("@/lib/state-store");
      await mutateConversation(
        projectPath,
        sessionName,
        conversationId,
        "debug-recording-toggle",
        (c) => {
          if (c.debugMode) c.debugMode.recording = body.recording;
        },
      );

      return NextResponse.json({ ok: true });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to update recording state";
      return NextResponse.json({ error: message } satisfies ApiError, {
        status: 500,
      });
    }
  },
);
