"use client";

import { useCallback } from "react";
import type { ComponentProps } from "react";
import type ApprovalGatePanel from "@/components/ApprovalGatePanel";
import type { ApprovalScopedChanges } from "@/components/ApprovalGatePanel";
import { getErrorMessage } from "@/lib/shared/errors";
import { useResolveApprovalMutation } from "@/lib/workflows/mutations";
import {
  useGraphWorkflowApprovalSnapshotQuery,
  useWorkflowDefinitionQuery,
} from "@/lib/workflows/queries";
import type {
  GraphWorkflowApprovalSnapshotResponse,
  GraphWorkflowExecution,
} from "@/lib/workflow-graph/schemas";
import type { GraphWorkflowStatus } from "@/lib/workflow-graph/definition-schemas";

export type ApprovalGatePanelProps = ComponentProps<typeof ApprovalGatePanel>;

/**
 * Execution statuses under which an undecided approval gate keeps standing —
 * the gate survives pause/halt/restart and disappears only when the execution
 * leaves the in-flight set. Mirrors the server-side derivation in
 * `src/lib/active-conversations/route-handlers.ts` (keep the two in sync).
 */
const GATE_STANDING_EXECUTION_STATUSES: ReadonlySet<GraphWorkflowStatus> =
  new Set(["running", "paused", "halted"]);

export interface ApprovalGateStanding {
  contextId: string;
  contextTitle: string | null;
  requestedAt: string;
  /**
   * Whether this gate was frozen under a file-ownership envelope (R15.2). Read
   * from the PARKED record's frozen scope, never from the context's live
   * placement: placement is editable while the gate stands, and re-deriving it
   * here would silently turn a decision frozen under an envelope into a
   * whole-tree one the moment a paused execution is re-placed.
   */
  enveloped: boolean;
}

/**
 * Gate standing for one conversation: the execution is in-flight and a context
 * owned by this conversation is parked `awaiting_approval` with no recorded
 * decision. Derived purely from execution state so standing is independent of
 * `conversation.status`.
 */
export function deriveApprovalGateStanding(
  execution: GraphWorkflowExecution | null,
  conversationId: string,
): ApprovalGateStanding | null {
  if (!execution) return null;
  if (!GATE_STANDING_EXECUTION_STATUSES.has(execution.status)) return null;
  for (const contextState of Object.values(execution.contextStates)) {
    if (contextState.status !== "awaiting_approval") continue;
    const record = contextState.pendingApproval;
    if (!record || record.decision !== null) continue;
    if (record.conversationId !== conversationId) continue;
    const context = execution.workingDefinition.executionContexts.find(
      (c) => c.id === contextState.contextId,
    );
    return {
      contextId: contextState.contextId,
      contextTitle: context?.title ?? null,
      requestedAt: record.requestedAt,
      enveloped: record.approvalScope.kind !== "whole_tree",
    };
  }
  return null;
}

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
 * it. Shared by the conversation workspace panel and the sidebar peek so the
 * two surfaces cannot disagree about what a reviewer is shown — every surface
 * that offers Approve has to offer the same frozen artifact behind it (R15.2).
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

export interface UseApprovalGateArgs {
  projectName: string;
  sessionName: string;
  conversationId: string;
  execution: GraphWorkflowExecution | null;
  conversationBusy: boolean;
}

/**
 * Builds the ApprovalGatePanel props for the conversation view, or null when
 * the conversation has no undecided gate (panel hidden, read-only treatment
 * applies again).
 */
export function useApprovalGate({
  projectName,
  sessionName,
  conversationId,
  execution,
  conversationBusy,
}: UseApprovalGateArgs): ApprovalGatePanelProps | null {
  const standing = deriveApprovalGateStanding(execution, conversationId);
  const resolveMutation = useResolveApprovalMutation(projectName, sessionName);
  const seedDefinitionQuery = useWorkflowDefinitionQuery(
    projectName,
    standing !== null ? (execution?.seedDefinitionId ?? null) : null,
  );
  // Fetched only for an enveloped context. A full-access member is left on the
  // whole-tree view it has always been reviewed under, so it costs no request.
  const scopedChanges = useApprovalScopedChanges(
    projectName,
    sessionName,
    standing,
  );

  const contextId = standing?.contextId ?? null;
  const onApprove = useCallback(() => {
    if (contextId === null) return;
    resolveMutation.mutate({ contextId, decision: "approve" });
  }, [contextId, resolveMutation]);
  const onReject = useCallback(
    (message: string) => {
      if (contextId === null) return;
      resolveMutation.mutate({ contextId, decision: "reject", message });
    },
    [contextId, resolveMutation],
  );

  if (standing === null || execution === null) return null;

  return {
    contextTitle: standing.contextTitle,
    workflowName: seedDefinitionQuery.data?.item.name ?? null,
    requestedAt: standing.requestedAt,
    isSubmitting: resolveMutation.isPending,
    conversationBusy,
    scopedChanges,
    executionSuspended:
      execution.status === "paused" || execution.status === "halted",
    onApprove,
    onReject,
  };
}
