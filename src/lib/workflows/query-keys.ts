export const workflowDefinitionKeys = {
  all: ["workflow-definitions"] as const,
  lists: () => [...workflowDefinitionKeys.all, "list"] as const,
  details: () => [...workflowDefinitionKeys.all, "detail"] as const,
  list: (projectName: string) =>
    [...workflowDefinitionKeys.lists(), projectName] as const,
  detail: (projectName: string, workflowId: string) =>
    [...workflowDefinitionKeys.details(), projectName, workflowId] as const,
};

export const projectTemplatesKeys = {
  all: ["project-templates"] as const,
  list: (projectName: string) =>
    [...projectTemplatesKeys.all, projectName] as const,
};

export const globalWorkflowTemplateKeys = {
  all: ["global-workflow-templates"] as const,
  lists: () => [...globalWorkflowTemplateKeys.all, "list"] as const,
  details: () => [...globalWorkflowTemplateKeys.all, "detail"] as const,
  list: () => globalWorkflowTemplateKeys.lists(),
  detail: (workflowId: string) =>
    [...globalWorkflowTemplateKeys.details(), workflowId] as const,
};

export const graphWorkflowEventsKeys = {
  all: ["graph-workflow-events"] as const,
  list: (projectName: string, sessionName: string, executionId: string) =>
    [
      ...graphWorkflowEventsKeys.all,
      projectName,
      sessionName,
      executionId,
    ] as const,
  /**
   * The cursor-paginated history read (D4 decision D9). Kept distinct from
   * `list` because it caches PAGES, not a bounded tail — an SSE invalidation of
   * the tail must not throw away a walked history.
   */
  pages: (projectName: string, sessionName: string, executionId: string) =>
    [
      ...graphWorkflowEventsKeys.all,
      "pages",
      projectName,
      sessionName,
      executionId,
    ] as const,
};

export const graphWorkflowExecutionKeys = {
  all: ["graph-workflow-execution"] as const,
  detail: (projectName: string, sessionName: string) =>
    [...graphWorkflowExecutionKeys.all, projectName, sessionName] as const,
};

/**
 * The frozen scoped change set one parked context's approval panel renders.
 *
 * Keyed by context because a session can park several at once, and by the
 * gate's `requestedAt` because the SAME context parks repeatedly: rejection,
 * remediation, and a second gate over a different frozen candidate. Without the
 * gate in the key the second gate reads the first one's cached payload — inside
 * the freshness window it may not refetch at all, and past it the stale bytes
 * still render during the background refetch. Either way the human would be
 * deciding on a candidate that is not the one now frozen.
 */
export const graphWorkflowApprovalSnapshotKeys = {
  all: ["graph-workflow-approval-snapshot"] as const,
  detail: (
    projectName: string,
    sessionName: string,
    contextId: string,
    requestedAt: string,
  ) =>
    [
      ...graphWorkflowApprovalSnapshotKeys.all,
      projectName,
      sessionName,
      contextId,
      requestedAt,
    ] as const,
};

export const graphWorkflowHistoryKeys = {
  all: ["graph-workflow-history"] as const,
  list: (projectName: string, sessionName: string) =>
    [...graphWorkflowHistoryKeys.all, projectName, sessionName] as const,
};

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
