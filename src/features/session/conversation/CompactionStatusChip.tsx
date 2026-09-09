"use client";

import { Spinner } from "@/components/ui/Spinner";
import {
  StatusChip,
  type StatusChipAppearance,
  type StatusChipTone,
} from "@/components/ui/StatusChip";
import {
  compactionChipLabel,
  type CompactionChipState,
} from "@/components/conversation/compaction-chip-state";

interface CompactionStatusChipProps {
  state: CompactionChipState;
  /** Opens the context-artifact panel. */
  onOpen?: () => void;
  /** External-geometry utilities only; appended after appearance. */
  className?: string;
}

// none is a dashed ghost affordance (no artifact yet — reads inert until
// hovered); pending = cyan (running), fresh = green, stale/outdated = amber
// (needs refresh), failed = red. The non-none states are borderless flat
// accents so the chip reads as a filled status, not a bordered pill.
const stateTone: Record<CompactionChipState["kind"], StatusChipTone> = {
  none: "neutral",
  pending: "cyan",
  fresh: "green",
  stale: "amber",
  outdated: "amber",
  failed: "red",
};

const stateAppearance: Record<
  CompactionChipState["kind"],
  StatusChipAppearance
> = {
  none: "ghost",
  pending: "flat",
  fresh: "flat",
  stale: "flat",
  outdated: "flat",
  failed: "flat",
};

/**
 * Per-conversation compaction status chip (design §12.2): `No compact ·
 * Compacting… · Fresh · Stale (behind N) · Outdated · Failed`. Always a
 * button — activating it opens the context-artifact panel.
 */
export default function CompactionStatusChip({
  state,
  onOpen,
  className,
}: CompactionStatusChipProps): React.JSX.Element {
  const label = compactionChipLabel(state);
  return (
    <StatusChip
      as="button"
      tone={stateTone[state.kind]}
      appearance={stateAppearance[state.kind]}
      onClick={onOpen}
      data-state={state.kind}
      layoutClassName={className}
      aria-label={`Context artifact: ${label}`}
      title="View context artifact"
      icon={
        state.kind === "pending" ? <Spinner size="sm" tone="inherit" /> : null
      }
    >
      {label}
    </StatusChip>
  );
}
