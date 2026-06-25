export const sessionKeys = {
  all: ["sessions"] as const,
  lists: () => [...sessionKeys.all, "list"] as const,
  details: () => [...sessionKeys.all, "detail"] as const,
  list: (projectName: string) => [...sessionKeys.lists(), projectName] as const,
  detail: (projectName: string, sessionName: string) =>
    [...sessionKeys.details(), projectName, sessionName] as const,
  branchPrefix: (projectName: string) =>
    [...sessionKeys.all, "branch-prefix", projectName] as const,
};
