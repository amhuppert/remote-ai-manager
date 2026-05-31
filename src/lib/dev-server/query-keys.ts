export const devServerKeys = {
  all: ["dev-servers"] as const,
  lists: () => [...devServerKeys.all, "list"] as const,
  list: (projectName: string, sessionName: string) =>
    [...devServerKeys.lists(), projectName, sessionName] as const,
};
