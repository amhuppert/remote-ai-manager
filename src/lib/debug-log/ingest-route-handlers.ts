/**
 * Debug-logs ingest route handler — extracted for dependency injection.
 *
 * Receives instrumented-app POSTs at `/api/debug-logs?conversationId=...` and
 * appends valid entries to the conversation's debug log file. Drops with a
 * structured 202 body when debug mode is inactive, recording is paused, the
 * conversation is unknown, or the body cannot be parsed. Open CORS so
 * same-LAN clients can probe without a preflight rejection.
 */

import { NextResponse } from "next/server";
import {
  readState as defaultReadState,
  getSession as defaultGetSession,
} from "@/lib/state-store";
import { resolveProjectPath as defaultResolveProjectPath } from "@/lib/projects/resolver";
import { debugLogEntrySchema } from "@/lib/debug-log/schemas";
import {
  appendDebugLogEntry as defaultAppendDebugLogEntry,
  getDebugLogStats as defaultGetDebugLogStats,
} from "@/lib/debug-log/service";
import { getDefaultDebugAdapter } from "@/lib/workflows/conversation/debug-adapter";
import { createLogger } from "@/lib/logging";
import type { ConversationState } from "@/lib/conversations/schemas";
import type { DebugLogEntry } from "@/lib/debug-log/schemas";
import type { SessionState } from "@/lib/sessions/schemas";
const logger = createLogger("debug-logs-ingest");

/**
 * Header that probe-generated POSTs MUST set so the receiver — and any
 * fetch-instrumentation wrapper — can recognize "this request is a debug
 * log being sent" and short-circuit. Without this guard, instrumenting
 * the debug-log path itself produces an infinite POST loop when the
 * agent self-debugs Command Center's debug mode.
 */
const DEBUG_LOG_SELF_HEADER = "x-cc-debug-log";

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": `content-type, ${DEBUG_LOG_SELF_HEADER}`,
};

interface ConversationContext {
  projectName: string;
  sessionName: string;
  conversation: ConversationState;
  session: SessionState;
}

export interface DebugLogsIngestDeps {
  readState: typeof defaultReadState;
  getSession(
    projectPath: string,
    sessionName: string,
  ): Promise<SessionState | null>;
  resolveProjectPath(name: string, baseDir?: string): Promise<string | null>;
  appendDebugLogEntry(logFilePath: string, entry: DebugLogEntry): void;
  getDebugLogStats(logFilePath: string): {
    entryCount: number;
    hypothesesSeen: string[];
  };
  publishDebugLogReceived(input: {
    projectName: string;
    sessionName: string;
    conversationId: string;
    entryCount: number;
  }): void;
}

const defaultDeps: DebugLogsIngestDeps = {
  readState: defaultReadState,
  getSession: defaultGetSession,
  resolveProjectPath: defaultResolveProjectPath,
  appendDebugLogEntry: defaultAppendDebugLogEntry,
  getDebugLogStats: defaultGetDebugLogStats,
  publishDebugLogReceived: (input) => {
    getDefaultDebugAdapter().publishDebugLogReceived(input);
  },
};

function corsJson(body: Record<string, unknown>, status: number): NextResponse {
  return NextResponse.json(body, { status, headers: CORS_HEADERS });
}

