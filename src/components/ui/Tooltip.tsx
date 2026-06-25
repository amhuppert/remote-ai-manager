"use client";

import { Tooltip as RadixTooltip } from "radix-ui";
import { cn } from "@/lib/ui/cn";

// Radix-backed tooltip primitive (WAI-ARIA APG "Tooltip" pattern:
// https://www.w3.org/WAI/ARIA/apg/patterns/tooltip/). Radix owns the behaviour —
// hover + keyboard-focus reveal, Escape/blur/pointer-leave dismissal, the open
// delay, collision-aware positioning, and the `role="tooltip"` + trigger
// `aria-describedby` wiring — while these wrappers own CC appearance, porting the
// legacy global `.tooltip-portal` recipe (globals.css) to utilities. State is read
// off Radix's own `data-state` attribute (`delayed-open`/`instant-open`/`closed`)
// via Tailwind `data-*` variants. The content omits `className`/`style` so a call
// site cannot inject appearance; the only escape hatch is the layout-only
// `layoutClassName` (docs/tailwind-conventions.md §2).
//
// Unlike menus/popovers/dialogs, a tooltip is intentionally NOT registered with
// the global overlay scope (`useOverlayScope`): it never traps focus, never blocks
// the page, and the trigger keeps focus while it is shown — suppressing page
// hotkeys whenever a focus-revealed tooltip is visible would break keyboard use.
// Radix handles the tooltip's own Escape dismissal, so no overlay-stack wiring is
// needed. Tooltips are never modal.

// Ports the preserved `.tooltip-portal` appearance to utilities: raised surface,
// default border, small radius, mono caption text, muted secondary colour, at the
// tooltip z-tier so it clears every stacking context (topbar, modals). The
// entrance fade is gated with `motion-safe:` (no global reduced-motion reset to
// lean on) and anchored to Radix's side/align-aware transform origin. `max-w`
// lets genuinely long hints wrap (the legacy single-line system could not); short
// labels still render on one line.
const tooltipContentClass = cn(
  "z-tooltip max-w-[260px] rounded-sm border border-solid border-border-default bg-bg-raised px-[8px] py-[4px] font-mono text-[0.7rem] leading-[1.4] font-medium text-text-secondary",
  "origin-[var(--radix-tooltip-content-transform-origin)] data-[state=delayed-open]:motion-safe:animate-[fadeIn_0.12s_ease] data-[state=instant-open]:motion-safe:animate-[fadeIn_0.12s_ease]",
);

// ---------------------------------------------------------------------------
// Provider — one instance near the app root shares the open delay across every
// tooltip (and the skip-delay window for quickly moving between triggers). CC
// default reveal delay is 300ms; override per call site / per Root.
// ---------------------------------------------------------------------------

type TooltipProviderProps = React.ComponentProps<typeof RadixTooltip.Provider>;

export function TooltipProvider({
  delayDuration = 300,
  ...rest
}: TooltipProviderProps): React.JSX.Element {
  return <RadixTooltip.Provider delayDuration={delayDuration} {...rest} />;
}

// Structural parts carry no appearance — re-export Radix directly. `Tooltip`
// (Root) supports controlled + uncontrolled `open`; `TooltipTrigger` composes an
// existing primitive via `asChild` (Radix merges the trigger props/ref onto it).
export const Tooltip = RadixTooltip.Root;
export const TooltipTrigger = RadixTooltip.Trigger;
export const TooltipPortal = RadixTooltip.Portal;

// ---------------------------------------------------------------------------
// Content — bakes the Portal so a call site cannot forget it, and sets the CC
// offset/collision padding. `sideOffset` matches the legacy 6px gap.
// ---------------------------------------------------------------------------

type TooltipContentProps = Omit<
  React.ComponentProps<typeof RadixTooltip.Content>,
  "className" | "style"
> & {
  /** External-geometry utilities only (e.g. width); appended after appearance. */
  layoutClassName?: string;
};

export function TooltipContent({
  layoutClassName,
  sideOffset = 6,
  collisionPadding = 8,
  ...rest
}: TooltipContentProps): React.JSX.Element {
  return (
    <RadixTooltip.Portal>
      <RadixTooltip.Content
        sideOffset={sideOffset}
        collisionPadding={collisionPadding}
        {...rest}
        className={cn(tooltipContentClass, layoutClassName)}
      />
    </RadixTooltip.Portal>
  );
}
