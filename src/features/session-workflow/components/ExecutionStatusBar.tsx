"use client";

import { useMemo, useState } from "react";
import { cn } from "@/lib/ui/cn";
import { Spinner } from "@/components/ui/Spinner";
import type { GraphWorkflowExecution } from "@/lib/workflow-graph/schemas";
import type { ConflictDecisionInput } from "@/lib/jobs/schemas";
import { formatGraphWorkflowHaltReason } from "@/components/workflow-graph/ContextHaltCard";
import {
  collectValidationResults,
  deriveOutputSchemaHaltEvidenceByContext,
} from "@/components/workflow-graph/derive-output-schema-halt";
import type { GraphWorkflowExecutionEvent } from "@/lib/workflow-graph/event-schemas";
import HaltDetailsDialog from "./HaltDetailsDialog";

export type ExecutionControlAction = "pause" | "resume" | "abort" | "clear";

const wbBtn =
  "inline-flex items-center justify-center gap-[6px] font-medium rounded-sm cursor-pointer transition-all duration-150 border border-border-default whitespace-nowrap";
const wbBtnXs = "text-[0.7rem] py-[3px] px-[8px] h-[22px]";
const wbBtnDefault =
  "bg-bg-raised text-text-secondary hover:bg-bg-elevated hover:text-text-primary hover:border-border-strong";
const wbBtnPrimary =
  "bg-[var(--cc-cyan-a12)] text-cyan border-[var(--cyan-glow-strong)] hover:bg-[var(--cc-cyan-a20)] hover:shadow-[0_0_12px_var(--cyan-glow)]";
const wbBtnDanger =
  "bg-transparent text-red border-[var(--cc-red-a35)] hover:bg-[var(--cc-red-a08)] hover:border-[var(--cc-red-border)]";
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
  /**
   * The execution's event history. The bar itself only ever shows the halt
   * headline; the details dialog needs the recorded output-schema rejection —
   * a refused payload lives in the failure record, never on the halt reason.
   */
  events?: GraphWorkflowExecutionEvent[];
  /** Opens the halted context's Config tab from the details dialog. */
  onEditSchema?: (contextId: string) => void;
  onPause: () => void;
  onResume: (conflictGuidance?: ConflictDecisionInput[]) => void;
  onAbort: () => void;
  onClear: () => void;
  isMutating: boolean;
  /** Which control mutation is in flight, so its button shows progress. */
  pendingAction: ExecutionControlAction | null;
}

function ControlLabel({
  action,
  pendingAction,
  idleLabel,
  pendingLabel,
}: {
  action: ExecutionControlAction;
  pendingAction: ExecutionControlAction | null;
  idleLabel: string;
  pendingLabel: string;
}) {
  if (pendingAction !== action) return <>{idleLabel}</>;
  return (
    <>
      <Spinner size="sm" tone="inherit" />
      {pendingLabel}
    </>
  );
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
  events,
  onEditSchema,
  onPause,
  onResume,
  onAbort,
  onClear,
  isMutating,
  pendingAction,
}: ExecutionStatusBarProps) {
  const definition = execution.workingDefinition;
  const index = useMemo(
    () => createExecutionIndex(definition, execution),
    [definition, execution],
  );
  const [haltDetailsOpen, setHaltDetailsOpen] = useState(false);
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
  const haltHeadline = haltReason
    ? formatGraphWorkflowHaltReason(haltReason).headline
    : null;
  const outputSchemaEvidence = useMemo(
    () =>
      deriveOutputSchemaHaltEvidenceByContext({
        execution,
        haltReasons: [haltReason, ...secondaryHaltReasons],
        validationEvents: collectValidationResults(events ?? []),
      }),
    [execution, haltReason, secondaryHaltReasons, events],
  );

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

      {haltReason && haltHeadline ? (
        // One line, truncated: the bar's height never depends on the size of
        // the failure. The full output lives in the details dialog.
        <div className="flex min-w-0 flex-1 items-center gap-sm max-768:order-last max-768:basis-full">
          <span
            role="alert"
            title={haltHeadline}
            className="min-w-0 flex-1 truncate text-[0.74rem] font-medium text-red"
          >
            {haltHeadline}
            {secondaryHaltReasons.length > 0 &&
              ` (+${secondaryHaltReasons.length} more)`}
          </span>
          <button
            type="button"
            className={cn(wbBtn, wbBtnXs, wbBtnDanger, execControlBtn)}
            onClick={() => setHaltDetailsOpen(true)}
          >
            Details
          </button>
        </div>
      ) : (
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
      )}

      <div className="ml-auto flex gap-sm">
        {showPause && (
          <button
            className={cn(wbBtn, wbBtnXs, wbBtnDefault, execControlBtn)}
            onClick={onPause}
            disabled={isMutating}
            aria-busy={pendingAction === "pause" || undefined}
            type="button"
          >
            <ControlLabel
              action="pause"
              pendingAction={pendingAction}
              idleLabel="Pause"
              pendingLabel="Pausing…"
            />
          </button>
        )}
        {showResume && (
          <button
            className={cn(wbBtn, wbBtnXs, wbBtnPrimary, execControlBtn)}
            onClick={() => onResume()}
            disabled={isMutating}
            aria-busy={pendingAction === "resume" || undefined}
            type="button"
          >
            <ControlLabel
              action="resume"
              pendingAction={pendingAction}
              idleLabel="Resume"
              pendingLabel="Resuming…"
            />
          </button>
        )}
        {showAbort && (
          <button
            className={cn(wbBtn, wbBtnXs, wbBtnDefault, execControlBtn)}
            onClick={onAbort}
            disabled={isMutating}
            aria-busy={pendingAction === "abort" || undefined}
            style={{ color: "var(--red)" }}
            type="button"
          >
            <ControlLabel
              action="abort"
              pendingAction={pendingAction}
              idleLabel="Abort"
              pendingLabel="Aborting…"
            />
          </button>
        )}
        {showClear && (
          <button
            className={cn(wbBtn, wbBtnXs, wbBtnDefault, execControlBtn)}
            onClick={onClear}
            disabled={isMutating}
            aria-busy={pendingAction === "clear" || undefined}
            type="button"
          >
            <ControlLabel
              action="clear"
              pendingAction={pendingAction}
              idleLabel="Clear"
              pendingLabel="Clearing…"
            />
          </button>
        )}
      </div>

      {haltReason && (
        <HaltDetailsDialog
          open={haltDetailsOpen}
          onOpenChange={setHaltDetailsOpen}
          primary={haltReason}
          secondary={secondaryHaltReasons}
          conflictAnalysis={
            haltReason.type === "join_failure"
              ? (execution.joins[haltReason.joinId]?.conflicts?.analysis ??
                null)
              : null
          }
          canResume={showResume}
          onResume={onResume}
          isMutating={isMutating}
          isResuming={pendingAction === "resume"}
          outputSchemaEvidence={outputSchemaEvidence}
          {...(onEditSchema !== undefined ? { onEditSchema } : {})}
        />
      )}
    </div>
  );
}