export function createDebugLogsIngestHandlers(
  deps: DebugLogsIngestDeps = defaultDeps,
) {
  async function lookupByHints(
    projectNameHint: string,
    sessionNameHint: string,
    conversationId: string,
  ): Promise<ConversationContext | null> {
    const projectPath = await deps.resolveProjectPath(projectNameHint);
    if (!projectPath) return null;
    const session = await deps.getSession(projectPath, sessionNameHint);
    if (!session) return null;
    const conversation = session.conversations.find(
      (c) => c.id === conversationId,
    );
    if (!conversation) return null;
    return {
      projectName: projectNameHint,
      sessionName: session.sessionName,
      conversation,
      session,
    };
  }

  async function scanForConversation(
    conversationId: string,
  ): Promise<ConversationContext | null> {
    const state = await deps.readState();
    for (const [projectName, project] of Object.entries(state.projects)) {
      for (const [, session] of Object.entries(project.sessions)) {
        const conversation = session.conversations.find(
          (c) => c.id === conversationId,
        );
        if (conversation) {
          return {
            projectName,
            sessionName: session.sessionName,
            conversation,
            session,
          };
        }
      }
    }
    return null;
  }

  function OPTIONS(): NextResponse {
    return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
  }

  async function POST(request: Request): Promise<NextResponse> {
    if (request.headers.get(DEBUG_LOG_SELF_HEADER)) {
      logger.debug("debug_logs.dropped", {
        action: "dropped",
        dropReason: "self_log",
      });
      return corsJson({ accepted: 0, dropped: 1, reason: "self_log" }, 202);
    }

    const url = new URL(request.url);
    const conversationId = url.searchParams.get("conversationId");
    const projectNameHint = url.searchParams.get("projectName");
    const sessionNameHint = url.searchParams.get("sessionName");

    if (!conversationId) {
      logger.info("debug_logs.dropped", {
        conversationId: null,
        action: "dropped",
        dropReason: "missing_conversation_id",
      });
      return corsJson(
        { accepted: 0, dropped: 1, reason: "missing_conversation_id" },
        202,
      );
    }

    let ctx: ConversationContext | null = null;
    if (projectNameHint && sessionNameHint) {
      ctx = await lookupByHints(
        projectNameHint,
        sessionNameHint,
        conversationId,
      );
    }
    if (!ctx) {
      ctx = await scanForConversation(conversationId);
    }

    if (!ctx) {
      logger.info("debug_logs.dropped", {
        conversationId,
        projectName: projectNameHint ?? null,
        sessionName: sessionNameHint ?? null,
        action: "dropped",
        dropReason: "unknown_conversation",
      });
      return corsJson(
        { accepted: 0, dropped: 1, reason: "unknown_conversation" },
        202,
      );
    }

    if (!ctx.conversation.debugMode?.active) {
      logger.info("debug_logs.dropped", {
        conversationId,
        projectName: ctx.projectName,
        sessionName: ctx.sessionName,
        action: "dropped",
        dropReason: "debug_mode_inactive",
      });
      return corsJson(
        { accepted: 0, dropped: 1, reason: "debug_mode_inactive" },
        202,
      );
    }

    if (!ctx.conversation.debugMode.recording) {
      logger.info("debug_logs.dropped", {
        conversationId,
        projectName: ctx.projectName,
        sessionName: ctx.sessionName,
        action: "dropped",
        dropReason: "recording_paused",
      });
      return corsJson(
        { accepted: 0, dropped: 1, reason: "recording_paused" },
        202,
      );
    }

    const logFilePath = ctx.conversation.debugMode.logFilePath;

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      logger.info("debug_logs.dropped", {
        conversationId,
        projectName: ctx.projectName,
        sessionName: ctx.sessionName,
        action: "dropped",
        dropReason: "invalid_json",
      });
      return corsJson({ accepted: 0, dropped: 1, reason: "invalid_json" }, 202);
    }

    const entries = Array.isArray(body) ? body : [body];
    let written = 0;

    for (const raw of entries) {
      const result = debugLogEntrySchema.safeParse(raw);
      if (result.success) {
        deps.appendDebugLogEntry(logFilePath, result.data);
        written++;
      }
    }

    const dropped = entries.length - written;

    if (written > 0) {
      const stats = deps.getDebugLogStats(logFilePath);
      deps.publishDebugLogReceived({
        projectName: ctx.projectName,
        sessionName: ctx.sessionName,
        conversationId,
        entryCount: stats.entryCount,
      });
    }

    logger.info("debug_logs.accepted", {
      conversationId,
      projectName: ctx.projectName,
      sessionName: ctx.sessionName,
      action: "accepted",
      writtenEntries: written,
      droppedEntries: dropped,
    });

    return corsJson({ accepted: written, dropped }, 202);
  }

  return { OPTIONS, POST };
}

// ---------------------------------------------------------------------------
// Default named exports — consumed directly by route shells
// ---------------------------------------------------------------------------

const _defaultDebugLogsIngestHandlers = createDebugLogsIngestHandlers();
export const debugLogsIngestOptions = _defaultDebugLogsIngestHandlers.OPTIONS;
export const ingestDebugLogs = _defaultDebugLogsIngestHandlers.POST;
