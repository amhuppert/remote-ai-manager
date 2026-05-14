/**
 * Queue route handler logic — extracted for dependency injection.
 *
 * Route files delegate to these handlers, passing production deps.
 * Tests create handlers with mock deps via `createQueueRouteHandlers(deps)`.
 */

import { NextResponse } from "next/server";
import { resolveProjectPath as defaultResolveProjectPath } from "@/lib/project-resolver";
import { getProjectDisplayName as defaultGetProjectDisplayName } from "@/lib/project-resolver";
import { getSession as defaultGetSession } from "@/lib/state";
import {
  getConversation as defaultGetConversation,
  setConversationPendingPromptText as defaultSetConversationPendingPromptText,
} from "@/lib/conversations";
import { queueMessage as defaultQueueMessage } from "@/lib/queue-message";
import type { ConversationState, SessionState, ApiError } from "@/types";

// ---------------------------------------------------------------------------
// Deps interface
// ---------------------------------------------------------------------------

export interface QueueRouteDeps {
  resolveProjectPath: (name: string) => Promise<string | null>;
  getSession: (
    projectPath: string,
    sessionName: string,
  ) => Promise<SessionState | null>;
  getConversation: (
    projectPath: string,
    sessionName: string,
    conversationId: string,
  ) => Promise<ConversationState | null>;
  getProjectDisplayName: (projectPath: string) => string;
  queueMessage: (params: {
    conversationId: string;
    projectName: string;
    sessionName: string;
    text: string;
  }) => Promise<void>;
  setConversationPendingPromptText(
    projectPath: string,
    sessionName: string,
    conversationId: string,
    text: string | null,
  ): Promise<void>;
}

const defaultDeps: QueueRouteDeps = {
  resolveProjectPath: defaultResolveProjectPath,
  getSession: defaultGetSession,
  getConversation: defaultGetConversation,
  getProjectDisplayName: defaultGetProjectDisplayName,
  queueMessage: defaultQueueMessage,
  setConversationPendingPromptText: defaultSetConversationPendingPromptText,
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

export function createQueueRouteHandlers(deps: QueueRouteDeps = defaultDeps) {
  async function POST(
    request: Request,
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

    const conversation = await deps.getConversation(
      projectPath,
      sessionName,
      conversationId,
    );
    if (!conversation) {
      return NextResponse.json(
        { error: "Conversation not found" } satisfies ApiError,
        { status: 404 },
      );
    }

    // Parse and validate request body
    let text: string;
    try {
      const body = await request.json();
      text = typeof body.text === "string" ? body.text.trim() : "";
    } catch {
      text = "";
    }

    if (!text) {
      return NextResponse.json(
        { error: "Message text is required" } satisfies ApiError,
        { status: 400 },
      );
    }

    // Can only queue into a running conversation
    if (conversation.status !== "running") {
      return NextResponse.json(
        {
          error:
            "Conversation is not running — use the prompt endpoint to send a new message",
          code: "NOT_RUNNING",
        } satisfies ApiError,
        { status: 409 },
      );
    }

    const projectName = deps.getProjectDisplayName(projectPath);

    // The user is submitting their draft via the queue path — clear the
    // persisted pending prompt text so it isn't resurrected on remount.
    await deps.setConversationPendingPromptText(
      projectPath,
      sessionName,
      conversationId,
      null,
    );

    await deps.queueMessage({
      conversationId,
      projectName,
      sessionName,
      text,
    });

    return NextResponse.json({ queued: true });
  }

  return { POST };
}
