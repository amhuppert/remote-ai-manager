export const imageIndexKeys = {
  all: ["image-index"] as const,
  counts: () => [...imageIndexKeys.all, "count"] as const,
  count: (projectName: string, sessionName: string, conversationId: string) =>
    [
      ...imageIndexKeys.counts(),
      projectName,
      sessionName,
      conversationId,
    ] as const,
};
