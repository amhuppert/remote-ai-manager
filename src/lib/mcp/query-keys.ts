import {
  type ConversationTarget,
  conversationTargetKey,
} from "@/lib/conversations/conversation-target";
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
    [
      ...mcpConfigKeys.conversations(),
      projectName,
      "session",
      sessionName,
    ] as const,
  conversation: (target: ConversationTarget) =>
    [
      ...mcpConfigKeys.conversationsInProject(target.projectName),
      target.scope,
      ...(target.scope === "session" ? [target.sessionName] : []),
      target.conversationId,
    ] as const,
};

export const mcpToolsKeys = {
  all: ["mcp-tools"] as const,
  inventories: () => [...mcpToolsKeys.all, "inventory"] as const,
  inventory: (target: ConversationTarget, serverKey: string) =>
    [
      ...mcpToolsKeys.inventories(),
      ...conversationTargetKey(target),
      serverKey,
    ] as const,
};
