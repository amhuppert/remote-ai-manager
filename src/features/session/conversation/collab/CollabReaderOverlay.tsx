"use client";

import { type ReactNode } from "react";
import { CloseIcon, KebabIcon } from "@/components/icons";
import { Dialog, DialogContent } from "@/components/ui/Dialog";
import { WithTooltip } from "@/components/ui/WithTooltip";
import CollabPhaseSummary from "@/features/session/conversation/collab/CollabPhaseSummary";
import type {
  CollabPhaseStripPhase,
  CollabPhaseVerdict,
} from "@/features/session/conversation/collab/collab-phase-display";

export interface CollabReaderOverlayProps {
  phases: CollabPhaseStripPhase[];
  verdict?: CollabPhaseVerdict;
  currentIndex: number;
  total: number;
  onPrev: () => void;
  onNext: () => void;
  onOpenControls: () => void;
  onClose: () => void;
  /** The collaboration timeline (cards) to read at full height. */
  children: ReactNode;
}

const navBtnClass =
  "inline-flex h-[36px] min-w-[36px] flex-none cursor-pointer appearance-none items-center justify-center rounded-sm border-0 bg-transparent p-0 font-mono text-[1.05rem] leading-none text-text-secondary transition-colors duration-150 enabled:hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-30";

// Immersive full-screen reader for a collaboration exchange. Strips the app
// chrome (topbar, tab strip, composer, bottom bar) down to a slim control bar so
// the agents' outputs own the whole viewport. Composes the `ui/Dialog` unstyled/
// edge-anchored variant: Radix portals it to the body (escaping the transformed
// docked stage — docked-stage-transform-breaks-fixed), owns the focus trap +
// scroll-lock + Escape/outside-press dismissal, and the opaque full-viewport card
// covers the app; the scrim is invisible behind it.
export default function CollabReaderOverlay({
  phases,
  verdict,
  currentIndex,
  total,
  onPrev,
  onNext,
  onOpenControls,
  onClose,
  children,
}: CollabReaderOverlayProps): React.JSX.Element {
  const canPrev = currentIndex > 0;
  const canNext = currentIndex < total - 1;

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent
        unstyled
        anchor="stretch"
        scrimClassName="fixed inset-0 z-dropdown bg-bg-void"
        contentClassName="fixed inset-0 flex motion-safe:animate-[fadeIn_0.15s_ease] flex-col bg-bg-void outline-none"
        aria-label="Collaboration reading view"
      >
        <div className="flex min-h-[48px] flex-none items-center gap-xs border-x-0 border-t-0 border-b border-solid border-border-default bg-bg-base px-xs pt-[env(safe-area-inset-top,0px)]">
          <WithTooltip label="Close">
            <button
              type="button"
              className="inline-flex h-[44px] w-[44px] flex-none cursor-pointer appearance-none items-center justify-center rounded-sm border-0 bg-transparent p-0 text-text-secondary transition-colors duration-150 hover:bg-bg-hover hover:text-text-primary"
              onClick={onClose}
              aria-label="Close reading view"
            >
              <CloseIcon size={18} />
            </button>
          </WithTooltip>

          <div className="flex min-w-0 flex-1 items-center">
            <CollabPhaseSummary phases={phases} verdict={verdict} />
          </div>

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
                className="min-w-[34px] px-2xs text-center font-mono text-[0.72rem] whitespace-nowrap text-text-secondary"
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

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-sm py-md pb-[calc(var(--spacing-xl)+env(safe-area-inset-bottom,0px))]">
          <div className="mx-auto max-w-[720px] min-w-0">{children}</div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
