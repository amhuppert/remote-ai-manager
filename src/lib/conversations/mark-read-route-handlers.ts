/**
 * Route handler for marking a conversation as read.
 *
 * Clears the `unread` flag set when an agent turn finished, broadcasts a
 * `conversation-unread` SSE event (unread=false) so subscribed clients drop
 * the conversation from the "Needs you" pinned slot, and acks the request.
 *
 * Factory-pattern DI so the route handler can be tested without booting the
 * state store, the SSE bus, or project resolution.
 */

import { NextResponse } from "next/server";
import {
  resolveProjectPath as defaultResolveProjectPath,
  getProjectDisplayName as defaultGetProjectDisplayName,
} from "@/lib/projects/resolver";
import {
  getSession as defaultGetSession,
  mutateConversation as defaultMutateConversation,
} from "@/lib/state-store";
import { broadcast as defaultBroadcast } from "@/lib/events/broadcaster";
import type { BroadcastFn } from "@/lib/events/broadcaster";
import {
  conversationUnreadEventSchema,
  type ConversationState,
} from "@/lib/conversations/schemas";
import type { SessionState } from "@/lib/sessions/schemas";
import type { ApiError } from "@/lib/api/errors";
import { createLogger, withTracing } from "@/lib/logging";

const logger = createLogger("conversation-mark-read-route-handlers");

export interface MarkReadRouteDeps {
  resolveProjectPath(name: string): Promise<string | null>;
  getProjectDisplayName(projectPath: string): string;
  getSession(
    projectPath: string,
    sessionName: string,
  ): Promise<SessionState | null>;
  mutateConversation(
    projectPath: string,
    sessionName: string,
    conversationId: string,
    label: string,
    mutate: (conversation: ConversationState) => void | Promise<void>,
  ): Promise<void>;
  broadcast: BroadcastFn;
}

const defaultDeps: MarkReadRouteDeps = {
  resolveProjectPath: defaultResolveProjectPath,
  getProjectDisplayName: defaultGetProjectDisplayName,
  getSession: defaultGetSession,
  mutateConversation: defaultMutateConversation,
  broadcast: defaultBroadcast,
};

type RouteContext = { params: Promise<Record<string, string>> };

export function createMarkReadRouteHandlers(
  deps: MarkReadRouteDeps = defaultDeps,
) {
  async function POST(
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

    await deps.mutateConversation(
      projectPath,
      sessionName,
      conversationId,
      "conversation.mark-read",
      (c) => {
        c.unread = false;
      },
    );

    const projectName = deps.getProjectDisplayName(projectPath);
    try {
      const event = conversationUnreadEventSchema.parse({
        type: "conversation-unread",
        projectName,
        sessionName,
        conversationId,
        unread: false,
      });
      deps.broadcast(event);
    } catch (err) {
      logger.warn("conversation_mark_read.broadcast_failed", {
        projectName,
        sessionName,
        conversationId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    return NextResponse.json({ ok: true });
  }

  return { POST };
}

const _defaultHandlers = createMarkReadRouteHandlers();
export const markConversationRead = withTracing(_defaultHandlers.POST);
