export const conversationKeys = {
  all: ["conversations"] as const,
  active: () => [...conversationKeys.all, "active"] as const,
  lists: () => [...conversationKeys.all, "list"] as const,
  details: () => [...conversationKeys.all, "detail"] as const,
  messagesAll: () => [...conversationKeys.all, "messages"] as const,
  list: (projectName: string, sessionName: string) =>
    [...conversationKeys.lists(), projectName, sessionName] as const,
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
