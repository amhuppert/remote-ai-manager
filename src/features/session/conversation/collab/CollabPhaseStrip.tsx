"use client";

import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/ui/cn";
import {
  isStopAvailable,
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

export interface CollabPhaseStripProps {
  phases: CollabPhaseStripPhase[];
  verdict?: CollabPhaseVerdict;
  compact?: boolean;
  onStop?: () => void;
}

export default function CollabPhaseStrip({
  phases,
  verdict,
  compact,
  onStop,
}: CollabPhaseStripProps): React.JSX.Element {
  const stopAvailable = isStopAvailable(phases);

  return (
    <div
      className={cn(
        "flex min-w-0 items-center gap-md border border-solid border-border-subtle bg-bg-base",
        compact ? "rounded-sm px-sm py-[6px]" : "rounded-md px-md py-sm",
      )}
      data-compact={compact ? "true" : "false"}
      data-verdict={verdict ?? "none"}
      role="group"
      aria-label="Collaboration phase progress"
    >
      <ol className="m-0 flex min-w-0 flex-1 [scroll-snap-type:x_proximity] list-none items-center gap-sm overflow-x-auto p-0 max-768:[-webkit-overflow-scrolling:touch]">
        {phases.map((phase, idx) => {
          const label = phaseLabel(phase.kind);
          const dataKind = phaseDataKind(phase.kind);
          const tone = pipTone(dataKind, phase.status);
          return (
            <li
              key={`${dataKind}-${label}-${idx}`}
              className={cn(
                "inline-flex flex-none [scroll-snap-align:center] items-center gap-[6px] font-mono text-[0.72rem] font-semibold tracking-[0.06em] uppercase max-768:min-h-[var(--touch-target-min)] max-768:min-w-[var(--touch-target-min)] max-768:justify-center max-768:px-xs",
                pipTextColor[tone],
              )}
              data-kind={dataKind}
              data-status={phase.status}
              aria-current={phase.status === "active" ? "step" : undefined}
            >
              <span
                className={cn(
                  "inline-block h-[10px] w-[10px] rounded-full border border-solid",
                  pipDotTone[tone],
                )}
                aria-hidden="true"
              />
              <span>{label}</span>
            </li>
          );
        })}
        {verdict ? (
          <li
            className={cn(
              "inline-flex flex-none items-center gap-[6px] rounded-sm px-[8px] py-[2px] font-mono text-[0.72rem] font-bold tracking-[0.06em] uppercase",
              verdictColor[verdict],
            )}
            data-verdict={verdict}
            aria-label={VERDICT_LABEL[verdict]}
          >
            <span aria-hidden="true">{VERDICT_GLYPH[verdict]}</span>
            <span>{VERDICT_LABEL[verdict]}</span>
          </li>
        ) : null}
      </ol>

      {stopAvailable && onStop ? (
        <Button
          variant="danger"
          size="sm"
          touch
          layoutClassName="shrink-0 grow-0 basis-auto max-768:min-w-[var(--touch-target-min)]"
          onClick={onStop}
          aria-label="Stop collaboration"
        >
          Stop
        </Button>
      ) : null}
    </div>
  );
}
