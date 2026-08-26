"use client";

import type { ApprovalScopedChanges } from "@/components/ApprovalGatePanel";
import { getErrorMessage } from "@/lib/shared/errors";
import type { GraphWorkflowApprovalSnapshotResponse } from "@/lib/workflow-graph/approval-snapshot-schemas";
import { useGraphWorkflowApprovalSnapshotQuery } from "@/lib/workflows/approval-snapshot-query";

/**
 * Map the approval API's answer onto what the panel renders. Every kind is an
 * explicit state, including `whole_tree`: that answer says the gate was frozen
 * WITHOUT an ownership envelope, which is a fact about the candidate rather
 * than an absence, and it never degrades into a whole-worktree diff — in a
 * shared lane that delta is partly a concurrent sibling's in-progress work.
 */
function toScopedChanges(
  response: GraphWorkflowApprovalSnapshotResponse,
): ApprovalScopedChanges {
  switch (response.kind) {
    case "scoped":
      return {
        status: "ready",
        candidate: {
          scope: "owned",
          ownedPaths: response.snapshot.ownedPaths,
          diff: response.snapshot.diff,
        },
      };
    case "drifted":
      return { status: "drifted" };
    case "unavailable":
      return { status: "unavailable", reason: response.reason };
    case "whole_tree":
      return { status: "ready", candidate: { scope: "whole_tree" } };
  }
}

/**
 * What one parked gate is decided on, for whichever approval surface renders
 * it. Every surface that offers Approve has to offer the same frozen artifact
 * behind it (R15.2).
 *
 * Asked for EVERY parked gate, enveloped or not. Skipping the request for a
 * full-access member used to return null, which the panel read as "no candidate
 * question to answer" and enabled Approve on the spot — a decision taken before
 * anything about the candidate was known. The gate's own frozen scope is what
 * the answer reports, so a full-access member now travels through the same
 * loading → ready path as an enveloped one.
 *
 * Null only when there is no parked gate at all.
 */
export function useApprovalScopedChanges(
  projectName: string,
  sessionName: string,
  standing: {
    contextId: string;
    requestedAt: string;
  } | null,
): ApprovalScopedChanges | null {
  const snapshotQuery = useGraphWorkflowApprovalSnapshotQuery(
    projectName,
    sessionName,
    standing?.contextId ?? null,
    standing?.requestedAt ?? null,
  );

  if (standing === null) return null;
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
