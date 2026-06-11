"use client";

import { useMemo } from "react";
import type { GraphWorkflowExecution } from "@/lib/workflows/schemas";
import ContextHaltCard from "@/components/workflow-graph/ContextHaltCard";
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
    <div className="wb-exec-bar">
      <div className="wb-exec-status">
        <span className={`wb-exec-badge ${execution.status}`}>
          {execution.status}
        </span>
        {awaitingApprovalCount > 0 && (
          <span className="wb-exec-badge awaiting-approval">
            <span className="wb-exec-badge__dot" aria-hidden="true" />
            {awaitingApprovalCount} awaiting approval
          </span>
        )}
      </div>

      <div className="wb-exec-info">
        {contextTitle && (
          <>
            Context: <strong>{contextTitle}</strong>
          </>
        )}
        {contextTitle && taskTitle && " · "}
        {taskTitle && (
          <>
            Task: <strong>{taskTitle}</strong>
          </>
        )}
      </div>

      <div className="wb-exec-controls">
        {showPause && (
          <button
            className="wb-btn wb-btn-xs wb-btn-default"
            onClick={onPause}
            disabled={isMutating}
            type="button"
          >
            Pause
          </button>
        )}
        {showResume && (
          <button
            className="wb-btn wb-btn-xs wb-btn-primary"
            onClick={onResume}
            disabled={isMutating}
            type="button"
          >
            Resume
          </button>
        )}
        {showAbort && (
          <button
            className="wb-btn wb-btn-xs wb-btn-default"
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
            className="wb-btn wb-btn-xs wb-btn-default"
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
