export const projectKeys = {
  all: ["projects"] as const,
  list: () => [...projectKeys.all, "list"] as const,
  preferences: () => [...projectKeys.all, "preferences"] as const,
};

export const configKeys = {
  all: ["config"] as const,
  full: () => [...configKeys.all, "full"] as const,
};

export const sessionKeys = {
  all: ["sessions"] as const,
  lists: () => [...sessionKeys.all, "list"] as const,
  details: () => [...sessionKeys.all, "detail"] as const,
  list: (projectName: string) => [...sessionKeys.lists(), projectName] as const,
  detail: (projectName: string, sessionName: string) =>
    [...sessionKeys.details(), projectName, sessionName] as const,
  diff: (projectName: string, sessionName: string) =>
    [...sessionKeys.all, "diff", projectName, sessionName] as const,
  commits: (projectName: string, sessionName: string) =>
    [...sessionKeys.all, "commits", projectName, sessionName] as const,
  commitDiff: (projectName: string, sessionName: string, hash: string) =>
    [...sessionKeys.all, "commitDiff", projectName, sessionName, hash] as const,
};

export const referenceDocumentKeys = {
  all: ["reference-documents"] as const,
  lists: () => [...referenceDocumentKeys.all, "list"] as const,
  contents: () => [...referenceDocumentKeys.all, "content"] as const,
  list: (projectName: string, sessionName: string) =>
    [...referenceDocumentKeys.lists(), projectName, sessionName] as const,
  content: (projectName: string, sessionName: string, documentId: string) =>
    [
      ...referenceDocumentKeys.contents(),
      projectName,
      sessionName,
      documentId,
    ] as const,
};

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

export const workflowDefinitionKeys = {
  all: ["workflow-definitions"] as const,
  lists: () => [...workflowDefinitionKeys.all, "list"] as const,
  details: () => [...workflowDefinitionKeys.all, "detail"] as const,
  list: (projectName: string) =>
    [...workflowDefinitionKeys.lists(), projectName] as const,
  detail: (projectName: string, workflowId: string) =>
    [...workflowDefinitionKeys.details(), projectName, workflowId] as const,
};

export const fileKeys = {
  all: ["files"] as const,
  lists: () => [...fileKeys.all, "list"] as const,
  list: (projectName: string) => [...fileKeys.lists(), projectName] as const,
  sessionList: (projectName: string, sessionName: string) =>
    [...fileKeys.lists(), projectName, sessionName] as const,
};

export const commandKeys = {
  all: ["commands"] as const,
  lists: () => [...commandKeys.all, "list"] as const,
  projectLists: () => [...commandKeys.all, "project-list"] as const,
  list: (
    projectName: string,
    sessionName: string,
    backend: "claude" | "codex" = "claude",
  ) => [...commandKeys.lists(), projectName, sessionName, backend] as const,
  projectList: (projectName: string) =>
    [...commandKeys.projectLists(), projectName] as const,
};

export const notificationKeys = {
  all: ["notifications"] as const,
  list: () => [...notificationKeys.all, "list"] as const,
};

export const devServerKeys = {
  all: ["dev-servers"] as const,
  lists: () => [...devServerKeys.all, "list"] as const,
  list: (projectName: string, sessionName: string) =>
    [...devServerKeys.lists(), projectName, sessionName] as const,
};

export const presetKeys = {
  all: ["presets"] as const,
  lists: () => [...presetKeys.all, "list"] as const,
  list: (projectName: string) => [...presetKeys.lists(), projectName] as const,
};

export const debugLogKeys = {
  all: ["debug-logs"] as const,
  statsAll: () => [...debugLogKeys.all, "stats"] as const,
  stats: (projectName: string, sessionName: string, conversationId: string) =>
    [
      ...debugLogKeys.statsAll(),
      projectName,
      sessionName,
      conversationId,
    ] as const,
};

export const imageIndexKeys = {
  all: ["image-index"] as const,
  counts: () => [...imageIndexKeys.all, "count"] as const,
  count: (projectName: string, sessionName: string, conversationId: string) =>
    [
      ...imageIndexKeys.counts(),
      projectName,
      sessionName,
      conversationId,
    ] as const,
};

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
  lists: () => [...collaborationKeys.all, "list"] as const,
  listsAll: () => [...collaborationKeys.all, "listAll"] as const,
  details: () => [...collaborationKeys.all, "detail"] as const,
  artifacts: () => [...collaborationKeys.all, "artifact"] as const,
  list: (projectName: string, sessionName: string) =>
    [...collaborationKeys.lists(), projectName, sessionName] as const,
  listAll: (projectName: string, sessionName: string) =>
    [...collaborationKeys.listsAll(), projectName, sessionName] as const,
  detail: (projectName: string, sessionName: string, workflowId: string) =>
    [
      ...collaborationKeys.details(),
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
      ...collaborationKeys.artifacts(),
      projectName,
      sessionName,
      workflowId,
      artifactType,
    ] as const,
};

export const kiroDocKeys = {
  all: ["kiro-docs"] as const,
  trees: () => [...kiroDocKeys.all, "tree"] as const,
  files: () => [...kiroDocKeys.all, "file"] as const,
  tree: (projectName: string, sessionName?: string) =>
    [...kiroDocKeys.trees(), projectName, sessionName ?? ""] as const,
  file: (projectName: string, filePath: string, sessionName?: string) =>
    [...kiroDocKeys.files(), projectName, sessionName ?? "", filePath] as const,
};
