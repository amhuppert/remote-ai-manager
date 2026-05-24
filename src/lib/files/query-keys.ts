export const fileKeys = {
  all: ["files"] as const,
  lists: () => [...fileKeys.all, "list"] as const,
  list: (projectName: string) => [...fileKeys.lists(), projectName] as const,
  sessionList: (projectName: string, sessionName: string) =>
    [...fileKeys.lists(), projectName, sessionName] as const,
};
