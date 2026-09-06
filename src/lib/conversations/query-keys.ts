export const conversationKeys = {
  all: ["conversations"] as const,
  active: () => [...conversationKeys.all, "active"] as const,
  sidebar: (includeArchived: boolean) =>
    [...conversationKeys.active(), "sidebar", { includeArchived }] as const,
  lists: () => [...conversationKeys.all, "list"] as const,
  details: () => [...conversationKeys.all, "detail"] as const,
  messagesAll: () => [...conversationKeys.all, "messages"] as const,
  list: (projectName: string, sessionName: string) =>
    [...conversationKeys.lists(), projectName, sessionName] as const,
  allConversations: (params: { includeArchived: boolean }) =>
    [...conversationKeys.all, "all", params] as const,
  lookup: (conversationId: string) =>
    [...conversationKeys.all, "lookup", conversationId] as const,
  messages: (
    projectName: string,
    sessionName: string,
    conversationId: string,
  ) =>
    [
      ...conversationKeys.messagesAll(),
      projectName,
      sessionName,
      conversationId,
    ] as const,
};
