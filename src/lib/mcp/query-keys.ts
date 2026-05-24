export const mcpConfigKeys = {
  all: ["mcp-config"] as const,
  global: () => [...mcpConfigKeys.all, "global"] as const,
  projects: () => [...mcpConfigKeys.all, "project"] as const,
  sessions: () => [...mcpConfigKeys.all, "session"] as const,
  conversations: () => [...mcpConfigKeys.all, "conversation"] as const,
  project: (projectName: string) =>
    [...mcpConfigKeys.projects(), projectName] as const,
  sessionsInProject: (projectName: string) =>
    [...mcpConfigKeys.sessions(), projectName] as const,
  session: (projectName: string, sessionName: string) =>
    [...mcpConfigKeys.sessions(), projectName, sessionName] as const,
  conversationsInProject: (projectName: string) =>
    [...mcpConfigKeys.conversations(), projectName] as const,
  conversationsInSession: (projectName: string, sessionName: string) =>
    [...mcpConfigKeys.conversations(), projectName, sessionName] as const,
  conversation: (
    projectName: string,
    sessionName: string,
    conversationId: string,
  ) =>
    [
      ...mcpConfigKeys.conversations(),
      projectName,
      sessionName,
      conversationId,
    ] as const,
};

export const mcpToolsKeys = {
  all: ["mcp-tools"] as const,
  inventories: () => [...mcpToolsKeys.all, "inventory"] as const,
  inventory: (
    projectName: string,
    sessionName: string,
    conversationId: string,
    serverKey: string,
  ) =>
    [
      ...mcpToolsKeys.inventories(),
      projectName,
      sessionName,
      conversationId,
      serverKey,
    ] as const,
};
