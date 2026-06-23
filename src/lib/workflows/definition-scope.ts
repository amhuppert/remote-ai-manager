import {
  workflowDefinitionKeys,
  globalWorkflowTemplateKeys,
} from "./query-keys";

/**
 * Which storage tier a workflow-definition CRUD surface operates on. A
 * `project` scope keys the per-project workflows endpoint; the `global` scope
 * targets the cross-project template tier. The builder is parameterized by this
 * so one component drives both the per-project and the global template library.
 */
export type WorkflowDefinitionScope =
  | { kind: "project"; projectName: string }
  | { kind: "global" };

export interface WorkflowDefinitionScopeApi {
  /** Collection endpoint: list (GET) and create (POST). */
  collectionUrl: string;
  /** Per-item endpoint: get (GET), update (PUT), delete (DELETE). */
  itemUrl(workflowId: string): string;
  /** React Query key for the list query. */
  listKey: readonly unknown[];
  /** React Query key for a single definition's detail query. */
  detailKey(workflowId: string): readonly unknown[];
}

/**
 * Resolve a scope to its REST endpoints and React Query keys. The project scope
 * deliberately reuses `workflowDefinitionKeys` so a builder mutation invalidates
 * the same cache entries the session graph-workflow surfaces read.
 */
export function workflowDefinitionScopeApi(
  scope: WorkflowDefinitionScope,
): WorkflowDefinitionScopeApi {
  if (scope.kind === "global") {
    return {
      collectionUrl: "/api/workflow-templates",
      itemUrl: (workflowId) =>
        `/api/workflow-templates/${encodeURIComponent(workflowId)}`,
      listKey: globalWorkflowTemplateKeys.list(),
      detailKey: (workflowId) => globalWorkflowTemplateKeys.detail(workflowId),
    };
  }

  const collectionUrl = `/api/projects/${encodeURIComponent(scope.projectName)}/workflows`;
  return {
    collectionUrl,
    itemUrl: (workflowId) =>
      `${collectionUrl}/${encodeURIComponent(workflowId)}`,
    listKey: workflowDefinitionKeys.list(scope.projectName),
    detailKey: (workflowId) =>
      workflowDefinitionKeys.detail(scope.projectName, workflowId),
  };
}
