"use client";

import { useMemo } from "react";
import type { GraphWorkflowExecutionEvent } from "@/lib/workflow-graph/event-schemas";
import type { GraphWorkflowExecution } from "@/lib/workflow-graph/schemas";

interface ApprovalHistoryEntry {
  key: string;
  label: string;
  occurredAt: string;
  conversationId: string | null;
  message: string | null;
}

function formatApprovalTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
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

export default function WorkflowApprovalHistory({
  execution,
  events,
}: {
  execution: GraphWorkflowExecution;
  events: readonly GraphWorkflowExecutionEvent[];
}) {
  const entries = useMemo(() => {
    const definition = definitionApprovalEntry(execution);
    return [
      ...(definition === null ? [] : [definition]),
      ...contextApprovalEntries(execution, events),
    ];
  }, [events, execution]);

  if (entries.length === 0) return null;

  return (
    <section
      aria-label="Approval history"
      className="flex shrink-0 flex-col gap-sm border-x-0 border-t-0 border-b border-solid border-border-dim bg-bg-surface px-md py-sm font-mono"
    >
      <h2 className="m-0 text-[0.7rem] font-semibold tracking-[0.08em] text-text-secondary uppercase">
        Approval history
      </h2>
      <ul className="m-0 flex list-none flex-col gap-xs p-0">
        {entries.map((entry) => (
          <li
            key={entry.key}
            className="flex flex-wrap items-baseline gap-x-sm gap-y-xs text-[0.7rem] text-text-tertiary"
          >
            <strong className="font-semibold text-text-primary">
              {entry.label}
            </strong>
            <span>{formatApprovalTime(entry.occurredAt)}</span>
            {entry.conversationId !== null && (
              <span>{entry.conversationId}</span>
            )}
            {entry.message !== null && (
              <span className="basis-full text-text-secondary">
                {entry.message}
              </span>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
