/**
 * Route handler for marking a conversation as read.
 *
 * Clears the `unread` flag set when an agent turn finished, broadcasts a
 * `conversation-unread` SSE event (unread=false) so subscribed clients drop
 * the conversation from the "Needs you" pinned slot, and acks the request.
 * Reading is not conversation activity, so the conversation's and session's
 * `lastActivityAt` (which order the sidebar) stay unchanged.
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
  markConversationRead as defaultMarkConversationRead,
} from "@/lib/state-store";
import { publishEvent, type PublishFn } from "@/lib/events/publication";
import { conversationUnreadEventSchema } from "@/lib/conversations/schemas";
import type { SessionState } from "@/lib/sessions/schemas";
import { resolveSessionConversationRoute } from "./route-resolution";
import { createLogger, withTracing } from "@/lib/logging";
import { getErrorMessage } from "@/lib/shared/errors";

const logger = createLogger("conversation-mark-read-route-handlers");

export interface MarkReadRouteDeps {
  resolveProjectPath(name: string): Promise<string | null>;
  getProjectDisplayName(projectPath: string): string;
  getSession(
    projectPath: string,
    sessionName: string,
  ): Promise<SessionState | null>;
  markConversationRead(
    projectPath: string,
    sessionName: string,
    conversationId: string,
  ): Promise<void>;
  broadcast: PublishFn;
}

const defaultDeps: MarkReadRouteDeps = {
  resolveProjectPath: defaultResolveProjectPath,
  getProjectDisplayName: defaultGetProjectDisplayName,
  getSession: defaultGetSession,
  markConversationRead: defaultMarkConversationRead,
  broadcast: publishEvent,
};

type RouteContext = { params: Promise<Record<string, string>> };

export function createMarkReadRouteHandlers(
  deps: MarkReadRouteDeps = defaultDeps,
) {
  async function POST(
    _request: Request,
    context: RouteContext,
  ): Promise<Response> {
    const resolved = await resolveSessionConversationRoute(deps, context);
    if (!resolved.ok) return resolved.response;
    const { projectPath, sessionName, conversationId } = resolved.value;

    await deps.markConversationRead(projectPath, sessionName, conversationId);

    const projectName = deps.getProjectDisplayName(projectPath);
    try {
      const event = conversationUnreadEventSchema.parse({
        type: "conversation-unread",
        scope: "session",
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
        error: getErrorMessage(err),
      });
    }

    return NextResponse.json({ ok: true });
  }

  return { POST };
}

const _defaultHandlers = createMarkReadRouteHandlers();
export const markConversationRead = withTracing(_defaultHandlers.POST);
