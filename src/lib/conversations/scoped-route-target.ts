/**
 * The project → (session →) conversation 404 ladder, resolved once into the
 * PUBLIC addressing vocabulary.
 *
 * Handlers that serve both conversation scopes need the same three things —
 * the project's filesystem path, the `ConversationTarget` that addresses the
 * conversation publicly, and the stored row — and each scope reaches them
 * through a different resolver. Composing both adapters here is what lets a
 * scope-invariant handler take one value and never learn which route family
 * called it, and what keeps the project sentinel out of the target it builds:
 * the project variant is constructed by `projectConversationTarget`, which has
 * no field for a session name.
 */

import {
  projectConversationTarget,
  sessionConversationTarget,
  type ConversationTarget,
} from "@/lib/conversations/conversation-target";
import { resolveSessionRoute } from "@/lib/conversations/route-resolution";
import type { ConversationState } from "@/lib/conversations/schemas";
import {
  notFound,
  resolveProjectOr404,
  type RouteResolution,
} from "@/lib/shared/route-resolution";

type RouteContext = { params: Promise<Record<string, string>> };

/** The structural minimum a session must expose for conversation resolution. */
export interface ConversationOwningSession {
  conversations: ConversationState[];
}

export interface ScopedConversationRouteDeps {
  resolveProjectPath(name: string): Promise<string | null>;
  getSession(
    projectPath: string,
    sessionName: string,
  ): Promise<ConversationOwningSession | null>;
  getProjectConversation(
    projectPath: string,
    conversationId: string,
  ): Promise<ConversationState | null>;
}

export interface ScopedConversationTarget {
  projectPath: string;
  /** Public addressing identity — never carries the project sentinel. */
  target: ConversationTarget;
  conversation: ConversationState;
}

/** The shared miss, so neither scope leaks which lookup step failed. */
export function scopedConversationNotFound(): Response {
  return notFound("Conversation not found", "conversation_not_found");
}

export async function resolveSessionScopedConversation(
  deps: ScopedConversationRouteDeps,
  context: RouteContext,
): Promise<RouteResolution<ScopedConversationTarget>> {
  const base = await resolveSessionRoute(deps, context);
  if (!base.ok) return base;

  const params = await context.params;
  const conversationId = params["conversationId"] ?? "";
  const conversation = base.value.session.conversations.find(
    (candidate) => candidate.id === conversationId,
  );
  if (!conversation) {
    return { ok: false, response: scopedConversationNotFound() };
  }
  return {
    ok: true,
    value: {
      projectPath: base.value.projectPath,
      target: sessionConversationTarget(
        params["name"] ?? "",
        base.value.sessionName,
        conversationId,
      ),
      conversation,
    },
  };
}

export async function resolveProjectScopedConversation(
  deps: ScopedConversationRouteDeps,
  context: RouteContext,
): Promise<RouteResolution<ScopedConversationTarget>> {
  const params = await context.params;
  const projectName = params["name"] ?? "";
  const project = await resolveProjectOr404(deps, projectName);
  if (!project.ok) return project;

  const conversationId = params["conversationId"] ?? "";
  const conversation = await deps.getProjectConversation(
    project.value,
    conversationId,
  );
  if (!conversation) {
    return { ok: false, response: scopedConversationNotFound() };
  }
  return {
    ok: true,
    value: {
      projectPath: project.value,
      target: projectConversationTarget(projectName, conversationId),
      conversation,
    },
  };
}
