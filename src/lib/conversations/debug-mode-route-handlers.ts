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
import { type CoreDebugCommandOutcome as ConversationCommandOutcome } from "@/lib/conversation-core/debug-mode";
import {
  getDefaultDebugAdapter,
  type DebugAdapter,
} from "@/lib/conversations/debug-adapter";
import { createDebugLogStatsHandlers } from "@/lib/debug-log/stats-route-handlers";
import { resolveSessionConversationRoute } from "./route-resolution";
import type { ApiError } from "@/lib/api/errors";

interface DebugModeRouteDeps {
  resolveProjectPath(name: string): ReturnType<typeof resolveProjectPath>;
  getSession(
    ...args: Parameters<typeof getSession>
  ): ReturnType<typeof getSession>;
  adapter(): DebugAdapter;
}

/** POST /api/projects/[name]/sessions/[session]/conversations/[conversationId]/debug-mode — enter/exit debug mode */
export function createDebugModeHandler(deps: DebugModeRouteDeps) {
  return async (
    request: Request,
    { params }: { params: Promise<Record<string, string>> },
  ) => {
    const resolved = await resolveSessionConversationRoute(
      {
        resolveProjectPath: deps.resolveProjectPath,
        getSession: deps.getSession,
      },
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
      const adapter = deps.adapter();
      const target = { projectPath, sessionName, conversationId };

      let dispatched: ConversationCommandOutcome;
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
          dispatched = await adapter.enterDebugMode(target, { logFilePath });
          break;
        }
        case "exit":
          dispatched = await adapter.exitDebugMode(target);
          break;
        case "mark_reproduced":
          dispatched = await adapter.markReproduced(target);
          break;
        case "mark_fix_verified":
          dispatched = await adapter.markFixVerified(target);
          break;
        case "mark_fix_failed":
          dispatched = await adapter.markFixFailed(target);
          break;
        case "revert_to_awaiting_reproduction":
          dispatched = await adapter.revertToAwaitingReproduction(target);
          break;
        case "revert_to_awaiting_verification":
          dispatched = await adapter.revertToAwaitingVerification(target);
          break;
        case "retry_turn":
          dispatched = await adapter.retryDebugTurn(target);
          break;
      }

      if (dispatched.kind === "refused") {
        return NextResponse.json(
          { error: dispatched.message } satisfies ApiError,
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
  };
}

export const updateDebugMode = withTracing(
  createDebugModeHandler({
    resolveProjectPath,
    getSession,
    adapter: getDefaultDebugAdapter,
  }),
);

/** GET .../debug-mode/logs — return debug log entry count */
export const getDebugModeLogs = withTracing(createDebugLogStatsHandlers().GET);

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
interface DebugRecordingRouteDeps {
  resolveProjectPath(name: string): ReturnType<typeof resolveProjectPath>;
  getSession(
    ...args: Parameters<typeof getSession>
  ): ReturnType<typeof getSession>;
  setRecording(
    target: {
      projectPath: string;
      sessionName: string;
      conversationId: string;
    },
    recording: boolean,
  ): Promise<ConversationCommandOutcome>;
}

export function createDebugModeRecordingHandler(deps: DebugRecordingRouteDeps) {
  return async (
    request: Request,
    { params }: { params: Promise<Record<string, string>> },
  ) => {
    const resolved = await resolveSessionConversationRoute(
      {
        resolveProjectPath: deps.resolveProjectPath,
        getSession: deps.getSession,
      },
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
      const outcome = await deps.setRecording(
        { projectPath, sessionName, conversationId },
        body.recording,
      );

      if (outcome.kind === "refused")
        return NextResponse.json(
          { error: outcome.message } satisfies ApiError,
          { status: 409 },
        );

      return NextResponse.json({ ok: true });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to update recording state";
      return NextResponse.json({ error: message } satisfies ApiError, {
        status: 500,
      });
    }
  };
}

export const updateDebugModeRecording = withTracing(
  createDebugModeRecordingHandler({
    resolveProjectPath,
    getSession,
    setRecording: (target, recording) =>
      getDefaultDebugAdapter().setRecording(target, recording),
  }),
);
