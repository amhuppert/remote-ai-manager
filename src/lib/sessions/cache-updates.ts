import type { ActiveConversationsResponse } from "@/lib/active-conversations/schemas";
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
