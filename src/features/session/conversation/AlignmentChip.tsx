"use client";

import { cn } from "@/lib/ui/cn";
import type { AlignmentChipState } from "@/features/session/conversation/alignment-chip-state";

interface AlignmentChipProps {
  state: AlignmentChipState;
  /** The active charter version, or null when there is no active charter. */
  activeVersion: number | null;
  /** Invoked when the `none`-state add affordance is activated. */
  onActivate?: () => void;
  /** External-geometry utilities only; appended after appearance. */
  className?: string;
}

const LABEL = "Alignment";

// Pill shape shared by every state, mirroring the Badge primitive recipe (mono,
// 0.7rem, pill radius). State-varying appearance lives in the maps below so no
// two applied utilities target the same property on one element.
const base =
  "inline-flex shrink-0 items-center justify-center gap-[4px] rounded-full px-[8px] py-[2px] font-mono text-[0.7rem] leading-[1.3] font-semibold whitespace-nowrap";

// cyan = active charter; amber = attention (approval or incorporation pending)
// and stale (this conversation has not seen the active version yet).
const stateAppearance: Record<Exclude<AlignmentChipState, "none">, string> = {
  active: "bg-cyan-glow text-cyan",
  pending: "bg-amber-glow text-amber",
  stale: "bg-amber-glow text-amber",
};

// `none` is an add affordance: a muted ghost chip that brightens to cyan on
// hover, with the canonical cyan keyboard focus ring.
const noneAppearance =
  "cursor-pointer border border-dashed border-border-default bg-transparent text-text-secondary hover:border-cyan hover:text-cyan focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:outline-offset-2";

export default function AlignmentChip({
  state,
  activeVersion,
  onActivate,
  className,
}: AlignmentChipProps): React.JSX.Element {
  if (state === "none") {
    return (
      <button
        type="button"
        onClick={onActivate}
        data-state="none"
        className={cn(base, noneAppearance, className)}
        aria-label="Add alignment"
      >
        {LABEL}
        <span aria-hidden="true">+</span>
      </button>
    );
  }

  const version = activeVersion != null ? `v${activeVersion}` : null;

  return (
    <span
      data-state={state}
      className={cn(base, stateAppearance[state], className)}
    >
      {LABEL}
      {version && <span>{version}</span>}
      {state === "pending" && <span>update pending</span>}
      {state === "stale" && <span>stale</span>}
    </span>
  );
}
