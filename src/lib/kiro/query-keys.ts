export const kiroDocKeys = {
  all: ["kiro-docs"] as const,
  trees: () => [...kiroDocKeys.all, "tree"] as const,
  files: () => [...kiroDocKeys.all, "file"] as const,
  tree: (projectName: string, sessionName?: string) =>
    [...kiroDocKeys.trees(), projectName, sessionName ?? ""] as const,
  file: (projectName: string, filePath: string, sessionName?: string) =>
    [...kiroDocKeys.files(), projectName, sessionName ?? "", filePath] as const,
};
