/**
 * Fork-from-a-pane: run the fork mutation, then open the new conversation in
 * the working set (the pane analog of the main panel's navigate-to-fork).
 * Failures surface through the conversation's keyed in-flight error banner.
 */
export function createPaneForkHandler(deps: {
  conversationId: string;
  forkConversation(input: {
    conversationId: string;
    messageIndex: number;
  }): Promise<{ conversationId: string }>;
  openInWorkingSet(conversationId: string): void;
  failPrompt(conversationId: string, error: string): void;
}): (messageIndex: number) => Promise<void> {
  return async (messageIndex: number) => {
    try {
      const result = await deps.forkConversation({
        conversationId: deps.conversationId,
        messageIndex,
      });
      deps.openInWorkingSet(result.conversationId);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Fork failed";
      deps.failPrompt(deps.conversationId, message);
    }
  };
}
