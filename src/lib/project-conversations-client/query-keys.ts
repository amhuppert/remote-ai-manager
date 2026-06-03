/**
 * React Query key factory for the project-conversation cockpit's consumer
 * query layer. These keys address the project-level-conversations foundation's
 * project routes (list / messages) and the derived open-conversation count.
 *
 * The factory is exported so the notifications extension (which owns the global
 * SSE → invalidation listener) can invalidate `list`/`openCount`/`messages` on
 * `scope: "project"` conversation events without this spec forking that listener.
 */
export const projectConversationKeys = {
  all: ["project-conversations"] as const,
  list: (projectName: string) =>
    [...projectConversationKeys.all, "list", projectName] as const,
  openCount: (projectName: string) =>
    [...projectConversationKeys.all, "open-count", projectName] as const,
  messages: (projectName: string, conversationId: string) =>
    [
      ...projectConversationKeys.all,
      "messages",
      projectName,
      conversationId,
    ] as const,
};
