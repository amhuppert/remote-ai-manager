export const projectKeys = {
  all: ["projects"] as const,
  list: () => [...projectKeys.all, "list"] as const,
  preferences: () => [...projectKeys.all, "preferences"] as const,
};

export const configKeys = {
  all: ["config"] as const,
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
  focusDoc: (projectName: string, sessionName: string) =>
    [...sessionKeys.all, "focusDoc", projectName, sessionName] as const,
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

export const workflowKeys = {
  all: ["workflow"] as const,
  status: (projectName: string, sessionName: string) =>
    [...workflowKeys.all, "status", projectName, sessionName] as const,
  iterations: (projectName: string, sessionName: string) =>
    [...workflowKeys.all, "iterations", projectName, sessionName] as const,
};

export const fileKeys = {
  all: ["files"] as const,
  list: (projectName: string) =>
    [...fileKeys.all, "list", projectName] as const,
};

export const commandKeys = {
  all: ["commands"] as const,
  list: (projectName: string, sessionName: string) =>
    [...commandKeys.all, "list", projectName, sessionName] as const,
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

export const roadmapItemKeys = {
  all: ["roadmap-items"] as const,
  list: (projectName: string) =>
    [...roadmapItemKeys.all, "list", projectName] as const,
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
