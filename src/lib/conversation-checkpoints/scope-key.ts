import { isProjectSentinel } from "@/lib/conversations/project-conversation-scope";
import type { CheckpointScopeKey } from "./schemas";

/** The checkpoint scope of a conversation addressed by its state-store identity. */
export function checkpointScopeKeyForStoreIdentity(identity: {
  projectPath: string;
  sessionName: string;
  conversationId: string;
}): CheckpointScopeKey {
  return isProjectSentinel(identity.sessionName)
    ? {
        scope: "project",
        projectPath: identity.projectPath,
        sessionName: null,
        conversationId: identity.conversationId,
      }
    : {
        scope: "session",
        projectPath: identity.projectPath,
        sessionName: identity.sessionName,
        conversationId: identity.conversationId,
      };
}
