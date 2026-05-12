"use client";

import { useState, type ReactNode } from "react";
import type { GraphWorkflowExecution, GraphWorkflowHaltReason } from "@/types";

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

interface FormattedHaltReason {
  headline: string;
  detail: ReactNode | null;
  action: string | null;
}

function renderDirtyPathList(
  dirtyPaths: ReadonlyArray<{ path: string; statusCode: string }>,
  total: number,
): ReactNode {
  const truncatedExtras = total - dirtyPaths.length;
  return (
    <ul className="wb-exec-halt-paths">
      {dirtyPaths.map((p) => (
        <li key={p.path}>
          <code>{p.statusCode.trim() || "??"}</code> {p.path}
        </li>
      ))}
      {truncatedExtras > 0 && <li>+{truncatedExtras} more</li>}
    </ul>
  );
}

export function formatGraphWorkflowHaltReason(
  reason: GraphWorkflowHaltReason,
): FormattedHaltReason {
  switch (reason.type) {
    case "merge_precondition_failed":
      return {
        headline: `Cannot merge into ${reason.targetBranch} — ${reason.totalDirtyCount} uncommitted change(s)`,
        detail: renderDirtyPathList(reason.dirtyPaths, reason.totalDirtyCount),
        action:
          "Commit, stash, or discard those changes in the session worktree, then resume.",
      };
    case "agent_turn_failed":
      return {
        headline: `Agent turn failed in ${reason.contextId} (${reason.engine})`,
        detail: <pre className="wb-exec-halt-pre">{reason.message}</pre>,
        action: "Resume to retry, or inspect the agent transcript.",
      };
    case "worktree_creation_dirty":
      return {
        headline: `Worktree created with uncommitted changes — ${reason.branchName}`,
        detail: renderDirtyPathList(reason.dirtyPaths, reason.totalDirtyCount),
        action: `Investigate ${reason.worktreePath}; resume to continue.`,
      };
    case "execution_loop_failed":
      return {
        headline: "Execution loop error",
        detail: <pre className="wb-exec-halt-pre">{reason.message}</pre>,
        action: "Resume to retry.",
      };
    case "merge_failure":
      return {
        headline: `Merge failed in ${reason.contextId}`,
        detail: <pre className="wb-exec-halt-pre">{reason.message}</pre>,
        action: "Resolve conflicts in the worktree, then resume.",
      };
    case "circuit_breaker":
      return {
        headline: `Circuit breaker tripped in ${reason.contextId}`,
        detail: reason.summary ? <p>{reason.summary}</p> : null,
        action: null,
      };
    case "max_iterations":
      return {
        headline: `Max iterations reached in ${reason.contextId} (${reason.iterationCount})`,
        detail: null,
        action: null,
      };
    case "recovery_error":
      return {
        headline: "Recovery error",
        detail: <pre className="wb-exec-halt-pre">{reason.message}</pre>,
        action: null,
      };
    case "validator_infra_error":
      return {
        headline: `Validator infrastructure error in ${reason.contextId}`,
        detail: <pre className="wb-exec-halt-pre">{reason.message}</pre>,
        action: null,
      };
    case "script_validator_missing_command":
      return {
        headline: `Script validator missing command in ${reason.contextId}`,
        detail: <pre className="wb-exec-halt-pre">{reason.message}</pre>,
        action: null,
      };
    case "aborted":
      return { headline: "Execution aborted", detail: null, action: null };
  }
}

const terminalStatuses = new Set(["completed", "halted", "aborted"]);
const resumableStatuses = new Set(["paused", "halted"]);

interface HaltBannerProps {
  primary: GraphWorkflowHaltReason;
  secondary: GraphWorkflowHaltReason[];
}

function HaltBanner({ primary, secondary }: HaltBannerProps) {
  const [expanded, setExpanded] = useState(false);
  const formatted = formatGraphWorkflowHaltReason(primary);
  return (
    <div className="wb-exec-halt-banner" role="alert">
      <div className="wb-exec-halt-headline">{formatted.headline}</div>
      {formatted.detail && (
        <div className="wb-exec-halt-detail">{formatted.detail}</div>
      )}
      {formatted.action && (
        <div className="wb-exec-halt-action">{formatted.action}</div>
      )}
      {secondary.length > 0 && (
        <div className="wb-exec-halt-secondary">
          <button
            type="button"
            className="wb-exec-halt-chip"
            onClick={() => setExpanded((v) => !v)}
            aria-expanded={expanded}
          >
            +{secondary.length} more{" "}
            {secondary.length === 1 ? "failure" : "failures"}
          </button>
          {expanded && (
            <ul className="wb-exec-halt-secondary-list">
              {secondary.map((reason, idx) => {
                const f = formatGraphWorkflowHaltReason(reason);
                return (
                  <li key={`${reason.type}-${idx}`}>
                    <strong>{f.headline}</strong>
                    {f.detail && <div>{f.detail}</div>}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

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
        <HaltBanner primary={haltReason} secondary={secondaryHaltReasons} />
      )}
    </div>
  );
}
