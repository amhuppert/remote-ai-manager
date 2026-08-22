"use client";

import { useMemo, useState, type ReactNode } from "react";
import { cn } from "@/lib/ui/cn";
import { Button } from "@/components/ui/Button";
import { StatusChip } from "@/components/ui/StatusChip";
import ConfirmDialog from "@/components/ConfirmDialog";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/Dialog";
import type { GraphWorkflowExecution } from "@/lib/workflow-graph/schemas";
import type { ConflictDecisionInput } from "@/lib/jobs/schemas";
import { formatGraphWorkflowHaltReason } from "@/components/workflow-graph/ContextHaltCard";
import {
  collectValidationResults,
  deriveOutputSchemaHaltEvidenceByContext,
  outputSchemaEvidenceForReason,
} from "@/components/workflow-graph/derive-output-schema-halt";
import type { GraphWorkflowExecutionEvent } from "@/lib/workflow-graph/event-schemas";
import {
  CheckIcon,
  CloseIcon,
  PauseIcon,
} from "@/components/workflow-config-panel/icons";
import { PlayIcon, StopIcon } from "./execution-icons";
import HaltDetailsDialog from "./HaltDetailsDialog";
import { deriveJoinConflictSummary } from "@/components/workflow-graph/join-conflict-summary";
import { holdsExecutionLease } from "@/lib/workflow-graph/lifecycle-classifier";
import {
  resolveExecutionControls,
  type ExecutionControlDescriptor,
  type ExecutionControlKind,
} from "./execution-controls";
import {
  countExecutionGates,
  deriveExecutionStatusSummary,
} from "./execution-status-summary";

/** The four mutations the page can have in flight for a control. */
export type ExecutionControlAction = "pause" | "resume" | "abort" | "abandon";

const wbBtn =
  "inline-flex items-center justify-center gap-[6px] font-medium rounded-sm cursor-pointer transition-all duration-150 border border-border-default whitespace-nowrap";
const wbBtnXs = "text-[0.7rem] py-[3px] px-[8px] h-[22px]";
const wbBtnDanger =
  "bg-transparent text-red border-[var(--cc-red-a35)] hover:bg-[var(--cc-red-a08)] hover:border-[var(--cc-red-border)]";
const execControlBtn = "max-768:min-h-[44px]";

const execBadgeBase =
  "inline-flex items-center gap-[6px] text-[0.7rem] font-semibold uppercase tracking-[0.06em] py-[3px] px-[10px] rounded-[4px]";

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

const CONTROL_ICON: Partial<Record<ExecutionControlKind, ReactNode>> = {
  pause: <PauseIcon size={11} />,
  resume: <PlayIcon size={11} />,
  abort: <StopIcon size={11} />,
  "approve-definition": <CheckIcon size={11} />,
  "reject-definition": <CloseIcon size={11} />,
};

function gateLabel(count: number): string {
  return `${count} ${count === 1 ? "gate" : "gates"} awaiting you`;
}

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
  /**
   * Join-conflict recovery navigation, offered on the details dialog's join
   * card: the blocked member's runtime (its lane worktree) and its placement
   * (its owned paths). Omitted by a host with no inspector to open.
   */
  onOpenLaneWorktree?: (contextId: string) => void;
  onEditOwnership?: (contextId: string) => void;
  onPause: () => void;
  onResume: (conflictGuidance?: ConflictDecisionInput[]) => void;
  onAbort: () => void;
  onAbandon?: () => void;
  onApproveDefinition?: () => void;
  onRejectDefinition?: () => void;
  isApprovingDefinition?: boolean;
  isRejectingDefinition?: boolean;
  /** A refused definition decision, reported where the decision was made. */
  definitionApprovalError?: string | null;
  /**
   * Opens the gates list for this execution — the Overview's gates screen,
   * because there is no single global gate (README §10). Absent on a host with
   * no rail to open, where the chip states the count without offering a dead
   * control.
   */
  onOpenGates?: () => void;
  isMutating: boolean;
  /** Which control mutation is in flight, so its button shows progress. */
  pendingAction: ExecutionControlAction | null;
  /** False for History: informational status and halt details stay mounted. */
  allowActions?: boolean;
  /** Rail-collapse controls, rendered after the state controls (design E1). */
  trailingControls?: ReactNode;
  /** §12 / M2: below 768px the bar is a two-row header, not a single strip. */
  isMobile?: boolean;
  /**
   * What the M2 execution chip says — `<exec_id> · Current` or `· History`.
   * The tenure word is the rail's answer, so the page that already partitions
   * the rail supplies it rather than this bar deciding tenure a second time.
   */
  executionChipLabel?: string;
  /**
   * The Executions sheet's body, given the handle that dismisses the sheet.
   *
   * A render prop rather than a node: selecting a row has to close the sheet
   * AND return to Graph AND write the URL, and only the page owns the last two.
   * Handing it `close` lets the one row handler do all three, instead of the
   * sheet guessing that some click inside it was a selection.
   */
  renderExecutionsSheet?: (close: () => void) => ReactNode;
}

