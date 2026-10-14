export const collaborationKeys = {
  all: ["collaboration"] as const,
  lists: () => [...collaborationKeys.all, "list"] as const,
  listsAll: () => [...collaborationKeys.all, "listAll"] as const,
  details: () => [...collaborationKeys.all, "detail"] as const,
  artifacts: () => [...collaborationKeys.all, "artifact"] as const,
  list: (projectName: string, sessionName: string) =>
    [...collaborationKeys.lists(), projectName, sessionName] as const,
  listAll: (projectName: string, sessionName: string) =>
    [...collaborationKeys.listsAll(), projectName, sessionName] as const,
  detail: (projectName: string, sessionName: string, workflowId: string) =>
    [
      ...collaborationKeys.details(),
      projectName,
      sessionName,
      workflowId,
    ] as const,
  artifact: (
    projectName: string,
    sessionName: string,
    workflowId: string,
    artifactType: string,
  ) =>
    [
      ...collaborationKeys.artifacts(),
      projectName,
      sessionName,
      workflowId,
      artifactType,
    ] as const,
};
