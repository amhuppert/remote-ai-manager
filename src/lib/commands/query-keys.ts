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
