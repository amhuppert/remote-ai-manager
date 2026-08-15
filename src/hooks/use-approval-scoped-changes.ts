"use client";

import type { ApprovalScopedChanges } from "@/components/ApprovalGatePanel";
import { getErrorMessage } from "@/lib/shared/errors";
import { useGraphWorkflowApprovalSnapshotQuery } from "@/lib/workflows/queries";
import type { GraphWorkflowApprovalSnapshotResponse } from "@/lib/workflow-graph/schemas";

/**
 * Map the approval API's answer onto what the panel renders. A response that is
 * not a scoped snapshot never degrades into a whole-tree view: `whole_tree`
 * cannot reach here (it is only returned for a full-access member, which never
 * asks), and every other kind renders as its own explicit state.
 */
function toScopedChanges(
  response: GraphWorkflowApprovalSnapshotResponse,
): ApprovalScopedChanges {
  switch (response.kind) {
    case "scoped":
      return {
        status: "ready",
        ownedPaths: response.snapshot.ownedPaths,
        diff: response.snapshot.diff,
      };
    case "drifted":
      return { status: "drifted" };
    case "unavailable":
      return { status: "unavailable", reason: response.reason };
    case "whole_tree":
      return {
        status: "unavailable",
        reason: "this context is no longer under a file-ownership envelope",
      };
  }
}

/**
 * What one parked gate is decided on, for whichever approval surface renders
 * it. Every surface that offers Approve has to offer the same frozen artifact
 * behind it (R15.2).
 *
 * Null for a full-access member, which keeps the whole-tree approval view.
 */
export function useApprovalScopedChanges(
  projectName: string,
  sessionName: string,
  standing: {
    contextId: string;
    requestedAt: string;
    enveloped: boolean;
  } | null,
): ApprovalScopedChanges | null {
  const scoped = standing?.enveloped === true ? standing : null;
  const snapshotQuery = useGraphWorkflowApprovalSnapshotQuery(
    projectName,
    sessionName,
    scoped?.contextId ?? null,
    scoped?.requestedAt ?? null,
  );

  if (scoped === null) return null;
  if (snapshotQuery.data !== undefined) {
    return toScopedChanges(snapshotQuery.data);
  }
  if (snapshotQuery.error) {
    return {
      status: "unavailable",
      reason: getErrorMessage(snapshotQuery.error),
    };
  }
  return { status: "loading" };
}
