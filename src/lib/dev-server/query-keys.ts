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
