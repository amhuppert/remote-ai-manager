/**
 * Query keys for context-artifact caches. Artifacts exist on two conversation
 * scopes (design docs/design/conversation-compaction/README.md §12.3), so keys
 * are derived from the canonical scope-discriminated `ConversationTarget` rather
 * than positional args — queries, mutations, and the SSE cache reconciler all
 * share one identity shape.
 */
import {
  conversationTargetKey,
  type ConversationTarget,
} from "@/lib/conversations/conversation-target";

/**
 * Artifact addressing IS conversation addressing; the alias keeps the domain's
 * local name while the contract has one owner.
 */
export type ContextArtifactTarget = ConversationTarget;

export const contextArtifactKeys = {
  all: ["context-artifacts"] as const,
  conversation: (target: ContextArtifactTarget) =>
    [...contextArtifactKeys.all, ...conversationTargetKey(target)] as const,
  list: (target: ContextArtifactTarget) =>
    [...contextArtifactKeys.conversation(target), "list"] as const,
  detail: (target: ContextArtifactTarget, artifactId: string) =>
    [
      ...contextArtifactKeys.conversation(target),
      "detail",
      artifactId,
    ] as const,
};
