"use client";

import { cn } from "@/lib/ui/cn";
import { Spinner } from "@/components/ui/Spinner";
import {
  compactionChipLabel,
  type CompactionChipState,
} from "./compaction-chip-state";

interface CompactionStatusChipProps {
  state: CompactionChipState;
  /** Opens the context-artifact panel. */
  onOpen?: () => void;
  /** External-geometry utilities only; appended after appearance. */
  className?: string;
}

// Pill shape shared by every state, mirroring AlignmentChip's recipe (mono,
// 0.7rem, pill radius). State-varying appearance lives in the map below so no
// two applied utilities target the same property on one element.
const base =
  "inline-flex shrink-0 cursor-pointer items-center justify-center gap-[4px] rounded-full px-[8px] py-[2px] font-mono text-[0.7rem] leading-[1.3] font-semibold whitespace-nowrap transition-colors duration-150 ease-[ease] focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:outline-offset-2";

// none is a muted ghost affordance; pending = cyan (running), fresh = green,
// stale/outdated = amber (needs refresh), failed = red.
const stateAppearance: Record<CompactionChipState["kind"], string> = {
  none: "border border-dashed border-border-default bg-transparent text-text-secondary hover:border-cyan hover:text-cyan",
  pending: "border-0 bg-cyan-glow text-cyan",
  fresh: "border-0 bg-green-glow text-green",
  stale: "border-0 bg-amber-glow text-amber",
  outdated: "border-0 bg-amber-glow text-amber",
  failed: "border-0 bg-red-glow text-red",
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
    <button
      type="button"
      onClick={onOpen}
      data-state={state.kind}
      className={cn(base, stateAppearance[state.kind], className)}
      aria-label={`Context artifact: ${label}`}
      title="View context artifact"
    >
      {state.kind === "pending" && <Spinner size="sm" tone="inherit" />}
      {label}
    </button>
  );
}
