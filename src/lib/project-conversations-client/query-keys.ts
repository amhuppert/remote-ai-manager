/**
 * React Query key factory for the project-conversation cockpit's consumer
 * query layer. These keys address the project-level-conversations foundation's
 * project routes (list / messages); the open-conversation count is derived
 * from the `list` query cache.
 *
 * The factory is exported so the global SSE → invalidation listener
 * (NotificationListener) invalidates `list` and patches `messages` on
 * `scope: "project"` conversation events without forking key definitions.
 */
export const projectConversationKeys = {
  all: ["project-conversations"] as const,
  list: (projectName: string) =>
    [...projectConversationKeys.all, "list", projectName] as const,
  messages: (projectName: string, conversationId: string) =>
    [
      ...projectConversationKeys.all,
      "messages",
      projectName,
      conversationId,
    ] as const,
};
