"use client";

import { KebabIcon } from "@/components/icons";
import { WithTooltip } from "@/components/ui/WithTooltip";
import CollabPhaseSummary from "@/features/session/conversation/collab/CollabPhaseSummary";
import {
  type CollabPhaseStripPhase,
  type CollabPhaseVerdict,
} from "@/features/session/conversation/collab/collab-phase-display";

export interface CollabMobileBarProps {
  phases: CollabPhaseStripPhase[];
  verdict?: CollabPhaseVerdict;
  currentIndex: number;
  total: number;
  onPrev: () => void;
  onNext: () => void;
  /** Open the full-screen reader. Also fired by tapping the phase summary. */
  onOpenReader: () => void;
  /** Open the control sheet (phase timeline, expand/collapse, stop). */
  onOpenControls: () => void;
}

const navBtnClass =
  "inline-flex h-[36px] min-w-[36px] flex-none cursor-pointer appearance-none items-center justify-center rounded-sm border-0 bg-transparent p-0 font-mono text-[1rem] leading-none text-text-secondary transition-colors duration-150 enabled:hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-30";

// Compact stand-in for the desktop phase strip + passage controls. Summarizes
// the collaboration to one active-phase pip (or verdict chip), keeps card
// navigation one tap away, and moves the rest behind the reader / control sheet.
export default function CollabMobileBar({
  phases,
  verdict,
  currentIndex,
  total,
  onPrev,
  onNext,
  onOpenReader,
  onOpenControls,
}: CollabMobileBarProps): React.JSX.Element {
  const canPrev = currentIndex > 0;
  const canNext = currentIndex < total - 1;

  return (
    <div
      className="flex min-h-[44px] min-w-0 items-center gap-xs border-x-0 border-t-0 border-b border-solid border-border-default bg-bg-base px-xs"
      role="group"
      aria-label="Collaboration"
    >
      <button
        type="button"
        className="flex min-h-[44px] min-w-0 flex-1 cursor-pointer appearance-none items-center gap-sm rounded-sm border-0 bg-transparent px-sm py-0 text-left transition-colors duration-150 hover:bg-bg-hover"
        onClick={onOpenReader}
        aria-label="Open reading view"
      >
        <CollabPhaseSummary phases={phases} verdict={verdict} />
        <span
          className="flex-none font-mono text-[0.8rem] leading-none text-text-tertiary"
          aria-hidden="true"
        >
          ⤢
        </span>
      </button>

      {total > 0 ? (
        <div
          className="flex flex-none items-center gap-0"
          role="group"
          aria-label="Collaboration navigation"
        >
          <button
            type="button"
            className={navBtnClass}
            onClick={onPrev}
            disabled={!canPrev}
            aria-label="Previous card"
          >
            ‹
          </button>
          <span
            className="min-w-[34px] px-2xs text-center font-mono text-[0.7rem] whitespace-nowrap text-text-secondary"
            aria-label={`Card ${currentIndex + 1} of ${total}`}
          >
            {currentIndex + 1}/{total}
          </span>
          <button
            type="button"
            className={navBtnClass}
            onClick={onNext}
            disabled={!canNext}
            aria-label="Next card"
          >
            ›
          </button>
        </div>
      ) : null}

      <WithTooltip label="Collaboration controls">
        <button
          type="button"
          className="inline-flex h-[44px] w-[40px] flex-none cursor-pointer appearance-none items-center justify-center rounded-sm border-0 bg-transparent p-0 text-text-secondary transition-colors duration-150 hover:text-text-primary"
          onClick={onOpenControls}
          aria-label="Collaboration controls"
        >
          <KebabIcon size={18} />
        </button>
      </WithTooltip>
    </div>
  );
}
