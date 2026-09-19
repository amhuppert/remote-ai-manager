import type { AgentBackendId } from "@/lib/shared/schemas";

export const commandKeys = {
  all: ["commands"] as const,
  lists: () => [...commandKeys.all, "list"] as const,
  projectLists: () => [...commandKeys.all, "project-list"] as const,
  list: (
    projectName: string,
    sessionName: string | undefined,
    backend: AgentBackendId = "claude",
    conversationId?: string,
  ) =>
    [
      ...commandKeys.lists(),
      projectName,
      sessionName,
      backend,
      conversationId,
    ] as const,
  projectList: (
    projectName: string,
    backend: AgentBackendId = "claude",
    conversationId?: string,
  ) =>
    [
      ...commandKeys.projectLists(),
      projectName,
      backend,
      conversationId,
    ] as const,
};
