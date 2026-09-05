"use client";

import { useState, useCallback } from "react";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/Dialog";
import { CloseIcon } from "@/components/icons";
import { IconButton } from "@/components/ui/IconButton";
import TddToggle from "@/components/TddToggle";
import { cn } from "@/lib/ui/cn";
import { Button } from "@/components/ui/Button";
import { createClientLogger } from "@/lib/logging/client-logger";

const log = createClientLogger("mobile-action-menu");

interface MobileActionMenuProps {
  triggerLabel?: string;
  panelActions?: { label: string; active: boolean; onSelect: () => void }[];
  onRebase?: () => void;
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
  triggerLabel,
  panelActions,
  onRebase,
}: MobileActionMenuProps): React.JSX.Element {
  const [open, setOpen] = useState(false);

  const handleClose = useCallback(() => setOpen(false), []);

  const handleAction = useCallback((action: () => void, label: string) => {
    setOpen(false);
    log.debug("action.selected", { action: label });
    action();
  }, []);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <button
          className="hidden focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:outline-offset-2 max-768:flex max-768:min-h-[44px] max-768:min-w-[44px] max-768:shrink-0 max-768:cursor-pointer max-768:items-center max-768:justify-center max-768:gap-xs max-768:rounded-sm max-768:border max-768:border-solid max-768:border-border-subtle max-768:bg-transparent max-768:px-sm max-768:font-mono max-768:text-[0.7rem] max-768:text-text-primary max-768:hover:bg-bg-hover"
          aria-label="Session actions"
          aria-expanded={open}
          type="button"
        >
          {triggerLabel ?? "More"} <span aria-hidden="true">&#8943;</span>
        </button>
      </DialogTrigger>

      {/* The bottom bar's backdrop filter can make fixed descendants relative
          to the bar instead of the viewport, so the overlay escapes to body. */}
      <DialogContent
        unstyled
        anchor="stretch"
        aria-describedby={undefined}
        data-open="true"
        contentClassName={cn(
          "fixed right-0 bottom-0 left-0 z-[201] max-h-[85dvh] overflow-y-auto overscroll-contain rounded-t-lg rounded-b-none border-x-0 border-t border-b-0 border-solid border-border-default bg-bg-surface p-md pb-[calc(var(--space-lg)_+_env(safe-area-inset-bottom,0))] motion-safe:animate-[slideUpSheet_0.25s_ease]",
          "flex flex-col gap-sm",
        )}
      >
        <div className="flex items-start justify-between gap-sm">
          <DialogTitle>Session actions</DialogTitle>
          <IconButton
            size="touch"
            aria-label="Close menu"
            onClick={handleClose}
          >
            <CloseIcon />
          </IconButton>
        </div>
        {/* Settings section */}
        {panelActions && (
          <div
            className="grid grid-cols-2 gap-sm"
            aria-label="Conversation panels"
          >
            {panelActions.map((panel) => (
              <Button
                key={panel.label}
                touch
                aria-pressed={panel.active}
                onClick={() => handleAction(panel.onSelect, panel.label)}
              >
                {panel.label}
              </Button>
            ))}
          </div>
        )}
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
              onClick={() => handleAction(onDevServers, "dev-servers")}
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
          {panelActions && (
            <Button
              touch
              disabled={!onRebase}
              onClick={() => onRebase && handleAction(onRebase, "rebase")}
            >
              Rebase session
            </Button>
          )}
        </div>

        <div className="my-xs h-px bg-border-subtle" />

        {/* Danger zone */}
        <div className="flex flex-col gap-[2px]">
          <button
            className="flex min-h-[44px] w-full cursor-pointer items-center gap-sm rounded-sm border-none bg-transparent p-sm text-left font-mono text-[0.8rem] text-red-text transition-[background] duration-100 ease-[ease] hover:bg-red-glow"
            onClick={() => handleAction(onDelete, "delete-session")}
            type="button"
          >
            <span className="w-[20px] shrink-0 text-center text-[0.9rem]">
              {"\u2715"}
            </span>
            <span className="flex-1">Delete session</span>
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
