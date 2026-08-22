"use client";

import { useMemo } from "react";
import type { GraphWorkflowExecutionEvent } from "@/lib/workflow-graph/event-schemas";
import type { GraphWorkflowExecution } from "@/lib/workflow-graph/schemas";
import { deriveApprovalHistory } from "./approval-history";

function formatApprovalTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

export default function WorkflowApprovalHistory({
  execution,
  events,
}: {
  execution: GraphWorkflowExecution;
  events: readonly GraphWorkflowExecutionEvent[];
}) {
  const entries = useMemo(
    () => deriveApprovalHistory(execution, events),
    [events, execution],
  );

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
