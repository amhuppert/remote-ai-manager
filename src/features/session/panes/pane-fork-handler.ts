import type { AgentProfileRef } from "@/lib/agent-profiles/schemas";

/**
 * Fork-from-a-pane: run the fork mutation, then open the new conversation in
 * the working set (the pane analog of the main panel's navigate-to-fork).
 * Failures surface through the conversation's keyed in-flight error banner.
 *
 * `profile` arrives only from an index-0 fork, which derives from no session
 * and is therefore a fresh conversation with an identity to choose (R7).
 */
export function createPaneForkHandler(deps: {
  conversationId: string;
  forkConversation(input: {
    conversationId: string;
    messageIndex: number;
    profile?: AgentProfileRef;
  }): Promise<{ conversationId: string }>;
  openInWorkingSet(conversationId: string): void;
  failPrompt(conversationId: string, error: string): void;
}): (messageIndex: number, profile?: AgentProfileRef) => Promise<void> {
  return async (messageIndex: number, profile?: AgentProfileRef) => {
    try {
      const result = await deps.forkConversation({
        conversationId: deps.conversationId,
        messageIndex,
        ...(profile === undefined ? {} : { profile }),
      });
      deps.openInWorkingSet(result.conversationId);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Fork failed";
      deps.failPrompt(deps.conversationId, message);
    }
  };
}
