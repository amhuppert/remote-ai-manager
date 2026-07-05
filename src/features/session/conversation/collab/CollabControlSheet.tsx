"use client";

import { useEffect } from "react";
import { createPortal } from "react-dom";
import { CloseIcon, StopIcon } from "@/components/icons";
import { cn } from "@/lib/ui/cn";
import {
  isStopAvailable,
  phaseDataKind,
  phaseLabel,
  pipDotTone,
  pipTextColor,
  pipTone,
  type CollabPhaseStripPhase,
  type CollabPhaseVerdict,
} from "@/features/session/conversation/collab/collab-phase-display";

export interface CollabControlSheetProps {
  phases: CollabPhaseStripPhase[];
  verdict?: CollabPhaseVerdict;
  onExpandAll: () => void;
  onCollapseAll: () => void;
  /** Stop the run. Rendered only while the collaboration is still in flight. */
  onStop?: () => void;
  onClose: () => void;
}

const rowClass =
  "flex w-full min-h-[52px] cursor-pointer appearance-none items-center gap-sm rounded-sm border-0 bg-transparent px-sm py-0 text-left font-mono text-[0.85rem] text-text-primary transition-[background] duration-100 hover:bg-bg-hover";

const STATUS_LABEL: Record<CollabPhaseStripPhase["status"], string> = {
  done: "done",
  active: "active",
  pending: "pending",
};

// Secondary controls for the mobile collaboration surface: the full phase
// timeline (which the compact bar reduces to one pip), expand/collapse-all, and
// the stop action. Portaled to the document body so it escapes the transformed
// docked stage (see docked-stage-transform-breaks-fixed).
export default function CollabControlSheet({
  phases,
  verdict,
  onExpandAll,
  onCollapseAll,
  onStop,
  onClose,
}: CollabControlSheetProps): React.JSX.Element | null {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onClose]);

  if (typeof document === "undefined") return null;

  const stopVisible = onStop != null && isStopAvailable(phases);

  return createPortal(
    <div
      className="fixed inset-0 z-tooltip flex flex-col justify-end"
      role="dialog"
      aria-modal="true"
      aria-label="Collaboration controls"
    >
      <button
        type="button"
        className="absolute inset-0 animate-[fadeIn_0.15s_ease] cursor-default appearance-none border-0 bg-[var(--cc-bg-void-a70)] [backdrop-filter:blur(4px)]"
        aria-label="Close controls"
        onClick={onClose}
      />
      <div className="relative flex max-h-[70vh] animate-[slideUpSheet_0.25s_ease] flex-col gap-sm overflow-y-auto rounded-t-lg border-x-0 border-t border-b-0 border-solid border-border-default bg-bg-surface px-md pt-md pb-[calc(var(--spacing-lg)+env(safe-area-inset-bottom,0px))]">
        <div className="relative mb-xs flex shrink-0 items-center justify-center">
          <div className="h-[4px] w-[36px] shrink-0 rounded-[2px] bg-border-default" />
          <button
            type="button"
            className="absolute top-1/2 right-0 flex h-[32px] w-[32px] -translate-y-1/2 cursor-pointer items-center justify-center rounded-sm border-0 bg-transparent text-text-tertiary transition-colors duration-150 hover:bg-bg-hover hover:text-text-primary"
            onClick={onClose}
            aria-label="Close controls"
          >
            <CloseIcon size={16} />
          </button>
        </div>

        <div className="flex flex-col gap-[2px]">
          <div className="px-sm py-xs font-mono text-[0.7rem] font-semibold tracking-[0.08em] text-text-tertiary uppercase">
            Collaboration
          </div>
          <ol className="m-0 flex list-none flex-col gap-0 p-0">
            {phases.map((phase, idx) => {
              const dataKind = phaseDataKind(phase.kind);
              const tone = pipTone(dataKind, phase.status);
              return (
                <li
                  key={`${dataKind}-${idx}`}
                  className="flex min-h-[40px] items-center gap-sm px-sm"
                  data-kind={dataKind}
                  data-status={phase.status}
                  aria-current={phase.status === "active" ? "step" : undefined}
                >
                  <span
                    className={cn(
                      "inline-block h-[10px] w-[10px] flex-none rounded-full border border-solid",
                      pipDotTone[tone],
                    )}
                    aria-hidden="true"
                  />
                  <span
                    className={cn(
                      "flex-1 font-mono text-[0.8rem] font-semibold tracking-[0.04em] uppercase",
                      pipTextColor[tone],
                    )}
                  >
                    {phaseLabel(phase.kind)}
                  </span>
                  <span className="flex-none font-mono text-[0.68rem] tracking-[0.06em] text-text-tertiary uppercase">
                    {STATUS_LABEL[phase.status]}
                  </span>
                </li>
              );
            })}
            {verdict ? (
              <li className="flex min-h-[40px] items-center gap-sm px-sm">
                <span className="inline-block h-[10px] w-[10px] flex-none" />
                <span className="flex-1 font-mono text-[0.68rem] tracking-[0.06em] text-text-tertiary uppercase">
                  Outcome
                </span>
                <span
                  className={cn(
                    "flex-none rounded-sm px-[8px] py-[2px] font-mono text-[0.68rem] font-bold tracking-[0.06em] uppercase",
                    verdict === "converged" && "bg-green-glow text-green",
                    verdict === "ask_user" && "bg-amber-glow text-amber",
                    verdict === "failed" && "bg-red-glow text-red",
                    verdict === "user_stopped" &&
                      "bg-bg-raised text-text-secondary",
                  )}
                >
                  {verdict === "converged"
                    ? "converged"
                    : verdict === "ask_user"
                      ? "awaiting Alex"
                      : verdict === "failed"
                        ? "failed"
                        : "stopped"}
                </span>
              </li>
            ) : null}
          </ol>
        </div>

        <div className="h-px bg-border-subtle" />

        <div className="flex flex-col gap-[2px]">
          <button
            type="button"
            className={rowClass}
            onClick={() => {
              onExpandAll();
              onClose();
            }}
          >
            <span
              className="w-[20px] flex-none text-center text-[0.9rem] text-text-tertiary"
              aria-hidden="true"
            >
              ▾
            </span>
            <span className="flex-1">Expand all cards</span>
          </button>
          <button
            type="button"
            className={rowClass}
            onClick={() => {
              onCollapseAll();
              onClose();
            }}
          >
            <span
              className="w-[20px] flex-none text-center text-[0.9rem] text-text-tertiary"
              aria-hidden="true"
            >
              ▸
            </span>
            <span className="flex-1">Collapse all cards</span>
          </button>
        </div>

        {stopVisible ? (
          <>
            <div className="h-px bg-border-subtle" />
            <button
              type="button"
              className={cn(rowClass, "text-red hover:bg-red-glow")}
              onClick={() => {
                onStop?.();
                onClose();
              }}
            >
              <span className="flex w-[20px] flex-none items-center justify-center">
                <StopIcon size={13} />
              </span>
              <span className="flex-1">Stop collaboration</span>
            </button>
          </>
        ) : null}
      </div>
    </div>,
    document.body,
  );
}
