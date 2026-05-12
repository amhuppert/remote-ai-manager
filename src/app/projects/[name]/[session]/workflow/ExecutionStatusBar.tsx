"use client";

import type { GraphWorkflowExecution } from "@/types";
import ContextHaltCard, {
  formatGraphWorkflowHaltReason,
} from "@/components/workflow-graph/ContextHaltCard";

export { formatGraphWorkflowHaltReason };

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
): string | null {
  const activeContextId = execution.activeContextIds[0];
  if (!activeContextId) return null;
  return (
    execution.workingDefinition.executionContexts.find(
      (ctx) => ctx.id === activeContextId,
    )?.title ?? null
  );
}

function getFirstIncompleteTaskTitle(
  execution: GraphWorkflowExecution,
): string | null {
  const activeContextId = execution.activeContextIds[0];
  if (!activeContextId) return null;
  const contextTasks = execution.workingDefinition.tasks
    .filter((t) => t.contextId === activeContextId)
    .sort((a, b) => a.order - b.order);
  const firstIncomplete = contextTasks.find(
    (t) => execution.taskStates[t.id]?.status !== "completed",
  );
  return firstIncomplete?.title ?? null;
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
  const contextTitle = getActiveContextTitle(execution);
  const taskTitle = getFirstIncompleteTaskTitle(execution);
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
