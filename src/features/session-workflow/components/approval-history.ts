import type { GraphWorkflowExecutionEvent } from "@/lib/workflow-graph/event-schemas";
import type { GraphWorkflowExecution } from "@/lib/workflow-graph/schemas";

/**
 * The run's approval trail, as data.
 *
 * Definition approval lives on the execution record; context approvals live in
 * the event log. Both are read here so the history list and the Overview's
 * Approvals row cannot disagree about what was decided — README §11 puts them
 * on the same surface, and a second derivation is how two surfaces start
 * counting differently.
 */
export interface ApprovalHistoryEntry {
  key: string;
  label: string;
  occurredAt: string;
  conversationId: string | null;
  message: string | null;
}

function definitionApprovalEntry(
  execution: GraphWorkflowExecution,
): ApprovalHistoryEntry | null {
  const approval = execution.definitionApproval;
  if (approval === null) return null;

  if (approval.approvedAt !== null) {
    return {
      key: "definition-approved",
      label: "Definition approved",
      occurredAt: approval.approvedAt,
      conversationId: null,
      message: null,
    };
  }

  if (
    execution.status === "aborted" &&
    execution.haltReason?.type === "aborted" &&
    execution.haltReason.cause === "definition_rejected"
  ) {
    return {
      key: "definition-rejected",
      label: "Definition rejected",
      occurredAt: execution.completedAt ?? approval.requestedAt,
      conversationId: null,
      message: execution.haltReason.summary,
    };
  }

  return {
    key: "definition-requested",
    label: "Definition requested approval",
    occurredAt: approval.requestedAt,
    conversationId: null,
    message: null,
  };
}

function contextApprovalEntries(
  execution: GraphWorkflowExecution,
  events: readonly GraphWorkflowExecutionEvent[],
): ApprovalHistoryEntry[] {
  const titleByContextId = new Map(
    execution.workingDefinition.executionContexts.map((context) => [
      context.id,
      context.title,
    ]),
  );

  return events.flatMap((entry, index): ApprovalHistoryEntry[] => {
    const event = entry.event;
    if (event.type === "graph-workflow-approval-pending") {
      const title =
        event.contextTitle ??
        titleByContextId.get(event.contextId) ??
        event.contextId;
      return [
        {
          key: `context-requested:${index}:${event.contextId}:${event.requestedAt}`,
          label: `${title} requested approval`,
          occurredAt: event.requestedAt,
          conversationId: event.conversationId,
          message: null,
        },
      ];
    }
    if (event.type === "graph-workflow-approval-resolved") {
      const title = titleByContextId.get(event.contextId) ?? event.contextId;
      return [
        {
          key: `context-resolved:${index}:${event.contextId}:${event.decidedAt}`,
          label: `${title} ${event.decision}`,
          occurredAt: event.decidedAt,
          conversationId: event.conversationId,
          message: event.message,
        },
      ];
    }
    return [];
  });
}

export function deriveApprovalHistory(
  execution: GraphWorkflowExecution,
  events: readonly GraphWorkflowExecutionEvent[],
): ApprovalHistoryEntry[] {
  const definition = definitionApprovalEntry(execution);
  return [
    ...(definition === null ? [] : [definition]),
    ...contextApprovalEntries(execution, events),
  ];
}
