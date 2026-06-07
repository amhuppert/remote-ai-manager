export const agentCapabilityKeys = {
  all: ["agent-capabilities"] as const,
  global: (cascadeKind: string) =>
    [...agentCapabilityKeys.all, "global", cascadeKind] as const,
  project: (projectName: string, cascadeKind: string) =>
    [...agentCapabilityKeys.all, "project", projectName, cascadeKind] as const,
  session: (projectName: string, sessionName: string, cascadeKind: string) =>
    [
      ...agentCapabilityKeys.all,
      "session",
      projectName,
      cascadeKind,
      sessionName,
    ] as const,
  conversation: (
    projectName: string,
    sessionName: string,
    conversationId: string,
    cascadeKind: string,
  ) =>
    [
      ...agentCapabilityKeys.all,
      "conversation",
      projectName,
      cascadeKind,
      sessionName,
      conversationId,
    ] as const,
  projectConversation: (
    projectName: string,
    conversationId: string,
    cascadeKind: string,
  ) =>
    [
      ...agentCapabilityKeys.all,
      "conversation",
      projectName,
      cascadeKind,
      "project",
      conversationId,
    ] as const,
};
