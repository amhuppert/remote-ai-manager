import { sessionConversationTarget } from "@/lib/conversations/conversation-target";
import type { ConversationBinding } from "@/lib/workflows/conversation/turn-spec";
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
import {
  type ConversationCommandOutcome,
  ensureConversationLifecycle,
} from "@/lib/workflows/conversation/manager";
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
    await ensureConversationLifecycle({
      kind: "durable",
      address: {
        projectPath,
        target: sessionConversationTarget(
          (await params)["name"] ?? "",
          sessionName,
          conversationId,
        ),
      },
    });
    const adapter = getDefaultDebugAdapter();
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
  ensureConversation(binding: ConversationBinding): Promise<void>;
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
      await deps.ensureConversation({
        kind: "durable",
        address: {
          projectPath,
          target: sessionConversationTarget(
            (await params)["name"] ?? "",
            sessionName,
            conversationId,
          ),
        },
      });
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
    ensureConversation: ensureConversationLifecycle,
    setRecording: (target, recording) =>
      getDefaultDebugAdapter().setRecording(target, recording),
  }),
);
