import type { ActiveConversationsResponse } from "@/lib/active-conversations/schemas";
import type { PublicConversationState } from "@/lib/conversations/schemas";
import type { PublicSessionState } from "@/lib/sessions/schemas";
import type { SessionListItem } from "@/lib/sessions/list-schemas";

export function withSessionsArchived(
  sessions: SessionListItem[] | undefined,
  sessionNames: ReadonlySet<string>,
  archived: boolean,
): SessionListItem[] | undefined {
  return sessions?.map((session) =>
    sessionNames.has(session.sessionName) ? { ...session, archived } : session,
  );
}

export function withoutSessions(
  sessions: SessionListItem[] | undefined,
  sessionNames: ReadonlySet<string>,
): SessionListItem[] | undefined {
  return sessions?.filter((session) => !sessionNames.has(session.sessionName));
}

export function withoutSessionsActiveConversations(
  active: ActiveConversationsResponse | undefined,
  projectName: string,
  sessionNames: ReadonlySet<string>,
): ActiveConversationsResponse | undefined {
  if (active === undefined) return undefined;
  return {
    ...active,
    conversations: active.conversations.filter(
      (conversation) =>
        !(
          conversation.scope === "session" &&
          conversation.projectName === projectName &&
          sessionNames.has(conversation.sessionName)
        ),
    ),
  };
}

/**
 * The cached session detail with a just-created conversation added. Returns
 * undefined for an unfetched detail so a `setQueryData` updater leaves the
 * entry absent: a session seeded from one conversation would lack every other
 * field, and the first real fetch must stay the only way the entry appears. A
 * row already present is kept as is — a creation frame or response never
 * carries newer state than a cache that has since observed the conversation.
 */
export function withCreatedConversation(
  session: PublicSessionState | undefined,
  conversation: PublicConversationState,
): PublicSessionState | undefined {
  if (session === undefined) return undefined;
  if (session.conversations.some((row) => row.id === conversation.id)) {
    return session;
  }
  return {
    ...session,
    conversations: [...session.conversations, conversation],
  };
}
