"use client";

import { useMemo } from "react";
import { IconButton } from "@/components/ui/IconButton";
import { StatusChip, type StatusChipTone } from "@/components/ui/StatusChip";
import { ChevronLeftIcon } from "@/components/workflow-config-panel/icons";
import { formatGraphWorkflowHaltReason } from "@/components/workflow-graph/ContextHaltCard";
import { railOverlayPanelClass } from "@/components/workflow-graph/RailOverlay";
import { cn } from "@/lib/ui/cn";
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
import {
  formatBoundInputsLine,
  formatExecutionRailMeta,
  partitionExecutionRail,
  resolveLaunchRevision,
  type ExecutionTenure,
} from "./execution-rail";

const TONE_BY_STATUS: Record<string, StatusChipTone> = {
  completed: "green",
  aborted: "neutral",
  halted: "red",
  paused: "amber",
  running: "cyan",
  pending: "neutral",
};

const sectionHeading =
  "m-0 font-mono text-[0.7rem] font-bold tracking-[0.08em] text-text-tertiary uppercase";

/**
 * The lease candidate the rail places, keyed the way every rail row is. The
 * execution record calls its identity `id` and a history summary calls the same
 * durable id `executionId`; the rail speaks one of those, so the adaptation
 * happens once here rather than at each row.
 */
type LeaseRow = GraphWorkflowExecution & { readonly executionId: string };

