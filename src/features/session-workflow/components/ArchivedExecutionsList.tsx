"use client";

import { StatusChip, type StatusChipTone } from "@/components/ui/StatusChip";
import { formatGraphWorkflowHaltReason } from "@/components/workflow-graph/ContextHaltCard";
import { formatRelativeTime } from "@/lib/shared/format-relative-time";
import type { GraphWorkflowExecutionHistoryItem } from "@/lib/workflow-graph/schemas";

/**
 * A session's finished graph-workflow runs.
 *
 * The workflow panel used to dead-end at "no execution has started" whenever a
 * session's active slot was empty, which hid every run the session had already
 * finished. It also hid the one place a cutover-aborted run can explain itself:
 * the assignment-cutover migration ends non-terminal executions and archives
 * them, so an operator whose run was ended by an upgrade sees nothing but that
 * empty state unless the archive is rendered here.
 */
const TONE_BY_STATUS: Record<string, StatusChipTone> = {
  completed: "green",
  aborted: "neutral",
  halted: "red",
  paused: "amber",
  running: "cyan",
  pending: "neutral",
};

interface ArchivedExecutionsListProps {
  executions: GraphWorkflowExecutionHistoryItem[];
}

export default function ArchivedExecutionsList({
  executions,
}: ArchivedExecutionsListProps) {
  if (executions.length === 0) return null;

  return (
    <section
      aria-label="Previous runs"
      className="flex w-full max-w-[640px] flex-col gap-sm"
    >
      <h2 className="m-0 font-mono text-[0.72rem] font-bold tracking-[0.05em] text-text-tertiary uppercase">
        Previous runs
      </h2>
      <ul className="m-0 flex list-none flex-col gap-xs p-0">
        {executions.map((execution) => {
          const halt =
            execution.haltReason === null
              ? null
              : formatGraphWorkflowHaltReason(execution.haltReason);
          return (
            <li
              key={execution.executionId}
              className="flex flex-col gap-xs rounded-md border border-solid border-border-subtle bg-bg-raised px-md py-sm"
            >
              <div className="flex flex-wrap items-center gap-sm">
                <StatusChip
                  tone={TONE_BY_STATUS[execution.status] ?? "neutral"}
                >
                  {execution.status}
                </StatusChip>
                <span className="font-mono text-[0.7rem] text-text-tertiary">
                  {execution.executionId}
                </span>
                <span className="text-[0.7rem] text-text-tertiary">
                  started {formatRelativeTime(execution.startedAt)}
                </span>
              </div>
              {halt && (
                <div className="flex flex-col gap-[3px]">
                  <p className="m-0 text-[0.74rem] font-medium text-text-secondary">
                    {halt.headline}
                  </p>
                  {halt.detail !== null && (
                    <div className="m-0 text-[0.7rem] text-text-tertiary">
                      {halt.detail}
                    </div>
                  )}
                  {halt.action !== null && (
                    <p className="m-0 text-[0.7rem] text-text-tertiary">
                      {halt.action}
                    </p>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
