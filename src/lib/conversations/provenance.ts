import { isEligibleOwner } from "./owner-eligibility";
import type { ConversationState } from "./schemas";
import type { ConversationsRepo } from "@/lib/state-store/conversations-repo";
import type { ProjectConversationsRepo } from "@/lib/state-store/project-conversations-repo";
import type { SessionsRepo } from "@/lib/state-store/sessions-repo";
import { createConversationsRepo } from "@/lib/state-store/conversations-repo";
import { createProjectConversationsRepo } from "@/lib/state-store/project-conversations-repo";
import { createSessionsRepo } from "@/lib/state-store/sessions-repo";
import { getStateDb } from "@/lib/state-store/store";
import { getGlobalSingleton } from "@/lib/shared/global-singleton";

export interface DurableConversationIdentity {
  projectPath: string;
  sessionName: string | null;
  sessionArchived: boolean;
  conversation: ConversationState;
}

export interface ConversationProvenanceDeps {
  conversations: ConversationsRepo;
  projectConversations: ProjectConversationsRepo;
  sessions: SessionsRepo;
}

export function createConversationProvenanceReader(
  deps: ConversationProvenanceDeps,
) {
  return function readConversation(
    conversationId: string,
  ): DurableConversationIdentity | null {
    const session = deps.conversations.findByIdWithKey(conversationId);
    if (session) {
      const parent = deps.sessions.findByKey(
        session.projectPath,
        session.sessionName,
      );
      return parent ? { ...session, sessionArchived: parent.archived } : null;
    }
    const project =
      deps.projectConversations.findByIdWithProject(conversationId);
    return project
      ? { ...project, sessionName: null, sessionArchived: false }
      : null;
  };
}

export function isEligibleSubscriptionRecipient(
  identity: DurableConversationIdentity | null,
  projectPath: string,
): boolean {
  return (
    identity !== null &&
    identity.projectPath === projectPath &&
    isEligibleOwner(identity.conversation, identity.sessionArchived)
  );
}

/** Verifies transport provenance; it grants no workflow or source authority. */
export function verifyDurableConversationIdentity(
  conversationId: string,
): boolean {
  const reader = getGlobalSingleton(
    "__cc_conversation_provenance_reader",
    () => {
      const db = getStateDb();
      return createConversationProvenanceReader({
        conversations: createConversationsRepo(db),
        projectConversations: createProjectConversationsRepo(db),
        sessions: createSessionsRepo(db),
      });
    },
  );
  return reader(conversationId) !== null;
}
