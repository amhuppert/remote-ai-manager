/**
 * Reserved session-name value that addresses the project-conversation repo
 * through the otherwise session-keyed state-store / runtime / lock / actor
 * APIs. A real session may never use this name — session creation rejects it.
 *
 * This module is intentionally dependency-free so it is safe to import from
 * client components and from schema modules without pulling server-only code.
 */
export const PROJECT_CONVERSATION_SESSION_SENTINEL = "__project__";

/** True when a session-keyed API call is actually addressing the project repo. */
export function isProjectSentinel(sessionName: string): boolean {
  return sessionName === PROJECT_CONVERSATION_SESSION_SENTINEL;
}

/**
 * Scope-discriminated identity fields for a conversation SSE event, derived from
 * a session-keyed call site. When the call addresses the project sentinel the
 * event is the `scope:"project"` variant (no `sessionName`); otherwise it is the
 * wire-compatible `scope:"session"` variant. Shared producers (the conversation
 * machine, transcript, queue, mark-unread) spread this into their event payload
 * so a single code path emits the correct variant for both scopes.
 */
export type ConversationEventScopeFields =
  | {
      scope: "session";
      projectName: string;
      sessionName: string;
      conversationId: string;
    }
  | { scope: "project"; projectName: string; conversationId: string };

export function conversationEventScopeFields(
  projectName: string,
  sessionName: string,
  conversationId: string,
): ConversationEventScopeFields {
  if (isProjectSentinel(sessionName)) {
    return { scope: "project", projectName, conversationId };
  }
  return { scope: "session", projectName, sessionName, conversationId };
}
