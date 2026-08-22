"use client";

import { useRef, useState } from "react";
import ConfirmDialog from "@/components/ConfirmDialog";
import {
  AlertTriangleIcon,
  GearIcon,
  KebabIcon,
  LayoutIcon,
  PlusIcon,
  TrashIcon,
  UndoIcon,
} from "@/components/icons";
import { cn } from "@/lib/ui/cn";

const WB_BTN_BASE =
  "inline-flex items-center justify-center gap-[6px] whitespace-nowrap cursor-pointer rounded-sm border border-solid border-border-default font-medium transition-all duration-150 disabled:cursor-not-allowed disabled:opacity-45 focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:[outline-offset:2px]";
const WB_BTN_SM = "h-[28px] px-[12px] py-[5px] text-[0.72rem]";
const WB_BTN_DEFAULT =
  "bg-bg-raised text-text-secondary hover:bg-bg-elevated hover:border-border-strong hover:text-text-primary";
const WB_BTN_PRIMARY =
  "bg-[var(--cc-cyan-a12)] text-cyan border-[var(--cyan-glow-strong)] hover:bg-[var(--cc-cyan-a20)] hover:shadow-[0_0_12px_var(--cyan-glow)]";
const WB_BTN_DANGER =
  "bg-bg-raised text-red border-[var(--cc-red-a25)] hover:bg-[var(--cc-red-a10)]";

const MENU_ITEM_BASE =
  "flex min-h-[44px] items-center gap-[8px] rounded-[3px] border-0 bg-transparent px-[12px] py-[8px] text-left font-mono text-[0.72rem] text-text-secondary cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:[outline-offset:-2px]";
const MENU_ITEM_CLASS = cn(
  MENU_ITEM_BASE,
  "hover:bg-bg-elevated hover:text-text-primary",
);

// §12: the name is the toolbar's own rename control, so below the breakpoint it
// has to clear the 44px touch minimum like every other target on the page.
const WB_HEADER_NAME =
  "min-w-[120px] max-w-[300px] -mx-[6px] -my-[3px] rounded-sm border border-solid border-transparent bg-transparent px-[6px] py-[3px] font-[inherit] text-[0.88rem] font-semibold text-text-primary outline-none transition-all duration-150 hover:border-border-default hover:bg-bg-base focus:border-cyan focus:bg-bg-base focus:shadow-[0_0_0_1px_var(--cyan-glow)] max-768:min-h-[44px]";

const VALIDATION_SAVE_TITLE = "Fix the validation errors before saving";
const SCHEMA_SAVE_TITLE = "The output schema is not accepted by the engine";

interface WorkflowToolbarProps {
  workflowName: string;
  revision: number | null;
  onRename: (name: string) => void;
  onDelete: () => void;
  onAddContext: () => void;
  /**
   * Draw an empty lane on the canvas. It is client-only draft UI (README §2.2),
   * so unlike every other action here it changes nothing about the definition
   * and the save status keeps reading "All changes saved".
   */
  onNewLane: () => void;
  onSave: () => void;
  onReset: () => void;
  onRelayout: () => void;
  onOpenWorkflowSettings?: () => void;
  dirty: boolean;
  saving: boolean;
  /** True while the delete-definition mutation is in flight. */
  deleting?: boolean;
  hasValidationErrors: boolean;
  /**
   * The draft holds editor text no commit could accept (today: an output schema
   * outside the engine's supported subset). Saving would persist the last valid
   * value under fresh red text, so the action is refused rather than silently
   * dropping the edit.
   */
  saveBlocked?: boolean;
  isMobile?: boolean;
}

