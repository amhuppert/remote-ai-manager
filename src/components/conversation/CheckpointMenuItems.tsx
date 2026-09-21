"use client";

import { DropdownMenuItem } from "@/components/ui/DropdownMenu";
import { CheckpointIcon, CompactIcon, HandoffIcon } from "@/components/icons";
import { MenuItemIcon, MenuItemText } from "@/components/ui/MenuItemContent";

import {
  checkpointChipLabel,
  type CheckpointActionState,
  type CheckpointChipState,
} from "./checkpoint-action-state";

export interface CheckpointMenuItemsProps {
  chip: CheckpointChipState;
  action: CheckpointActionState;
  /** Starts an ordinary checkpoint. */
  onCompactContextNow?: () => void;
  onPrepareHandoff?: () => void;
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
  onPrepareHandoff,
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
        <MenuItemIcon>
          <CompactIcon />
        </MenuItemIcon>
        <MenuItemText description={actionDescription(action)}>
          Compact context now
        </MenuItemText>
      </DropdownMenuItem>
      <DropdownMenuItem
        onSelect={startable ? onPrepareHandoff : undefined}
        disabled={!startable || onPrepareHandoff === undefined}
      >
        <MenuItemIcon>
          <HandoffIcon />
        </MenuItemIcon>
        <MenuItemText description="Review capture mode and limits before starting">
          Compact with agent handoff…
        </MenuItemText>
      </DropdownMenuItem>
      <DropdownMenuItem
        onSelect={onViewCheckpoint}
        disabled={onViewCheckpoint === undefined}
        data-checkpoint-view=""
      >
        <MenuItemIcon>
          <CheckpointIcon />
        </MenuItemIcon>
        <MenuItemText
          description={
            chip.kind === "none"
              ? "No checkpoint saved yet"
              : `${checkpointChipLabel(chip)} — receipt, evidence, and recovery`
          }
        >
          View context checkpoint
        </MenuItemText>
      </DropdownMenuItem>
    </>
  );
}
