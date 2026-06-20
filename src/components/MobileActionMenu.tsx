"use client";

import { useState, useCallback, useEffect } from "react";
import TddToggle from "@/components/TddToggle";
import { useOverlayScope } from "@/hooks/useOverlayScope";
import { cn } from "@/lib/ui/cn";

interface MobileActionMenuProps {
  /** Whether TDD mode is enabled */
  tddEnabled: boolean;
  /** Callback for TDD toggle */
  onTddToggle: (enabled: boolean) => void;
  /** Whether TDD toggle is disabled */
  tddDisabled?: boolean;
  /** Delete handler */
  onDelete: () => void;
  /** Dev servers: count of running / total */
  devServerCounts?: { running: number; total: number };
  /** Handler to open dev server drawer */
  onDevServers?: () => void;
}

export default function MobileActionMenu({
  tddEnabled,
  onTddToggle,
  tddDisabled = false,
  onDelete,
  devServerCounts,
  onDevServers,
}: MobileActionMenuProps): React.JSX.Element {
  const [open, setOpen] = useState(false);

  const handleClose = useCallback(() => setOpen(false), []);

  const handleAction = useCallback((action: () => void) => {
    setOpen(false);
    action();
  }, []);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [open]);

  useOverlayScope(open);

  return (
    <>
      <button
        className="hidden max-768:flex max-768:h-[36px] max-768:w-[36px] max-768:shrink-0 max-768:cursor-pointer max-768:items-center max-768:justify-center max-768:rounded-sm max-768:border max-768:border-solid max-768:border-border-subtle max-768:bg-transparent max-768:p-0 max-768:text-[1.1rem] max-768:leading-none max-768:tracking-[2px] max-768:text-text-secondary max-768:transition-all max-768:duration-150 max-768:ease-[ease] max-768:hover:border-border-default max-768:hover:bg-bg-hover max-768:hover:text-text-primary"
        onClick={() => setOpen(true)}
        aria-label="Session actions"
        type="button"
      >
        &#8943;
      </button>

      {/* Backdrop keeps the shared `.mobile-action-backdrop` rule: its scrim color
          (rgba(6,9,15,0.7)) has no Tailwind-scale or existing token, and the rule
          is cross-owned with MobilePromptToolbar, so it stays in CSS until that
          owner migrates (consumer-gated). */}
      <div
        className={cn("mobile-action-backdrop", open && "visible")}
        onClick={handleClose}
      />

      {/* Action sheet */}
      <div
        data-open={open}
        className={cn(
          "fixed right-0 bottom-0 left-0 z-[201] max-h-[70vh] animate-[slideUpSheet_0.25s_ease] overflow-y-auto rounded-t-lg rounded-b-none border-x-0 border-t border-b-0 border-solid border-border-default bg-bg-surface p-md pb-[calc(var(--space-lg)_+_env(safe-area-inset-bottom,0))]",
          open ? "flex flex-col gap-sm" : "hidden",
        )}
      >
        <div className="relative mb-xs flex shrink-0 items-center justify-center">
          <div className="h-[4px] w-[36px] shrink-0 rounded-[2px] bg-border-default" />
          <button
            className="absolute top-1/2 right-0 flex h-[32px] w-[32px] -translate-y-1/2 cursor-pointer items-center justify-center rounded-sm border-none bg-transparent text-[1rem] text-text-tertiary transition-all duration-150 ease-[ease] hover:bg-bg-hover hover:text-text-primary"
            onClick={handleClose}
            aria-label="Close menu"
            type="button"
          >
            {"\u2715"}
          </button>
        </div>

        {/* Settings section */}
        <div className="flex flex-col gap-[2px]">
          <div className="px-sm py-xs font-mono text-[0.7rem] font-semibold tracking-[0.08em] text-text-tertiary uppercase">
            Settings
          </div>
          {/* `mobile-action-tdd-row` is a bare hook (no backing rule) for
              TddToggle's `[.mobile-action-tdd-row_&]:` parent-variant overrides;
              the container box styling is reproduced by the utilities here. */}
          <div className="mobile-action-tdd-row flex min-h-[44px] items-center gap-sm px-sm py-xs">
            <TddToggle
              enabled={tddEnabled}
              onChange={onTddToggle}
              disabled={tddDisabled}
            />
          </div>
          {onDevServers && (
            <button
              className="flex min-h-[44px] w-full cursor-pointer items-center gap-sm rounded-sm border-none bg-transparent p-sm text-left font-mono text-[0.8rem] text-text-primary transition-[background] duration-100 ease-[ease] hover:bg-bg-hover"
              onClick={() => handleAction(onDevServers)}
              type="button"
            >
              <span className="w-[20px] shrink-0 text-center text-[0.9rem]">
                {"\u2630"}
              </span>
              <span className="flex-1">Dev Servers</span>
              {devServerCounts && devServerCounts.total > 0 && (
                <span className="shrink-0 text-[0.7rem] text-text-tertiary">
                  {devServerCounts.running}/{devServerCounts.total}
                </span>
              )}
            </button>
          )}
        </div>

        <div className="my-xs h-px bg-border-subtle" />

        {/* Danger zone */}
        <div className="flex flex-col gap-[2px]">
          <button
            className="flex min-h-[44px] w-full cursor-pointer items-center gap-sm rounded-sm border-none bg-transparent p-sm text-left font-mono text-[0.8rem] text-red-text transition-[background] duration-100 ease-[ease] hover:bg-red-glow"
            onClick={() => handleAction(onDelete)}
            type="button"
          >
            <span className="w-[20px] shrink-0 text-center text-[0.9rem]">
              {"\u2715"}
            </span>
            <span className="flex-1">Delete session</span>
          </button>
        </div>
      </div>
    </>
  );
}
