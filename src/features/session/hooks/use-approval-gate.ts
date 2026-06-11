"use client";

import { useCallback } from "react";
import type { ComponentProps } from "react";
import type ApprovalGatePanel from "@/components/ApprovalGatePanel";
import { useResolveApprovalMutation } from "@/lib/workflows/mutations";
import { useWorkflowDefinitionQuery } from "@/lib/workflows/queries";
import type {
  GraphWorkflowExecution,
  GraphWorkflowStatus,
} from "@/lib/workflows/schemas";

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
    standing !== null ? (execution?.seedDefinitionId ?? null) : null,
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
    executionSuspended:
      execution.status === "paused" || execution.status === "halted",
    onApprove,
    onReject,
  };
}