interface ArchivedExecutionsListProps {
  projectName: string;
  sessionName: string;
  current: GraphWorkflowExecution | null;
  executions: GraphWorkflowExecutionHistoryItem[];
  /** Null while session membership is unresolved; otherwise the live rows. */
  sessionConversationIds: ReadonlySet<string> | null;
  selectedExecutionId: string | null;
  onSelect(executionId: string): void;
  /** Wired by the page that owns the collapsed state; absent hides the control. */
  onCollapse?: () => void;
  /** §12: float over the canvas instead of taking width from it. */
  overlay?: boolean;
  /**
   * Where the list is standing. `rail` is the desktop side rail; `sheet` is the
   * mobile Executions sheet (M2), which supplies its own heading and scroll box
   * — so the list drops the rail's width, border and collapse chrome and keeps
   * only the Current/History sections. One component either way: the tenure
   * split and the row content are the same claim in both places.
   */
  presentation?: "rail" | "sheet";
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
  tenure,
  summary,
  current,
  sessionConversationIds,
  selected,
  onSelect,
}: {
  projectName: string;
  sessionName: string;
  executionId: string;
  tenure: ExecutionTenure;
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
  const startedAt = execution?.startedAt ?? summary?.startedAt ?? null;
  const meta = formatExecutionRailMeta({
    tenure,
    executionId,
    launchRevision: resolveLaunchRevision({
      origin: execution?.origin ?? null,
      summaryDefinitionId: summary?.definitionId ?? null,
      summaryDefinitionRevision: summary?.definitionRevision ?? null,
    }),
    originLabel:
      execution === null ? "Workflow" : originKindLabel(execution.origin),
    // The launch snapshot's own shape, so an edited template never restates a
    // launched run's size.
    contextCount:
      execution === null
        ? null
        : execution.workingDefinition.executionContexts.length,
    launchedAtLabel: startedAt === null ? null : formatExecutionTime(startedAt),
  });
  const inputs =
    execution === null ? null : formatBoundInputsLine(execution.boundInputs);
  const description = execution?.launchDocument?.description ?? null;
  const originConversationId = execution?.ownerConversationId ?? null;
  const originConversationLabel =
    originConversationId === null
      ? "No origin conversation"
      : sessionConversationIds === null ||
          sessionConversationIds.has(originConversationId)
        ? originConversationId
        : "Origin conversation deleted";

  return (
    <li>
      <button
        type="button"
        aria-label={`Execution ${executionId}: ${name}`}
        aria-current={selected ? "true" : undefined}
        data-selected={selected ? "true" : "false"}
        onClick={() => onSelect(executionId)}
        className="flex w-full cursor-pointer flex-col gap-xs rounded-md border border-solid border-border-subtle bg-bg-surface p-md text-left font-mono text-text-primary transition-colors duration-150 hover:border-border-strong hover:bg-bg-raised focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:outline-offset-2 data-[selected=true]:border-[var(--cc-cyan-a40)] data-[selected=true]:bg-[var(--cc-cyan-a08)]"
      >
        <span className="flex w-full min-w-0 items-center gap-sm">
          <span className="min-w-0 flex-1 truncate text-[0.76rem] font-semibold">
            {name}
          </span>
          <StatusChip
            tone={TONE_BY_STATUS[status] ?? "neutral"}
            layoutClassName="shrink-0"
          >
            {status}
          </StatusChip>
        </span>
        <span className="text-[0.7rem] leading-normal text-text-secondary">
          {meta}
        </span>
        {inputs !== null && (
          <span className="text-[0.7rem] text-text-tertiary">{inputs}</span>
        )}
        {description !== null && (
          <span className="line-clamp-2 text-[0.7rem] text-text-secondary">
            {description}
          </span>
        )}
        <span className="flex w-full items-center justify-between gap-sm text-[0.7rem] text-text-tertiary">
          <span className="truncate">{originConversationLabel}</span>
          {resultQuery.data != null && <span className="shrink-0">Result</span>}
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
  onCollapse,
  overlay = false,
  presentation = "rail",
}: ArchivedExecutionsListProps) {
  const asSheet = presentation === "sheet";
  // Tenure, not terminality: a paused or resumably halted run stays Current,
  // and the run the active-execution endpoint still answers with after it ended
  // is demoted into History rather than shown in both places.
  const rail = useMemo(
    () =>
      partitionExecutionRail<LeaseRow, GraphWorkflowExecutionHistoryItem>(
        current === null ? null : { ...current, executionId: current.id },
        executions,
      ),
    [current, executions],
  );

  if (rail.current === null && rail.history.length === 0) return null;

  return (
    <nav
      aria-label="Workflow executions"
      className={cn(
        "flex min-h-0 flex-col",
        asSheet
          ? "flex-1"
          : cn(
              "w-[300px] shrink-0 overflow-hidden border-y-0 border-r border-l-0 border-solid border-border-subtle bg-bg-base max-768:w-full max-768:border-x-0 max-768:border-t-0 max-768:border-b",
              overlay && railOverlayPanelClass("left"),
            ),
      )}
    >
      {!asSheet && (
        <div className="flex shrink-0 items-center gap-sm border-x-0 border-t-0 border-b border-solid border-border-dim px-md py-sm">
          <h2 className="m-0 font-mono text-[0.7rem] font-bold tracking-[0.08em] text-text-secondary uppercase">
            Executions
          </h2>
          {onCollapse !== undefined && (
            <IconButton
              variant="square"
              aria-label="Collapse executions rail"
              title="Collapse executions rail"
              onClick={onCollapse}
              layoutClassName="ml-auto"
            >
              <ChevronLeftIcon />
            </IconButton>
          )}
        </div>
      )}

      <div
        className={cn(
          "flex min-h-0 flex-1 flex-col gap-lg overflow-y-auto",
          asSheet ? "p-0" : "p-md",
        )}
      >
        {rail.current !== null && (
          <section aria-label="Current" className="flex flex-col gap-sm">
            <div className="flex items-baseline gap-sm">
              <h3 className={sectionHeading}>Current</h3>
              <span
                title="Current holds the session's execution lease. Paused and resumably halted runs stay here."
                className="font-mono text-[0.7rem] text-text-tertiary"
              >
                holds the lease
              </span>
            </div>
            <ul className="m-0 list-none p-0">
              <ExecutionRailRow
                projectName={projectName}
                sessionName={sessionName}
                executionId={rail.current.executionId}
                tenure="current"
                summary={null}
                current={rail.current}
                sessionConversationIds={sessionConversationIds}
                selected={selectedExecutionId === rail.current.executionId}
                onSelect={onSelect}
              />
            </ul>
          </section>
        )}
        {rail.history.length > 0 && (
          <section aria-label="History" className="flex flex-col gap-sm">
            <h3 className={sectionHeading}>History · newest first</h3>
            <ul className="m-0 flex list-none flex-col gap-xs p-0">
              {rail.history.map((row) => {
                const shared = {
                  projectName,
                  sessionName,
                  executionId: row.executionId,
                  tenure: "history" as const,
                  sessionConversationIds,
                  selected: selectedExecutionId === row.executionId,
                  onSelect,
                };
                // A demoted lease row carries the whole execution, so it needs
                // no second fetch of what it already is.
                return "workingDefinition" in row ? (
                  <ExecutionRailRow
                    key={row.executionId}
                    {...shared}
                    summary={null}
                    current={row}
                  />
                ) : (
                  <ExecutionRailRow
                    key={row.executionId}
                    {...shared}
                    summary={row}
                    current={null}
                  />
                );
              })}
            </ul>
            <p className="m-0 px-[2px] font-mono text-[0.7rem] leading-normal text-text-tertiary">
              History is inspectable and deep-linkable. Every row keeps its
              immutable launch snapshot and has no mutation controls.
            </p>
          </section>
        )}
      </div>
    </nav>
  );
}
