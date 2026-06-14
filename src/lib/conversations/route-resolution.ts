/**
 * Session-scoped conversation route resolution.
 *
 * The session adapter of the shared route-resolution seam: turns the
 * project → session → conversation 404 ladder into one `RouteResolution`
 * value so session-scoped handlers thread it with
 * `if (!r.ok) return r.response;`.
 */

import {
  resolveProjectOr404,
  jsonError,
  type RouteResolution,
} from "@/lib/shared/route-resolution";
import type { ConversationState } from "@/lib/conversations/schemas";
import type { SessionState } from "@/lib/sessions/schemas";

type RouteContext = { params: Promise<Record<string, string>> };

export interface SessionRouteDeps {
  resolveProjectPath(name: string): Promise<string | null>;
  getSession(
    projectPath: string,
    sessionName: string,
  ): Promise<SessionState | null>;
}

export interface ResolvedSessionRoute {
  projectPath: string;
  sessionName: string;
  session: SessionState;
}

export interface ResolvedSessionConversationRoute extends ResolvedSessionRoute {
  conversationId: string;
  conversation: ConversationState;
}

/** Resolve project + session, or a 404 Response. */
export async function resolveSessionRoute(
  deps: SessionRouteDeps,
  context: RouteContext,
): Promise<RouteResolution<ResolvedSessionRoute>> {
  const params = await context.params;
  const project = await resolveProjectOr404(deps, params["name"] ?? "");
  if (!project.ok) return project;

  const sessionName = decodeURIComponent(params["session"] ?? "");
  const session = await deps.getSession(project.value, sessionName);
  if (!session) {
    return { ok: false, response: jsonError("Session not found", 404) };
  }

  return {
    ok: true,
    value: { projectPath: project.value, sessionName, session },
  };
}

/** Resolve project + session + the addressed conversation, or a 404 Response. */
export async function resolveSessionConversationRoute(
  deps: SessionRouteDeps,
  context: RouteContext,
): Promise<RouteResolution<ResolvedSessionConversationRoute>> {
  const base = await resolveSessionRoute(deps, context);
  if (!base.ok) return base;

  const params = await context.params;
  const conversationId = params["conversationId"] ?? "";
  const conversation = base.value.session.conversations.find(
    (c) => c.id === conversationId,
  );
  if (!conversation) {
    return { ok: false, response: jsonError("Conversation not found", 404) };
  }

  return { ok: true, value: { ...base.value, conversationId, conversation } };
}
