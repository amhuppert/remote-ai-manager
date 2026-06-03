/** React Query key factory for the chat-spawning domain. */
export const chatSpawningKeys = {
  all: ["chat-spawning"] as const,
  spawn: (projectName: string, conversationId: string) =>
    [...chatSpawningKeys.all, "spawn", projectName, conversationId] as const,
};
