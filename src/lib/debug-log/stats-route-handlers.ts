/**
 * Debug log stats route handler — extracted for dependency injection.
 *
 * Returns the current entry count for a conversation's debug log file.
 */

import { NextResponse } from "next/server";
import { resolveSessionConversationRoute } from "@/lib/conversations/route-resolution";
import { resolveProjectPath as defaultResolveProjectPath } from "@/lib/projects/resolver";
import { getSession as defaultGetSession } from "@/lib/state-store";
import { getDebugLogStats as defaultGetDebugLogStats } from "@/lib/debug-log/service";
import type { ApiError } from "@/lib/api/errors";
import type { SessionState } from "@/lib/sessions/schemas";
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
    const resolved = await resolveSessionConversationRoute(deps, context);
    if (!resolved.ok) return resolved.response;
    const { conversation } = resolved.value;

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
