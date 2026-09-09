"use client";

import { Spinner } from "@/components/ui/Spinner";
import {
  StatusChip,
  type StatusChipAppearance,
  type StatusChipTone,
} from "@/components/ui/StatusChip";

import {
  checkpointChipIsBusy,
  checkpointChipLabel,
  checkpointPhaseHeadline,
  type CheckpointChipState,
} from "./checkpoint-action-state";

interface CheckpointStatusChipProps {
  state: CheckpointChipState;
  /** Opens the checkpoint panel. */
  onOpen?: () => void;
  /** External-geometry utilities only; appended after appearance. */
  className?: string;
}

// none is a dashed ghost affordance (nothing saved yet); the in-flight phases
// are cyan; a ready or applied checkpoint is green; a reconciliation gate is
// amber because it needs a decision; a failure is red; a cancelled operation
// is neutral because nothing is wrong and nothing is pending.
const stateTone: Record<CheckpointChipState["kind"], StatusChipTone> = {
  none: "neutral",
  building: "cyan",
  retiring: "cyan",
  ready: "green",
  delivering: "cyan",
  applied: "green",
  failed: "red",
  cancelled: "neutral",
  needs_reconciliation: "amber",
};

const stateAppearance: Record<
  CheckpointChipState["kind"],
  StatusChipAppearance
> = {
  none: "ghost",
  building: "flat",
  retiring: "flat",
  ready: "flat",
  delivering: "flat",
  applied: "flat",
  failed: "flat",
  cancelled: "flat",
  needs_reconciliation: "flat",
};

/**
 * Per-conversation checkpoint status chip. Always a button — activating it
 * opens the checkpoint panel, which is the only place the saved evidence and
 * the recovery actions live.
 *
 * The accessible name is the full phase sentence rather than the short label,
 * so `Checkpoint ready` is announced as what it actually means: the seed is
 * frozen and the NEXT message will carry it. Readiness is not acceptance.
 */
export default function CheckpointStatusChip({
  state,
  onOpen,
  className,
}: CheckpointStatusChipProps): React.JSX.Element {
  const busy = checkpointChipIsBusy(state);
  return (
    <StatusChip
      as="button"
      tone={stateTone[state.kind]}
      appearance={stateAppearance[state.kind]}
      onClick={onOpen}
      data-state={state.kind}
      layoutClassName={className}
      aria-label={`Context checkpoint: ${checkpointPhaseHeadline(state)}`}
      title="View context checkpoint"
      icon={busy ? <Spinner size="sm" tone="inherit" /> : null}
    >
      {checkpointChipLabel(state)}
    </StatusChip>
  );
}
