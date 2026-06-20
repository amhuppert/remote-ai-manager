"use client";

import { useMemo } from "react";
import { cn } from "@/lib/ui/cn";
import type { GraphWorkflowExecution } from "@/lib/workflows/schemas";
import ContextHaltCard from "@/components/workflow-graph/ContextHaltCard";

const wbBtn =
  "inline-flex items-center justify-center gap-[6px] font-medium rounded-sm cursor-pointer transition-all duration-150 border border-border-default whitespace-nowrap";
const wbBtnXs = "text-[0.7rem] py-[3px] px-[8px] h-[22px]";
const wbBtnDefault =
  "bg-bg-raised text-text-secondary hover:bg-bg-elevated hover:text-text-primary hover:border-border-strong";
const wbBtnPrimary =
  "bg-[var(--cc-cyan-a12)] text-cyan border-[var(--cyan-glow-strong)] hover:bg-[var(--cc-cyan-a20)] hover:shadow-[0_0_12px_var(--cyan-glow)]";
const execControlBtn = "max-768:min-h-[44px]";

const execBadgeBase =
  "text-[0.7rem] font-semibold uppercase tracking-[0.06em] py-[3px] px-[10px] rounded-[3px]";

const execBadgeByStatus: Record<string, string> = {
  running:
    "bg-[var(--cc-cyan-a12)] text-cyan border border-[var(--cyan-glow-strong)]",
  paused:
    "bg-[var(--cc-amber-a12)] text-amber border border-[var(--cc-amber-a30)]",
  completed:
    "bg-[var(--cc-green-a08)] text-green border border-[var(--cc-green-border)]",
  halted: "bg-[var(--cc-red-a08)] text-red border border-[var(--cc-red-a25)]",
  aborted: "bg-bg-raised text-text-tertiary border border-border-default",
};
import {
  createExecutionIndex,
  type ExecutionIndex,
} from "@/lib/workflow-graph/execution-index";

interface ExecutionStatusBarProps {
  execution: GraphWorkflowExecution;
  onPause: () => void;
  onResume: () => void;
  onAbort: () => void;
  onClear: () => void;
  isMutating: boolean;
}

function getActiveContextTitle(
  execution: GraphWorkflowExecution,
  index: ExecutionIndex,
): string | null {
  const activeContextId = execution.activeContextIds[0];
  if (!activeContextId) return null;
  return index.contextById.get(activeContextId)?.title ?? null;
}

function getFirstIncompleteTaskTitle(
  execution: GraphWorkflowExecution,
  index: ExecutionIndex,
): string | null {
  const activeContextId = execution.activeContextIds[0];
  if (!activeContextId) return null;
  const contextTasks = index.tasksByContext.get(activeContextId) ?? [];
  const firstIncomplete = contextTasks.find(
    (t) => execution.taskStates[t.id]?.status !== "completed",
  );
  return firstIncomplete?.title ?? null;
}

function countAwaitingApproval(execution: GraphWorkflowExecution): number {
  return Object.values(execution.contextStates).filter(
    (state) => state.status === "awaiting_approval",
  ).length;
}

const terminalStatuses = new Set(["completed", "halted", "aborted"]);
const resumableStatuses = new Set(["paused", "halted"]);

export default function ExecutionStatusBar({
  execution,
  onPause,
  onResume,
  onAbort,
  onClear,
  isMutating,
}: ExecutionStatusBarProps) {
  const definition = execution.workingDefinition;
  const index = useMemo(
    () => createExecutionIndex(definition, execution),
    [definition, execution],
  );
  const contextTitle = getActiveContextTitle(execution, index);
  const awaitingApprovalCount = countAwaitingApproval(execution);
  const taskTitle = getFirstIncompleteTaskTitle(execution, index);
  const showPause = execution.status === "running";
  const showResume = resumableStatuses.has(execution.status);
  const showAbort =
    execution.status !== "completed" && execution.status !== "aborted";
  const showClear = terminalStatuses.has(execution.status);
  const haltReason = execution.haltReason;
  const secondaryHaltReasons = execution.secondaryHaltReasons;

  return (
    <div className="flex min-h-[44px] items-center gap-md border-b border-border-dim bg-bg-surface px-md py-2 max-768:flex-wrap max-768:gap-sm">
      <div className="flex items-center gap-[8px]">
        <span
          className={cn(
            execBadgeBase,
            execBadgeByStatus[execution.status] ??
              "border border-border-default bg-bg-raised text-text-tertiary",
          )}
        >
          {execution.status}
        </span>
        {awaitingApprovalCount > 0 && (
          <span
            className={cn(
              execBadgeBase,
              "inline-flex items-center gap-[6px] border border-[var(--cc-amber-a30)] bg-[var(--cc-amber-a12)] text-amber",
            )}
          >
            <span
              className="h-[7px] w-[7px] shrink-0 animate-[pulse-dot_2.5s_ease-in-out_infinite] rounded-full bg-amber shadow-[0_0_8px_var(--amber)]"
              aria-hidden="true"
            />
            {awaitingApprovalCount} awaiting approval
          </span>
        )}
      </div>

      <div className="text-[0.72rem] text-text-secondary max-768:hidden">
        {contextTitle && (
          <>
            Context:{" "}
            <strong className="font-semibold text-text-primary">
              {contextTitle}
            </strong>
          </>
        )}
        {contextTitle && taskTitle && " · "}
        {taskTitle && (
          <>
            Task:{" "}
            <strong className="font-semibold text-text-primary">
              {taskTitle}
            </strong>
          </>
        )}
      </div>

      <div className="ml-auto flex gap-sm">
        {showPause && (
          <button
            className={cn(wbBtn, wbBtnXs, wbBtnDefault, execControlBtn)}
            onClick={onPause}
            disabled={isMutating}
            type="button"
          >
            Pause
          </button>
        )}
        {showResume && (
          <button
            className={cn(wbBtn, wbBtnXs, wbBtnPrimary, execControlBtn)}
            onClick={onResume}
            disabled={isMutating}
            type="button"
          >
            Resume
          </button>
        )}
        {showAbort && (
          <button
            className={cn(wbBtn, wbBtnXs, wbBtnDefault, execControlBtn)}
            onClick={onAbort}
            disabled={isMutating}
            style={{ color: "var(--red)" }}
            type="button"
          >
            Abort
          </button>
        )}
        {showClear && (
          <button
            className={cn(wbBtn, wbBtnXs, wbBtnDefault, execControlBtn)}
            onClick={onClear}
            disabled={isMutating}
            type="button"
          >
            Clear
          </button>
        )}
      </div>

      {haltReason && (
        <ContextHaltCard
          primary={haltReason}
          secondary={secondaryHaltReasons}
          variant="banner"
        />
      )}
    </div>
  );
}