export default function ExecutionStatusBar({
  execution,
  events,
  onEditSchema,
  onOpenLaneWorktree,
  onEditOwnership,
  onPause,
  onResume,
  onAbort,
  onAbandon,
  onApproveDefinition,
  onRejectDefinition,
  isApprovingDefinition = false,
  isRejectingDefinition = false,
  definitionApprovalError = null,
  onOpenGates,
  isMutating,
  pendingAction,
  allowActions = true,
  trailingControls,
  isMobile = false,
  executionChipLabel,
  renderExecutionsSheet,
}: ExecutionStatusBarProps) {
  const [haltDetailsOpen, setHaltDetailsOpen] = useState(false);
  const [executionsSheetOpen, setExecutionsSheetOpen] = useState(false);
  const [pendingConfirm, setPendingConfirm] =
    useState<ExecutionControlDescriptor | null>(null);

  const haltReason = execution.haltReason;
  const secondaryHaltReasons = execution.secondaryHaltReasons;
  const outputSchemaEvidence = useMemo(
    () =>
      deriveOutputSchemaHaltEvidenceByContext({
        execution,
        haltReasons: [haltReason, ...secondaryHaltReasons],
        validationEvents: collectValidationResults(events ?? []),
      }),
    [execution, haltReason, secondaryHaltReasons, events],
  );

  /**
   * Resuming restarts the refused turn against the contract the context
   * declares now. While that is still, provably, the contract that refused, a
   * resume can only reproduce the refusal and spend another turn — so the page
   * withholds it everywhere rather than only on the halt card, which would make
   * the card's disabled button a claim the bar beside it contradicts.
   */
  const resumeBlockedReason = useMemo(
    () =>
      [haltReason, ...secondaryHaltReasons].some(
        (reason) =>
          reason !== null &&
          outputSchemaEvidenceForReason(outputSchemaEvidence, reason)
            ?.contractUnchangedSinceRejection === true,
      )
        ? "blocked until the contract is accepted"
        : null,
    [haltReason, secondaryHaltReasons, outputSchemaEvidence],
  );

  const controls = useMemo(
    () =>
      resolveExecutionControls({
        status: execution.status,
        haltReason: execution.haltReason,
        abandonment: execution.abandonment,
        definitionApproval: execution.definitionApproval,
        allowActions,
        canAbandon: onAbandon !== undefined,
        canDecideDefinition:
          onApproveDefinition !== undefined && onRejectDefinition !== undefined,
        resumeBlockedReason,
      }),
    [
      execution.status,
      execution.haltReason,
      execution.abandonment,
      execution.definitionApproval,
      allowActions,
      onAbandon,
      onApproveDefinition,
      onRejectDefinition,
      resumeBlockedReason,
    ],
  );

  // A confirmation survives only while the state still offers the control it
  // belongs to. Current becoming History, or a run settling under a standing
  // prompt, must not leave an accept button for an act the matrix withdrew.
  const confirming =
    pendingConfirm !== null &&
    controls.some((control) => control.kind === pendingConfirm.kind)
      ? pendingConfirm
      : null;

  const summary = useMemo(
    () => deriveExecutionStatusSummary(execution),
    [execution],
  );
  const gateCount = useMemo(
    () => (allowActions ? countExecutionGates(execution) : 0),
    [execution, allowActions],
  );

  const haltHeadline = haltReason
    ? formatGraphWorkflowHaltReason(haltReason).headline
    : null;

  // The status question alone. Whether a resume may be TAKEN is
  // `resumeBlockedReason`, handed to the dialog beside this: a halt the
  // operator cannot resume yet is the one they most need to read, and its
  // join-recovery diagnosis and lane navigations are not resuming acts.
  const canResumeFromDialog =
    allowActions &&
    holdsExecutionLease(
      execution.status,
      execution.haltReason,
      execution.abandonment,
    ) &&
    (execution.status === "paused" || execution.status === "halted");

  function runControl(kind: ExecutionControlKind): void {
    switch (kind) {
      case "pause":
        return onPause();
      case "resume":
        return onResume();
      case "abort":
        return onAbort();
      case "abandon":
        return onAbandon?.();
      case "approve-definition":
        return onApproveDefinition?.();
      case "reject-definition":
        return onRejectDefinition?.();
    }
  }

  function isPending(kind: ExecutionControlKind): boolean {
    if (kind === "approve-definition") return isApprovingDefinition;
    if (kind === "reject-definition") return isRejectingDefinition;
    return pendingAction === kind;
  }

  function runFromSheet(control: ExecutionControlDescriptor): void {
    // The sheet is the way to these controls, not their home: it steps aside
    // for the confirmation rather than sitting behind it, and an unconfirmed
    // act leaves the operator on the graph it changed.
    setExecutionsSheetOpen(false);
    if (control.confirm !== null) setPendingConfirm(control);
    else runControl(control.kind);
  }

  const stateChip = (
    <span
      data-testid="execution-state-chip"
      className={cn(
        execBadgeBase,
        "shrink-0",
        execBadgeByStatus[execution.status] ??
          "border border-border-default bg-bg-raised text-text-tertiary",
      )}
    >
      {execution.status === "running" && (
        <span
          aria-hidden="true"
          data-testid="execution-state-dot"
          className="h-[6px] w-[6px] shrink-0 [animation:pulse-dot_2.4s_ease-in-out_infinite] rounded-full bg-cyan shadow-[0_0_8px_var(--color-cyan-glow)] motion-reduce:[animation:none]"
        />
      )}
      {execution.status}
    </span>
  );

  function renderControl(
    control: ExecutionControlDescriptor,
    onActivate: (control: ExecutionControlDescriptor) => void,
    layoutClassName?: string,
  ) {
    const pending = isPending(control.kind);
    return (
      <Button
        key={control.kind}
        size="sm"
        touch
        variant={control.variant}
        loading={pending}
        disabled={isMutating || control.blockedReason !== null}
        onClick={() => onActivate(control)}
        {...(layoutClassName === undefined ? {} : { layoutClassName })}
      >
        {pending ? (
          control.pendingLabel
        ) : (
          <>
            {CONTROL_ICON[control.kind]}
            {control.idleLabel}
          </>
        )}
      </Button>
    );
  }

  function activateFromBar(control: ExecutionControlDescriptor): void {
    if (control.confirm !== null) setPendingConfirm(control);
    else runControl(control.kind);
  }

  const haltRow =
    haltReason !== null && haltHeadline !== null ? (
      // One line, truncated: the bar's height never depends on the size of the
      // failure. The full output lives in the details dialog.
      <div
        className={cn(
          "flex min-w-0 items-center gap-sm",
          isMobile ? "w-full" : "flex-1 max-768:order-last max-768:basis-full",
        )}
      >
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
    ) : null;

  const approvalErrorRow =
    definitionApprovalError !== null ? (
      <span
        role="alert"
        title={definitionApprovalError}
        className="min-w-0 shrink truncate text-[0.72rem] font-medium text-red"
      >
        {definitionApprovalError}
      </span>
    ) : null;

  const dialogs = (
    <>
      {confirming !== null && confirming.confirm !== null && (
        <ConfirmDialog
          open
          title={confirming.confirm.title}
          message={confirming.confirm.message}
          confirmLabel={confirming.confirm.confirmLabel}
          danger
          onConfirm={() => {
            const kind = confirming.kind;
            setPendingConfirm(null);
            runControl(kind);
          }}
          onCancel={() => setPendingConfirm(null)}
        />
      )}

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
          canResume={canResumeFromDialog}
          resumeBlockedReason={resumeBlockedReason}
          onResume={onResume}
          isMutating={isMutating}
          isResuming={pendingAction === "resume"}
          outputSchemaEvidence={outputSchemaEvidence}
          joinConflict={deriveJoinConflictSummary(execution, haltReason)}
          {...(allowActions && onEditSchema !== undefined
            ? { onEditSchema }
            : {})}
          {...(allowActions && onOpenLaneWorktree !== undefined
            ? { onOpenLaneWorktree }
            : {})}
          {...(allowActions && onEditOwnership !== undefined
            ? { onEditOwnership }
            : {})}
        />
      )}
    </>
  );

  if (isMobile) {
    // M2: the header carries the state, the run it belongs to, and the ONE
    // control that state is about. Everything else the matrix admits is a row
    // in the sheet — the header is a strip on a phone, and a second control in
    // it is the one that gets pressed by accident.
    const [primaryControl, ...sheetControls] = controls;
    const sheetOpenable =
      executionChipLabel !== undefined && renderExecutionsSheet !== undefined;

    return (
      <div className="flex flex-col border-b border-border-dim bg-bg-surface">
        <div className="flex min-h-[44px] items-center gap-sm px-md py-2">
          {stateChip}
          {sheetOpenable && (
            <button
              type="button"
              data-testid="execution-chip"
              aria-haspopup="dialog"
              aria-expanded={executionsSheetOpen}
              onClick={() => setExecutionsSheetOpen(true)}
              className="inline-flex min-h-[44px] min-w-0 shrink cursor-pointer items-center gap-[6px] rounded-[4px] border border-solid border-border-default bg-bg-raised px-[10px] py-[3px] font-mono text-[0.7rem] font-medium text-text-secondary transition-colors duration-150 hover:border-border-strong hover:text-text-primary focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:[outline-offset:2px]"
            >
              <span className="truncate">{executionChipLabel}</span>
            </button>
          )}
          {primaryControl !== undefined && (
            <div className="ml-auto flex shrink-0 items-center">
              {renderControl(primaryControl, activateFromBar)}
            </div>
          )}
        </div>

        {/* §12: the gates strip is its own row under the header, so the count
            is readable at a phone width instead of competing with the state
            chip for the same line. */}
        {gateCount > 0 &&
          (onOpenGates ? (
            <button
              type="button"
              onClick={onOpenGates}
              className="flex min-h-[44px] w-full cursor-pointer items-center gap-sm border-x-0 border-t border-b-0 border-solid border-t-[var(--cc-amber-a30)] bg-[var(--cc-amber-a12)] px-md py-[6px] text-left font-mono text-[0.72rem] font-semibold text-amber focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:[outline-offset:-2px]"
            >
              {gateLabel(gateCount)}
            </button>
          ) : (
            <div className="flex min-h-[44px] w-full items-center gap-sm border-x-0 border-t border-b-0 border-solid border-t-[var(--cc-amber-a30)] bg-[var(--cc-amber-a12)] px-md py-[6px] font-mono text-[0.72rem] font-semibold text-amber">
              {gateLabel(gateCount)}
            </div>
          ))}

        {(haltRow !== null || approvalErrorRow !== null) && (
          <div className="flex flex-col gap-xs px-md pb-2">
            {haltRow}
            {approvalErrorRow}
          </div>
        )}

        {sheetOpenable && (
          <Dialog
            open={executionsSheetOpen}
            onOpenChange={setExecutionsSheetOpen}
          >
            <DialogContent mobileSheet="full-height" size="wide">
              <DialogTitle>Executions</DialogTitle>
              <div className="flex min-h-0 flex-col gap-lg">
                {renderExecutionsSheet(() => setExecutionsSheetOpen(false))}
                {sheetControls.length > 0 && (
                  <section
                    aria-label="Execution actions"
                    className="flex shrink-0 flex-col gap-sm border-x-0 border-t border-b-0 border-solid border-border-dim pt-md"
                  >
                    <h3 className="m-0 font-mono text-[0.7rem] font-bold tracking-[0.08em] text-text-tertiary uppercase">
                      Actions
                    </h3>
                    <div className="flex flex-col gap-sm">
                      {sheetControls.map((control) =>
                        renderControl(control, runFromSheet, "w-full"),
                      )}
                    </div>
                  </section>
                )}
              </div>
            </DialogContent>
          </Dialog>
        )}

        {dialogs}
      </div>
    );
  }

  return (
    <div className="flex min-h-[44px] items-center gap-md border-b border-border-dim bg-bg-surface px-md py-2 max-768:flex-wrap max-768:gap-sm">
      {stateChip}

      {haltRow ?? (
        <p
          data-testid="execution-status-summary"
          className="m-0 min-w-0 flex-1 truncate text-[0.74rem] text-text-secondary max-768:hidden"
        >
          {summary.map((part, index) =>
            part.emphasis ? (
              <strong
                key={`${part.text}-${index}`}
                className="font-semibold text-text-primary"
              >
                {part.text}
              </strong>
            ) : (
              <span key={`${part.text}-${index}`}>{part.text}</span>
            ),
          )}
        </p>
      )}

      {approvalErrorRow}

      {gateCount > 0 &&
        // A control only once it has somewhere to go: a host without a rail
        // states the count rather than offering a dead button.
        (onOpenGates ? (
          <StatusChip
            as="button"
            tone="amber"
            onClick={onOpenGates}
            layoutClassName="shrink-0"
          >
            {gateLabel(gateCount)}
          </StatusChip>
        ) : (
          <StatusChip tone="amber" layoutClassName="shrink-0">
            {gateLabel(gateCount)}
          </StatusChip>
        ))}

      <div className="ml-auto flex items-center gap-sm">
        {controls.map((control) => renderControl(control, activateFromBar))}
        {trailingControls !== undefined && controls.length > 0 && (
          <span
            aria-hidden="true"
            className="h-[18px] w-px shrink-0 bg-border-default"
          />
        )}
        {trailingControls}
      </div>

      {dialogs}
    </div>
  );
}
