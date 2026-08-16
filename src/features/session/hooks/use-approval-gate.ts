"use client";

import { useCallback } from "react";
import type { ComponentProps } from "react";
import type ApprovalGatePanel from "@/components/ApprovalGatePanel";
import { useApprovalScopedChanges } from "@/hooks/use-approval-scoped-changes";
import { useResolveApprovalMutation } from "@/lib/workflows/mutations";
import { useWorkflowDefinitionQuery } from "@/lib/workflows/queries";
import type { GraphWorkflowExecution } from "@/lib/workflow-graph/schemas";
import { holdsActionableGate } from "@/lib/workflow-graph/lifecycle-classifier";

export type ApprovalGatePanelProps = ComponentProps<typeof ApprovalGatePanel>;

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
 * Gate standing for one conversation: the execution still holds the session's
 * lease and a context owned by this conversation is parked `awaiting_approval`
 * with no recorded decision. Derived purely from execution state so standing is
 * independent of `conversation.status`.
 *
 * Tenure is read from the one contract rather than mirrored as a local status
 * set, so this cannot drift from the server's derivation in
 * `src/lib/active-conversations/route-handlers.ts` — a mirrored set is what let
 * the client keep rendering a gate the feed had already dropped.
 */
export function deriveApprovalGateStanding(
  execution: GraphWorkflowExecution | null,
  conversationId: string,
): ApprovalGateStanding | null {
  if (!execution) return null;
  if (
    !holdsActionableGate(
      execution.status,
      execution.haltReason,
      execution.abandonment,
    )
  ) {
    return null;
  }
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
    standing !== null &&
      execution !== null &&
      execution.origin.kind === "template"
      ? execution.origin.definitionId
      : null,
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
