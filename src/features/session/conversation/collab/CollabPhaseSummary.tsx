"use client";

import { cn } from "@/lib/ui/cn";
import {
  activePhase,
  phaseDataKind,
  phaseLabel,
  pipDotTone,
  pipTextColor,
  pipTone,
  verdictColor,
  VERDICT_GLYPH,
  VERDICT_LABEL,
  type CollabPhaseStripPhase,
  type CollabPhaseVerdict,
} from "@/features/session/conversation/collab/collab-phase-display";

export interface CollabPhaseSummaryProps {
  phases: CollabPhaseStripPhase[];
  verdict?: CollabPhaseVerdict;
}

// One-glance collaboration state shared by the compact mobile bar and the
// reader top bar: the terminal verdict chip when present, otherwise the active
// phase pip.
export default function CollabPhaseSummary({
  phases,
  verdict,
}: CollabPhaseSummaryProps): React.JSX.Element | null {
  if (verdict) {
    return (
      <span
        className={cn(
          "inline-flex flex-none items-center gap-[6px] rounded-sm px-[8px] py-[2px] font-mono text-[0.72rem] font-bold tracking-[0.06em] uppercase",
          verdictColor[verdict],
        )}
        data-verdict={verdict}
      >
        <span aria-hidden="true">{VERDICT_GLYPH[verdict]}</span>
        <span>{VERDICT_LABEL[verdict]}</span>
      </span>
    );
  }

  const active = activePhase(phases);
  if (!active) return null;
  const tone = pipTone(phaseDataKind(active.kind), active.status);

  return (
    <span
      className={cn(
        "inline-flex min-w-0 items-center gap-[6px] font-mono text-[0.72rem] font-semibold tracking-[0.06em] uppercase",
        pipTextColor[tone],
      )}
      data-kind={phaseDataKind(active.kind)}
      data-status={active.status}
    >
      <span
        className={cn(
          "inline-block h-[10px] w-[10px] flex-none rounded-full border border-solid",
          pipDotTone[tone],
        )}
        aria-hidden="true"
      />
      <span className="overflow-hidden text-ellipsis whitespace-nowrap">
        {phaseLabel(active.kind)}
      </span>
    </span>
  );
}
