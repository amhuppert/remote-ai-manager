export const projectKeys = {
  all: ["projects"] as const,
  list: () => [...projectKeys.all, "list"] as const,
  preferences: () => [...projectKeys.all, "preferences"] as const,
};

export const configKeys = {
  all: ["config"] as const,
  full: ["config", "full"] as const,
};

export const sessionKeys = {
  all: ["sessions"] as const,
  list: (projectName: string) =>
    [...sessionKeys.all, "list", projectName] as const,
  detail: (projectName: string, sessionName: string) =>
    [...sessionKeys.all, "detail", projectName, sessionName] as const,
  diff: (projectName: string, sessionName: string) =>
    [...sessionKeys.all, "diff", projectName, sessionName] as const,
  commits: (projectName: string, sessionName: string) =>
    [...sessionKeys.all, "commits", projectName, sessionName] as const,
  commitDiff: (projectName: string, sessionName: string, hash: string) =>
    [...sessionKeys.all, "commitDiff", projectName, sessionName, hash] as const,
};

export const referenceDocumentKeys = {
  all: ["reference-documents"] as const,
  list: (projectName: string, sessionName: string) =>
    [...referenceDocumentKeys.all, "list", projectName, sessionName] as const,
  content: (projectName: string, sessionName: string, documentId: string) =>
    [
      ...referenceDocumentKeys.all,
      "content",
      projectName,
      sessionName,
      documentId,
    ] as const,
};

export const conversationKeys = {
  all: ["conversations"] as const,
  active: ["conversations", "active"] as const,
  list: (projectName: string, sessionName: string) =>
    [...conversationKeys.all, "list", projectName, sessionName] as const,
  messages: (
    projectName: string,
    sessionName: string,
    conversationId: string,
  ) =>
    [
      ...conversationKeys.all,
      "messages",
      projectName,
      sessionName,
      conversationId,
    ] as const,
};

export const workflowDefinitionKeys = {
  all: ["workflow-definitions"] as const,
  list: (projectName: string) =>
    [...workflowDefinitionKeys.all, "list", projectName] as const,
  detail: (projectName: string, workflowId: string) =>
    [...workflowDefinitionKeys.all, "detail", projectName, workflowId] as const,
};

export const fileKeys = {
  all: ["files"] as const,
  list: (projectName: string) =>
    [...fileKeys.all, "list", projectName] as const,
  sessionList: (projectName: string, sessionName: string) =>
    [...fileKeys.all, "list", projectName, sessionName] as const,
};

export const commandKeys = {
  all: ["commands"] as const,
  list: (
    projectName: string,
    sessionName: string,
    backend: "claude" | "codex" = "claude",
  ) => [...commandKeys.all, "list", projectName, sessionName, backend] as const,
  projectList: (projectName: string) =>
    [...commandKeys.all, "project-list", projectName] as const,
};

export const notificationKeys = {
  all: ["notifications"] as const,
  list: () => [...notificationKeys.all, "list"] as const,
};

export const devServerKeys = {
  all: ["dev-servers"] as const,
  list: (projectName: string, sessionName: string) =>
    [...devServerKeys.all, "list", projectName, sessionName] as const,
};

export const presetKeys = {
  all: ["presets"] as const,
  list: (projectName: string) =>
    [...presetKeys.all, "list", projectName] as const,
};

export const debugLogKeys = {
  all: ["debug-logs"] as const,
  stats: (projectName: string, sessionName: string, conversationId: string) =>
    [
      ...debugLogKeys.all,
      "stats",
      projectName,
      sessionName,
      conversationId,
    ] as const,
};

export const imageIndexKeys = {
  all: ["image-index"] as const,
  count: (projectName: string, sessionName: string, conversationId: string) =>
    [
      ...imageIndexKeys.all,
      "count",
      projectName,
      sessionName,
      conversationId,
    ] as const,
};

export const mcpConfigKeys = {
  all: ["mcp-config"] as const,
  global: () => [...mcpConfigKeys.all, "global"] as const,
  project: (projectName: string) =>
    [...mcpConfigKeys.all, "project", projectName] as const,
  session: (projectName: string, sessionName: string) =>
    [...mcpConfigKeys.all, "session", projectName, sessionName] as const,
  conversation: (
    projectName: string,
    sessionName: string,
    conversationId: string,
  ) =>
    [
      ...mcpConfigKeys.all,
      "conversation",
      projectName,
      sessionName,
      conversationId,
    ] as const,
};

export const mcpToolsKeys = {
  all: ["mcp-tools"] as const,
  inventory: (
    projectName: string,
    sessionName: string,
    conversationId: string,
    serverKey: string,
  ) =>
    [
      ...mcpToolsKeys.all,
      projectName,
      sessionName,
      conversationId,
      serverKey,
    ] as const,
};

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
};

export const collaborationKeys = {
  all: ["collaboration"] as const,
  list: (projectName: string, sessionName: string) =>
    [...collaborationKeys.all, "list", projectName, sessionName] as const,
  listAll: (projectName: string, sessionName: string) =>
    [...collaborationKeys.all, "listAll", projectName, sessionName] as const,
  detail: (projectName: string, sessionName: string, workflowId: string) =>
    [
      ...collaborationKeys.all,
      "detail",
      projectName,
      sessionName,
      workflowId,
    ] as const,
  artifact: (
    projectName: string,
    sessionName: string,
    workflowId: string,
    artifactType: string,
  ) =>
    [
      ...collaborationKeys.all,
      "artifact",
      projectName,
      sessionName,
      workflowId,
      artifactType,
    ] as const,
};

export const kiroDocKeys = {
  all: ["kiro-docs"] as const,
  tree: (projectName: string, sessionName?: string) =>
    [...kiroDocKeys.all, "tree", projectName, sessionName ?? ""] as const,
  file: (projectName: string, filePath: string, sessionName?: string) =>
    [
      ...kiroDocKeys.all,
      "file",
      projectName,
      sessionName ?? "",
      filePath,
    ] as const,
};
