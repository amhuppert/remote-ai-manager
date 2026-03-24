/**
 * Debug log stats route handler — extracted for dependency injection.
 *
 * Returns the current entry count for a conversation's debug log file.
 */

import { NextResponse } from "next/server";
import { resolveProjectPath as defaultResolveProjectPath } from "@/lib/project-resolver";
import { getSession as defaultGetSession } from "@/lib/state";
import { getDebugLogStats as defaultGetDebugLogStats } from "@/lib/debug-log";
import type { ApiError, SessionState } from "@/types";

// ---------------------------------------------------------------------------
// Deps interface
// ---------------------------------------------------------------------------

export interface DebugLogStatsDeps {
  resolveProjectPath(name: string): Promise<string | null>;
  getSession(
    projectPath: string,
    sessionName: string,
  ): Promise<SessionState | null>;
  getDebugLogStats(logFilePath: string): {
    entryCount: number;
    hypothesesSeen: string[];
  };
}

const defaultDeps: DebugLogStatsDeps = {
  resolveProjectPath: defaultResolveProjectPath,
  getSession: defaultGetSession,
  getDebugLogStats: defaultGetDebugLogStats,
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type RouteContext = {
  params: Promise<Record<string, string>>;
};

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createDebugLogStatsHandlers(
  deps: DebugLogStatsDeps = defaultDeps,
) {
  async function GET(
    _request: Request,
    context: RouteContext,
  ): Promise<Response> {
    const resolvedParams = await context.params;
    const name = resolvedParams["name"] ?? "";
    const sessionSlug = resolvedParams["session"] ?? "";
    const sessionName = decodeURIComponent(sessionSlug);
    const conversationId = resolvedParams["conversationId"] ?? "";

    const projectPath = await deps.resolveProjectPath(name);
    if (!projectPath) {
      return NextResponse.json(
        { error: "Project not found" } satisfies ApiError,
        { status: 404 },
      );
    }

    const session = await deps.getSession(projectPath, sessionName);
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

    const stats = deps.getDebugLogStats(conversation.debugMode.logFilePath);
    return NextResponse.json({ entryCount: stats.entryCount });
  }

  return { GET };
}
