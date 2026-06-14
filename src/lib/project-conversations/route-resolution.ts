/**
 * Project-scoped conversation route resolution.
 *
 * The project adapter of the shared route-resolution seam: turns the
 * project → conversation 404 ladder (no session) into one `RouteResolution`
 * value, mirroring the session adapter's contract so project-scoped handlers
 * thread it the same way.
 */

import {
  resolveProjectOr404,
  jsonError,
  type RouteResolution,
} from "@/lib/shared/route-resolution";
import type { ConversationState } from "@/lib/conversations/schemas";

type RouteContext = { params: Promise<Record<string, string>> };

export interface ProjectConversationResolveDeps {
  resolveProjectPath(name: string): Promise<string | null>;
  getProjectConversation(
    projectPath: string,
    conversationId: string,
  ): Promise<ConversationState | null>;
}

export interface ResolvedProjectConversationRoute {
  projectPath: string;
  conversationId: string;
  conversation: ConversationState;
}

/** Resolve project + the addressed project conversation, or a 404 Response. */
export async function resolveProjectConversationRoute(
  deps: ProjectConversationResolveDeps,
  context: RouteContext,
): Promise<RouteResolution<ResolvedProjectConversationRoute>> {
  const params = await context.params;
  const project = await resolveProjectOr404(deps, params["name"] ?? "");
  if (!project.ok) return project;

  const conversationId = params["conversationId"] ?? "";
  const conversation = await deps.getProjectConversation(
    project.value,
    conversationId,
  );
  if (!conversation) {
    return { ok: false, response: jsonError("Conversation not found", 404) };
  }

  return {
    ok: true,
    value: { projectPath: project.value, conversationId, conversation },
  };
}
