"use client";

import { useMemo } from "react";
import { Badge } from "@/components/ui/Badge";
import { StatusChip, type StatusChipTone } from "@/components/ui/StatusChip";
import { formatGraphWorkflowHaltReason } from "@/components/workflow-graph/ContextHaltCard";
import type {
  GraphWorkflowExecution,
  GraphWorkflowExecutionHistoryItem,
} from "@/lib/workflow-graph/schemas";
import {
  originFallbackName,
  originKindLabel,
} from "@/lib/workflow-graph/execution-origin";
import {
  useGraphWorkflowExecutionByIdQuery,
  useGraphWorkflowExecutionResultQuery,
} from "@/lib/workflows/queries";

const TONE_BY_STATUS: Record<string, StatusChipTone> = {
  completed: "green",
  aborted: "neutral",
  halted: "red",
  paused: "amber",
  running: "cyan",
  pending: "neutral",
};

interface ArchivedExecutionsListProps {
  projectName: string;
  sessionName: string;
  current: GraphWorkflowExecution | null;
  executions: GraphWorkflowExecutionHistoryItem[];
  /** Null while session membership is unresolved; otherwise the live rows. */
  sessionConversationIds: ReadonlySet<string> | null;
  selectedExecutionId: string | null;
  onSelect(executionId: string): void;
}

function formatExecutionTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function executionName(execution: GraphWorkflowExecution | null): string {
  if (execution === null) return "Workflow execution";
  if (execution.launchDocument !== null) return execution.launchDocument.name;
  return originFallbackName(execution.origin);
}

function ExecutionRailRow({
  projectName,
  sessionName,
  executionId,
  summary,
  current,
  sessionConversationIds,
  selected,
  onSelect,
}: {
  projectName: string;
  sessionName: string;
  executionId: string;
  summary: GraphWorkflowExecutionHistoryItem | null;
  current: GraphWorkflowExecution | null;
  sessionConversationIds: ReadonlySet<string> | null;
  selected: boolean;
  onSelect(executionId: string): void;
}) {
  const byIdQuery = useGraphWorkflowExecutionByIdQuery(
    projectName,
    sessionName,
    current === null ? executionId : null,
  );
  const resultQuery = useGraphWorkflowExecutionResultQuery(
    projectName,
    sessionName,
    executionId,
  );
  const execution = current ?? byIdQuery.data ?? null;
  const status = execution?.status ?? summary?.status ?? "pending";
  const haltReason = execution?.haltReason ?? summary?.haltReason ?? null;
  const halt =
    haltReason === null ? null : formatGraphWorkflowHaltReason(haltReason);
  const name = executionName(execution);
  const description =
    execution?.launchDocument?.description ?? "No description";
  const origin = execution?.origin ?? null;
  const originConversationId = execution?.ownerConversationId ?? null;
  const originConversationLabel =
    originConversationId === null
      ? "No origin conversation"
      : sessionConversationIds === null ||
          sessionConversationIds.has(originConversationId)
        ? originConversationId
        : "Origin conversation deleted";
  const time =
    execution?.completedAt ??
    summary?.completedAt ??
    execution?.startedAt ??
    summary?.startedAt ??
    null;

  return (
    <li>
      <button
        type="button"
        aria-label={`Execution ${executionId}: ${name}`}
        aria-current={selected ? "true" : undefined}
        data-selected={selected ? "true" : "false"}
        onClick={() => onSelect(executionId)}
        className="flex w-full cursor-pointer flex-col gap-sm rounded-md border border-solid border-border-subtle bg-bg-surface p-md text-left font-mono text-text-primary transition-colors duration-150 hover:border-border-strong hover:bg-bg-raised focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:outline-offset-2 data-[selected=true]:border-border-default data-[selected=true]:bg-bg-raised"
      >
        <span className="flex w-full min-w-0 items-center gap-sm">
          <span className="min-w-0 flex-1 truncate text-[0.78rem] font-semibold">
            {name}
          </span>
          <StatusChip tone={TONE_BY_STATUS[status] ?? "neutral"}>
            {status}
          </StatusChip>
        </span>
        <span className="flex w-full flex-wrap items-center gap-xs text-[0.7rem] text-text-tertiary">
          <Badge tier="count">
            {origin === null ? "One-off" : originKindLabel(origin)}
          </Badge>
          {origin?.kind === "template" && (
            <span>rev {origin.definitionRevision}</span>
          )}
          <span>{resultQuery.data == null ? "No result" : "Result"}</span>
          {time !== null && <span>{formatExecutionTime(time)}</span>}
        </span>
        <span className="line-clamp-2 text-[0.72rem] text-text-secondary">
          {description}
        </span>
        <span className="flex w-full items-center justify-between gap-sm text-[0.7rem] text-text-tertiary">
          <span className="truncate">{originConversationLabel}</span>
          <span className="shrink-0">{executionId}</span>
        </span>
        {halt !== null && (
          <span className="line-clamp-2 text-[0.7rem] text-red">
            {halt.headline}
          </span>
        )}
      </button>
    </li>
  );
}

export default function ArchivedExecutionsList({
  projectName,
  sessionName,
  current,
  executions,
  sessionConversationIds,
  selectedExecutionId,
  onSelect,
}: ArchivedExecutionsListProps) {
  const history = useMemo(
    () =>
      [...executions].sort(
        (left, right) =>
          Date.parse(right.startedAt) - Date.parse(left.startedAt),
      ),
    [executions],
  );

  if (current === null && history.length === 0) return null;

  return (
    <nav
      aria-label="Workflow executions"
      className="flex min-h-0 w-[300px] shrink-0 flex-col gap-lg overflow-y-auto border-y-0 border-r border-l-0 border-solid border-border-subtle bg-bg-base p-md max-768:w-full max-768:border-x-0 max-768:border-t-0 max-768:border-b"
    >
      {current !== null && (
        <section aria-label="Current" className="flex flex-col gap-sm">
          <h2 className="m-0 font-mono text-[0.72rem] font-bold tracking-[0.08em] text-text-secondary uppercase">
            Current
          </h2>
          <ul className="m-0 list-none p-0">
            <ExecutionRailRow
              projectName={projectName}
              sessionName={sessionName}
              executionId={current.id}
              summary={null}
              current={current}
              sessionConversationIds={sessionConversationIds}
              selected={selectedExecutionId === current.id}
              onSelect={onSelect}
            />
          </ul>
        </section>
      )}
      {history.length > 0 && (
        <section aria-label="History" className="flex flex-col gap-sm">
          <h2 className="m-0 font-mono text-[0.72rem] font-bold tracking-[0.08em] text-text-secondary uppercase">
            History
          </h2>
          <ul className="m-0 flex list-none flex-col gap-xs p-0">
            {history.map((summary) => (
              <ExecutionRailRow
                key={summary.executionId}
                projectName={projectName}
                sessionName={sessionName}
                executionId={summary.executionId}
                summary={summary}
                current={null}
                sessionConversationIds={sessionConversationIds}
                selected={selectedExecutionId === summary.executionId}
                onSelect={onSelect}
              />
            ))}
          </ul>
        </section>
      )}
    </nav>
  );
}
