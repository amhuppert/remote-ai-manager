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

export const commandKeys = {
  all: ["commands"] as const,
  list: (projectName: string, sessionName: string) =>
    [...commandKeys.all, "list", projectName, sessionName] as const,
};
