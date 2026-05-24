export const debugLogKeys = {
  all: ["debug-logs"] as const,
  statsAll: () => [...debugLogKeys.all, "stats"] as const,
  stats: (projectName: string, sessionName: string, conversationId: string) =>
    [
      ...debugLogKeys.statsAll(),
      projectName,
      sessionName,
      conversationId,
    ] as const,
};
