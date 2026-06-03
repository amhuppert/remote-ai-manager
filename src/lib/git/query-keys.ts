export const gitKeys = {
  all: ["git"] as const,
  diff: (projectName: string, sessionName: string) =>
    [...gitKeys.all, "diff", projectName, sessionName] as const,
  mainDiff: (projectName: string) =>
    [...gitKeys.all, "main-diff", projectName] as const,
  commits: (projectName: string, sessionName: string) =>
    [...gitKeys.all, "commits", projectName, sessionName] as const,
  commitDiff: (projectName: string, sessionName: string, hash: string) =>
    [...gitKeys.all, "commitDiff", projectName, sessionName, hash] as const,
};

export const conflictKeys = {
  all: ["conflicts"] as const,
  detail: (projectName: string, sessionName: string) =>
    [...conflictKeys.all, projectName, sessionName] as const,
};
