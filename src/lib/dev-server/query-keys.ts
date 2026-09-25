export const devServerKeys = {
  all: ["dev-servers"] as const,
  lists: () => [...devServerKeys.all, "list"] as const,
  list: (projectName: string, sessionName: string) =>
    [...devServerKeys.lists(), projectName, sessionName] as const,
  /** Servers that run in the project root, without a session. */
  project: (projectName: string) =>
    [...devServerKeys.all, "project", projectName] as const,
  overview: () => [...devServerKeys.all, "overview"] as const,
  stopInstance: () => [...devServerKeys.all, "stop-instance"] as const,
};
