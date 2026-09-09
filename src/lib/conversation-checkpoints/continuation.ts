/**
 * The checkpoint repository's whole view of a conversation row.
 *
 * Retirement is only real once the conversation's stored provider reference is
 * gone: an operation that says `ready` while the row still names a live backend
 * session describes a retirement that never happened, and the next ordinary
 * turn would resume the runtime the checkpoint exists to replace. So the clear
 * and the phase change have to be one durable fact, which means one SQLite
 * transaction — and that is why this interface is synchronous. An async writer
 * could not participate in the repository's open transaction, and a second
 * transaction afterwards is exactly the window this design removes.
 *
 * Both rows belong to the conversation repositories; this narrow interface lets
 * the checkpoint repository ask about a target and share their commit without
 * learning which of the two conversation tables that target lives in.
 */

import type { ConversationState } from "@/lib/conversations/schemas";
import type { AllRepos } from "@/lib/state-store/schemas";

import type { CheckpointScopeKey } from "./schemas";

export interface CheckpointConversationGateway {
  /**
   * Whether the addressed conversation exists. Admission asks before it
   * persists: an operation for a conversation that is not there could never be
   * cleaned by the deletion triggers, because no row remains whose delete could
   * fire them, so it would hold that conversation's checkpoint slot forever.
   */
  exists(key: CheckpointScopeKey): boolean;
  /**
   * The addressed conversation row as it stands inside the caller's open
   * transaction. The freeze fence re-evaluates eligibility from it, so a claim
   * or archival that committed after a build's asynchronous read cannot slip
   * past the commit that retires the runtime.
   */
  find(key: CheckpointScopeKey): ConversationState | null;
  /**
   * Clear the target conversation's stored provider reference. Returns whether
   * a row matched — `false` means the conversation this operation retires is
   * not there, which readiness must treat as a refusal rather than a success.
   */
  clearBackendRef(key: CheckpointScopeKey): boolean;
}

export function createCheckpointConversationGateway(
  repos: Pick<AllRepos, "conversations" | "projectConversations">,
): CheckpointConversationGateway {
  return {
    exists(key) {
      if (key.scope === "project") {
        return (
          repos.projectConversations.findByKey(
            key.projectPath,
            key.conversationId,
          ) !== null
        );
      }
      if (key.sessionName === null) return false;
      return (
        repos.conversations.findByKey(
          key.projectPath,
          key.sessionName,
          key.conversationId,
        ) !== null
      );
    },
    find(key) {
      if (key.scope === "project") {
        return repos.projectConversations.findByKey(
          key.projectPath,
          key.conversationId,
        );
      }
      if (key.sessionName === null) return null;
      return repos.conversations.findByKey(
        key.projectPath,
        key.sessionName,
        key.conversationId,
      );
    },
    clearBackendRef(key) {
      if (key.scope === "project") {
        return repos.projectConversations.clearBackendRef(
          key.projectPath,
          key.conversationId,
        );
      }
      // The schema's refinement pairs session scope with a session name, so a
      // null here is a key that never parsed. Matching no row is the honest
      // answer: there is no conversation this key can address.
      if (key.sessionName === null) return false;
      return repos.conversations.clearBackendRef(
        key.projectPath,
        key.sessionName,
        key.conversationId,
      );
    },
  };
}
