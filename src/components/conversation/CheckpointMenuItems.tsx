"use client";

import { DropdownMenuItem } from "@/components/ui/DropdownMenu";
import { cn } from "@/lib/ui/cn";

import {
  checkpointChipLabel,
  type CheckpointActionState,
  type CheckpointChipState,
} from "./checkpoint-action-state";

const GLYPH_CLASS =
  "inline-flex size-[22px] shrink-0 items-center justify-center rounded-sm font-mono text-[0.8rem]";
const BODY_CLASS = "flex min-w-0 flex-1 flex-col gap-px";
const LABEL_CLASS = "text-[0.82rem] font-medium";
const DESC_CLASS = "font-mono text-[0.64rem] text-text-tertiary";

export interface CheckpointMenuItemsProps {
  chip: CheckpointChipState;
  action: CheckpointActionState;
  /** Starts an ordinary checkpoint. */
  onCompactContextNow?: () => void;
  /** Opens the checkpoint panel — the receipt, evidence, and recovery. */
  onViewCheckpoint?: () => void;
}

/**
 * The description under **Compact context now**: either the invitation, or the
 * exact reason the server would refuse right now. It is rendered as visible
 * text rather than only as a tooltip, so the reason reaches a screen reader
 * that lands on the disabled item.
 */
function actionDescription(action: CheckpointActionState): string {
  switch (action.kind) {
    case "loading":
      return "Checking whether a checkpoint can start…";
    case "available":
      return "Retire this context and hand the next message a frozen summary";
    case "in_progress":
      return action.phase === null
        ? action.reason
        : `${action.reason} (${action.phase})`;
    case "disabled":
    case "unsupported":
    case "recovery":
    case "queue_review":
      return action.reason;
  }
}

/**
 * The checkpoint items both conversation hosts put in their actions menu,
 * rendered as a fragment so each host keeps its own menu.
 *
 * **Compact context now** is a distinct action from **Generate compaction
 * artifact**: one retires the provider context, the other writes a reading
 * artifact and changes nothing about continuity. They are never collapsed into
 * one item.
 *
 * A conversation that is only temporarily ineligible shows the specific reason
 * and stays disabled; one that is owned, archived, transient, or on a backend
 * without checkpoint support is disabled too — waiting will not change it, so
 * offering an executable control would promise something the server will always
 * refuse.
 */
export default function CheckpointMenuItems({
  chip,
  action,
  onCompactContextNow,
  onViewCheckpoint,
}: CheckpointMenuItemsProps): React.JSX.Element {
  const startable = action.kind === "available";
  return (
    <>
      <DropdownMenuItem
        onSelect={startable ? onCompactContextNow : undefined}
        disabled={!startable || onCompactContextNow === undefined}
        data-checkpoint-action={action.kind}
      >
        <span
          className={cn(GLYPH_CLASS, "bg-bg-hover text-text-tertiary")}
          aria-hidden="true"
        >
          {"⌁"}
        </span>
        <span className={BODY_CLASS}>
          <span className={LABEL_CLASS}>Compact context now</span>
          <span className={DESC_CLASS}>{actionDescription(action)}</span>
        </span>
      </DropdownMenuItem>
      <DropdownMenuItem
        onSelect={onViewCheckpoint}
        disabled={onViewCheckpoint === undefined}
        data-checkpoint-view=""
      >
        <span
          className={cn(GLYPH_CLASS, "bg-bg-hover text-text-tertiary")}
          aria-hidden="true"
        >
          {"◆"}
        </span>
        <span className={BODY_CLASS}>
          <span className={LABEL_CLASS}>View context checkpoint</span>
          <span className={DESC_CLASS}>
            {chip.kind === "none"
              ? "No checkpoint saved yet"
              : `${checkpointChipLabel(chip)} — receipt, evidence, and recovery`}
          </span>
        </span>
      </DropdownMenuItem>
    </>
  );
}
