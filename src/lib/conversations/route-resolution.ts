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
  refuseProjectSentinelSessionParam,
  jsonError,
  type RouteResolution,
} from "@/lib/shared/route-resolution";
import type { ConversationState } from "@/lib/conversations/schemas";
import type { SessionState } from "@/lib/sessions/schemas";

type RouteContext = { params: Promise<Record<string, string>> };

export interface SessionRouteDeps<S = SessionState> {
  resolveProjectPath(name: string): Promise<string | null>;
  getSession(projectPath: string, sessionName: string): Promise<S | null>;
}

export interface ResolvedSessionRoute<S = SessionState> {
  projectPath: string;
  sessionName: string;
  session: S;
}

/**
 * The structural minimum a session must expose for conversation resolution.
 * Generic so handlers whose deps narrow the session shape (e.g. only
 * `conversations`) resolve without widening to the full `SessionState`.
 */
export interface ConversationOwningSession {
  conversations: ConversationState[];
}

export interface ResolvedSessionConversationRoute<
  S = SessionState,
> extends ResolvedSessionRoute<S> {
  conversationId: string;
  conversation: ConversationState;
}

/**
 * Resolve project + session, or an error Response: a 400 refusal when the public
 * session position carries the internal project sentinel, else a 404 on a
 * project/session miss.
 */
export async function resolveSessionRoute<S = SessionState>(
  deps: SessionRouteDeps<S>,
  context: RouteContext,
): Promise<RouteResolution<ResolvedSessionRoute<S>>> {
  const params = await context.params;
  const projectName = params["name"] ?? "";
  const sessionName = decodeURIComponent(params["session"] ?? "");

  // Before project resolution: the addressing shape is wrong regardless of
  // whether the project exists, and the caller needs the project route named.
  const refusal = refuseProjectSentinelSessionParam(
    sessionName,
    projectName,
    params["conversationId"],
  );
  if (refusal) return { ok: false, response: refusal };

  const project = await resolveProjectOr404(deps, projectName);
  if (!project.ok) return project;

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
export async function resolveSessionConversationRoute<
  S extends ConversationOwningSession = SessionState,
>(
  deps: SessionRouteDeps<S>,
  context: RouteContext,
): Promise<RouteResolution<ResolvedSessionConversationRoute<S>>> {
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