export default function WorkflowToolbar({
  workflowName,
  revision,
  onRename,
  onDelete,
  onAddContext,
  onNewLane,
  onSave,
  onReset,
  onRelayout,
  onOpenWorkflowSettings,
  dirty,
  saving,
  deleting = false,
  hasValidationErrors,
  saveBlocked = false,
  isMobile,
}: WorkflowToolbarProps) {
  // Save is refused for two different reasons and the button has to say which:
  // an unacceptable schema text the store never saw, or errors the validator
  // raised. Both leave the draft dirty, so the disabled state alone is mute.
  const saveTitle = saveBlocked
    ? SCHEMA_SAVE_TITLE
    : hasValidationErrors
      ? VALIDATION_SAVE_TITLE
      : undefined;
  const saveDisabled = !dirty || saving || saveBlocked || hasValidationErrors;
  const [editingName, setEditingName] = useState(false);
  const [nameValue, setNameValue] = useState(workflowName);
  const [overflowOpen, setOverflowOpen] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  function handleNameClick() {
    setNameValue(workflowName);
    setEditingName(true);
    requestAnimationFrame(() => inputRef.current?.select());
  }

  function commitRename() {
    const trimmed = nameValue.trim();
    if (trimmed.length > 0 && trimmed !== workflowName) {
      onRename(trimmed);
    } else {
      setNameValue(workflowName);
    }
    setEditingName(false);
  }

  function cancelRename() {
    setNameValue(workflowName);
    setEditingName(false);
  }

  const nameElement = editingName ? (
    <input
      ref={inputRef}
      className={cn(
        WB_HEADER_NAME,
        isMobile && "overflow-hidden text-ellipsis whitespace-nowrap",
      )}
      value={nameValue}
      aria-label="Workflow name"
      onChange={(e) => setNameValue(e.target.value)}
      onBlur={commitRename}
      onKeyDown={(e) => {
        if (e.key === "Enter") commitRename();
        if (e.key === "Escape") cancelRename();
      }}
      type="text"
    />
  ) : (
    <button
      className={cn(
        WB_HEADER_NAME,
        "cursor-text",
        isMobile && "overflow-hidden text-ellipsis whitespace-nowrap",
      )}
      onClick={handleNameClick}
      type="button"
      title="Click to rename"
    >
      {workflowName}
    </button>
  );

  const statusElement = (
    <div className="ml-auto flex flex-shrink-0 items-center gap-[6px] text-[0.72rem] font-medium">
      {hasValidationErrors ? (
        <>
          <span
            data-testid="workflow-save-status-alert"
            className="flex flex-shrink-0 text-red"
          >
            <AlertTriangleIcon size={12} />
          </span>
          <span className="text-red">Validation errors</span>
        </>
      ) : dirty ? (
        <>
          <span
            data-testid="workflow-save-status-dot"
            className="h-[6px] w-[6px] rounded-full bg-amber shadow-[0_0_6px_var(--amber-glow)]"
          />
          <span className="text-text-secondary">Unsaved changes</span>
        </>
      ) : (
        <>
          <span
            data-testid="workflow-save-status-dot"
            className="h-[6px] w-[6px] rounded-full bg-green shadow-[0_0_6px_var(--green-glow)]"
          />
          <span className="text-text-secondary">All changes saved</span>
        </>
      )}
    </div>
  );

  const deleteConfirmDialog = (
    <ConfirmDialog
      open={confirmingDelete}
      title="Delete workflow"
      message={`Delete "${workflowName}"? Its saved definition and every revision of it are removed. This cannot be undone.`}
      confirmLabel="Delete workflow"
      danger
      onConfirm={() => {
        setConfirmingDelete(false);
        onDelete();
      }}
      onCancel={() => setConfirmingDelete(false)}
    />
  );

  if (isMobile) {
    return (
      <div className="z-10 flex min-h-[44px] flex-col items-center gap-[6px] border-b border-solid border-border-dim bg-bg-surface px-md py-[8px]">
        <div className="flex min-w-0 items-center gap-sm">
          <div className="flex min-w-0 flex-1 items-center gap-[10px]">
            {nameElement}
            {revision != null && (
              <span className="flex-shrink-0 rounded-[3px] bg-bg-raised px-[8px] py-[2px] text-[0.7rem] font-medium whitespace-nowrap text-text-tertiary">
                r{revision}
              </span>
            )}
          </div>
          {statusElement}
        </div>
        <div className="flex items-center gap-xs">
          <button
            className={cn(
              WB_BTN_BASE,
              WB_BTN_SM,
              WB_BTN_DEFAULT,
              "max-768:min-h-[44px]",
            )}
            onClick={onAddContext}
            type="button"
          >
            <PlusIcon size={11} />
            Add Context
          </button>
          <button
            className={cn(
              WB_BTN_BASE,
              WB_BTN_SM,
              WB_BTN_PRIMARY,
              "max-768:min-h-[44px]",
            )}
            onClick={onSave}
            disabled={saveDisabled}
            title={saveTitle}
            type="button"
          >
            {saving ? "Saving..." : "Save"}
          </button>
          <div className="relative">
            <button
              className={cn(
                WB_BTN_BASE,
                WB_BTN_SM,
                WB_BTN_DEFAULT,
                "max-768:min-h-[44px] max-768:min-w-[44px]",
              )}
              onClick={() => setOverflowOpen((v) => !v)}
              type="button"
              aria-label="More workflow actions"
              aria-expanded={overflowOpen}
            >
              <KebabIcon size={14} />
            </button>
            {overflowOpen && (
              <div className="absolute top-[calc(100%+4px)] right-0 z-50 flex min-w-[160px] flex-col rounded-md border border-solid border-border-default bg-bg-raised p-[4px]">
                <button
                  className={MENU_ITEM_CLASS}
                  onClick={() => {
                    onNewLane();
                    setOverflowOpen(false);
                  }}
                  type="button"
                >
                  <PlusIcon size={12} />
                  New Lane
                </button>
                <button
                  className={MENU_ITEM_CLASS}
                  onClick={() => {
                    onReset();
                    setOverflowOpen(false);
                  }}
                  disabled={!dirty}
                  type="button"
                >
                  <UndoIcon size={12} />
                  Reset
                </button>
                <button
                  className={MENU_ITEM_CLASS}
                  onClick={() => {
                    onRelayout();
                    setOverflowOpen(false);
                  }}
                  type="button"
                >
                  <LayoutIcon size={12} />
                  Re-layout
                </button>
                {onOpenWorkflowSettings && (
                  <button
                    className={MENU_ITEM_CLASS}
                    onClick={() => {
                      onOpenWorkflowSettings();
                      setOverflowOpen(false);
                    }}
                    type="button"
                  >
                    <GearIcon size={12} />
                    Workflow settings
                  </button>
                )}
                <button
                  className={cn(
                    MENU_ITEM_BASE,
                    "text-red hover:bg-[var(--cc-red-a08)] hover:text-red",
                  )}
                  onClick={() => {
                    setOverflowOpen(false);
                    setConfirmingDelete(true);
                  }}
                  disabled={deleting}
                  aria-busy={deleting || undefined}
                  type="button"
                >
                  <TrashIcon size={12} />
                  {deleting ? "Deleting…" : "Delete"}
                </button>
              </div>
            )}
          </div>
        </div>
        {deleteConfirmDialog}
      </div>
    );
  }

  return (
    <div className="z-10 flex min-h-[44px] items-center gap-sm border-b border-solid border-border-dim bg-bg-surface px-md py-[8px]">
      <div className="flex min-w-0 flex-shrink items-center gap-[10px]">
        {nameElement}
        {revision != null && (
          <span className="flex-shrink-0 rounded-[3px] bg-bg-raised px-[8px] py-[2px] text-[0.7rem] font-medium whitespace-nowrap text-text-tertiary">
            r{revision}
          </span>
        )}
      </div>

      <div className="mx-xs h-[20px] w-px flex-shrink-0 bg-border-default" />

      <div className="flex items-center gap-sm">
        <button
          className={cn(WB_BTN_BASE, WB_BTN_SM, WB_BTN_DEFAULT)}
          onClick={onAddContext}
          type="button"
        >
          <PlusIcon size={11} />
          Add Context
        </button>
        <button
          className={cn(WB_BTN_BASE, WB_BTN_SM, WB_BTN_DEFAULT)}
          onClick={onNewLane}
          type="button"
          title="Draw an empty lane — nothing is saved until a context lands in it"
        >
          <PlusIcon size={11} />
          New Lane
        </button>
        <button
          className={cn(WB_BTN_BASE, WB_BTN_SM, WB_BTN_PRIMARY)}
          onClick={onSave}
          disabled={saveDisabled}
          title={saveTitle}
          type="button"
        >
          {saving ? "Saving..." : "Save Draft"}
        </button>
        <button
          className={cn(WB_BTN_BASE, WB_BTN_SM, WB_BTN_DEFAULT)}
          onClick={onReset}
          disabled={!dirty}
          type="button"
        >
          <UndoIcon size={11} />
          Reset
        </button>
        <button
          className={cn(WB_BTN_BASE, WB_BTN_SM, WB_BTN_DEFAULT)}
          onClick={onRelayout}
          type="button"
        >
          <LayoutIcon size={11} />
          Re-layout
        </button>
        {onOpenWorkflowSettings && (
          <button
            className={cn(WB_BTN_BASE, WB_BTN_SM, WB_BTN_DEFAULT)}
            onClick={onOpenWorkflowSettings}
            type="button"
            title="Workflow settings"
          >
            <GearIcon size={11} />
            Workflow settings
          </button>
        )}
      </div>

      {statusElement}

      <div className="mx-xs h-[20px] w-px flex-shrink-0 bg-border-default" />

      <button
        className={cn(WB_BTN_BASE, WB_BTN_SM, WB_BTN_DANGER)}
        onClick={() => setConfirmingDelete(true)}
        disabled={deleting}
        aria-busy={deleting || undefined}
        type="button"
      >
        <TrashIcon size={11} />
        {deleting ? "Deleting…" : "Delete"}
      </button>
      {deleteConfirmDialog}
    </div>
  );
}
