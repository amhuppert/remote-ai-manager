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
  // Asked for every parked gate. The frozen scope is the API's answer to give,
  // not this hook's to pre-empt: skipping the request for a full-access member
  // left the panel with no candidate state and an immediately-live Approve.
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
    iteration:
      execution.contextStates[standing.contextId]?.iterationCount ?? null,
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
