"use client";

import { useState } from "react";
import { VisuallyHidden } from "radix-ui";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/Dialog";
import { DropdownMenuItem } from "@/components/ui/DropdownMenu";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/Popover";
import type { ValidationBudgetView } from "@/lib/validation/budget-view";
import { useValidationBudgetView } from "@/lib/validation/queries";
import { createClientLogger } from "@/lib/logging/client-logger";
import { ValidationBudgetGauge } from "./ValidationBudgetGauge";
import { ValidationBudgetPanel } from "./ValidationBudgetPanel";

/**
 * Global validation-budget indicator for the topbar.
 *
 * The budget is one global ledger, so the gauge sits in the bar on every page
 * rather than in a page-supplied status slot. It disappears entirely when the
 * budget is idle (nothing running, nothing queued) — there is nothing to
 * explain, and CC's density rules drop ornament before structure.
 *
 * Mobile keeps only the ring: at ≤768px the bar has no room for the count or
 * an anchored 400px panel, so the ring stays as a glanceable signal and the
 * full detail opens as a bottom sheet from the overflow menu
 * (`ValidationBudgetMenuItem` + `ValidationBudgetSheet`, which the topbar
 * mounts outside the menu so the sheet outlives the menu's unmount).
 */

const logger = createClientLogger("validation-budget");

function accessibleSummary(view: ValidationBudgetView): string {
  return `Validation budget: ${view.headline} in use, ${view.queueDepth} queued`;
}

export function ValidationBudgetIndicator(): React.JSX.Element | null {
  const view = useValidationBudgetView();
  const [open, setOpen] = useState(false);

  if (view === null) return null;

  const changeOpen = (next: boolean): void => {
    if (next) {
      logger.info("validation_budget.panel_opened", {
        inUse: view.inUse,
        limit: view.limit,
        queueDepth: view.queueDepth,
      });
    }
    setOpen(next);
  };

  return (
    <>
      <Popover open={open} onOpenChange={changeOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label={accessibleSummary(view)}
            className="inline-flex cursor-pointer items-center gap-[7px] border-0 bg-transparent p-0 [transition:opacity_0.15s_ease] hover:opacity-80 focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:outline-offset-2 max-768:hidden"
          >
            <ValidationBudgetGauge
              fraction={view.fraction}
              tone={view.tone}
              size="compact"
              pixelSize={22}
            />
            <span className="font-mono text-[0.72rem] font-semibold text-text-primary">
              {view.inUse}
              <span className="text-text-tertiary">/{view.limit}</span>
            </span>
          </button>
        </PopoverTrigger>
        <PopoverContent
          unstyled
          align="end"
          aria-label="Validation budget detail"
          contentClassName="z-popover w-[400px] max-w-[calc(100vw-16px)] overflow-hidden rounded-md border border-solid border-border-default bg-bg-elevated text-text-primary shadow-menu outline-none origin-[var(--radix-popover-content-transform-origin)] data-[state=open]:motion-safe:animate-[fadeIn_0.12s_ease]"
        >
          <ValidationBudgetPanel view={view} />
        </PopoverContent>
      </Popover>

      {/* Mobile: the ring alone survives the bar; the action lives in the
          overflow menu, which is reachable by keyboard and touch. */}
      <span
        className="hidden items-center max-768:flex"
        role="img"
        aria-label={accessibleSummary(view)}
      >
        <ValidationBudgetGauge
          fraction={view.fraction}
          tone={view.tone}
          size="compact"
          pixelSize={20}
        />
      </span>
    </>
  );
}

/**
 * Overflow-menu row that opens the mobile sheet. Selecting it only raises the
 * request — the sheet itself is mounted by the topbar as a sibling of the
 * menu, because Radix unmounts the menu content on close and would take a
 * nested dialog down with it.
 */
export function ValidationBudgetMenuItem({
  onSelect,
}: {
  onSelect: () => void;
}): React.JSX.Element | null {
  const view = useValidationBudgetView();
  if (view === null) return null;

  return (
    <DropdownMenuItem onSelect={onSelect}>
      <span className="flex w-full items-center gap-sm">
        <ValidationBudgetGauge
          fraction={view.fraction}
          tone={view.tone}
          size="compact"
          pixelSize={18}
        />
        <span className="flex-1">Validation budget</span>
        <span className="font-mono text-[0.72rem] font-semibold text-text-primary">
          {view.compactLabel}
        </span>
      </span>
    </DropdownMenuItem>
  );
}

export function ValidationBudgetSheet({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}): React.JSX.Element | null {
  const view = useValidationBudgetView();
  if (view === null) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        unstyled
        anchor="stretch"
        contentClassName="fixed inset-x-0 bottom-0 z-overlay max-h-[85vh] overflow-y-auto rounded-t-lg border-x-0 border-b-0 border-t border-solid border-t-border-default bg-bg-surface text-text-primary shadow-menu outline-none"
      >
        {/* The panel's own header carries the visible headline, so the
            dialog's required title and description are exposed to assistive
            tech only — Radix's documented pattern for a bespoke surface. */}
        <VisuallyHidden.Root>
          <DialogTitle>Validation budget</DialogTitle>
          <DialogDescription>{accessibleSummary(view)}</DialogDescription>
        </VisuallyHidden.Root>
        {/* Grabber: the sheet is dismissed by scrim press or Escape, so this
            is an affordance cue rather than a control. */}
        <div className="flex justify-center p-sm">
          <span className="h-[4px] w-[36px] rounded-full bg-border-default" />
        </div>
        <ValidationBudgetPanel view={view} />
      </DialogContent>
    </Dialog>
  );
}
