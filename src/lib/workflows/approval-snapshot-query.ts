import { useQuery } from "@tanstack/react-query";

import { apiFetch } from "@/lib/api/fetcher";
import { graphWorkflowApprovalSnapshotResponseSchema } from "@/lib/workflow-graph/approval-snapshot-schemas";
import { graphWorkflowApprovalSnapshotKeys } from "@/lib/workflows/query-keys";

/**
 * The frozen, ownership-scoped change set the approval panel renders for an
 * enveloped context (R15.2).
 *
 * Deliberately NOT the session diff query: in a shared lane worktree the
 * whole-worktree delta is partly a concurrent sibling's in-progress work, and it
 * moves under the reviewer while they read it. This endpoint answers with the
 * candidate the gate froze, or says it cannot.
 */
export function useGraphWorkflowApprovalSnapshotQuery(
  projectName: string,
  sessionName: string,
  contextId: string | null,
  requestedAt: string | null,
) {
  const enabled = contextId !== null && requestedAt !== null;
  return useQuery({
    queryKey: graphWorkflowApprovalSnapshotKeys.detail(
      projectName,
      sessionName,
      contextId ?? "",
      requestedAt ?? "",
    ),
    enabled,
    // `requestedAt` also travels in the request: it names the gate being
    // rendered, so a client on stale execution state is refused rather than
    // handed a later gate's bytes under the earlier gate's identity.
    queryFn: () =>
      apiFetch(
        `/api/projects/${encodeURIComponent(projectName)}/sessions/${encodeURIComponent(sessionName)}/graph-workflow/approval-snapshot?contextId=${encodeURIComponent(contextId ?? "")}&requestedAt=${encodeURIComponent(requestedAt ?? "")}`,
        graphWorkflowApprovalSnapshotResponseSchema,
      ),
  });
}
