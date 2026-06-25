"use client";

import { useCallback, useState } from "react";
import { Popover as RadixPopover } from "radix-ui";
import { useOverlayScope } from "@/hooks/useOverlayScope";
import { cn } from "@/lib/ui/cn";

// Radix-backed non-modal floating panel primitive. APG has no standalone
// "popover" pattern — a Popover composes Dialog/Disclosure semantics: a trigger
// with `aria-expanded`/`aria-controls` toggles an anchored `role=dialog` panel
// that does NOT block the page (no scrim, no scroll-lock, focus is not trapped).
// See the WAI-ARIA APG pattern index:
// https://www.w3.org/WAI/ARIA/apg/patterns/ (Dialog (Modal) + Disclosure).
//
// Radix owns the behaviour — collision-aware positioning, outside-click and
// Escape dismissal, focus management (focus moves into the panel on open and
// returns to the trigger on close), and the `role`/`aria-*` wiring. These
// wrappers own only CC appearance (the canonical elevated floating surface) plus
// the cross-cutting plumbing every CC overlay needs: a baked-in Portal, the
// `z-popover` tier, side offset + collision padding, a motion-safe entry
// animation, and `useOverlayScope` registration so page-level hotkeys stay
// suppressed while the panel is open. Parts omit `className`/`style`; the only
// escape hatch is the layout-only `layoutClassName` (docs/tailwind-conventions.md
// §2), appended last for external geometry (width/placement), never appearance.

// Canonical CC floating panel: elevated card + menu drop shadow (the shared CC
// overlay surface, matching DropdownMenu/Select), capped to Radix's collision-
// computed available height with the transform anchored to the side/align-aware
// origin. `outline-none` because the panel itself is not a focus target (its
// interactive children carry their own focus rings). `data-state=open` plays the
// restrained CC fade (motion-safe); Radix unmounts on close (no exit animation).
const contentClass = cn(
  "z-popover max-h-[var(--radix-popover-content-available-height)] overflow-y-auto rounded-md border border-solid border-border-default bg-bg-elevated p-3 text-text-primary shadow-menu outline-none",
  "origin-[var(--radix-popover-content-transform-origin)] data-[state=open]:motion-safe:animate-[fadeIn_0.12s_ease]",
);

// ---------------------------------------------------------------------------
// Root — wraps Radix Root and registers the open panel with the global overlay
// scope so page-level hotkeys are suppressed while it is open. Supports both
// controlled and uncontrolled use; the open value fed to `useOverlayScope`
// tracks whichever is active.
// ---------------------------------------------------------------------------

type PopoverProps = React.ComponentProps<typeof RadixPopover.Root>;

export function Popover({
  open,
  defaultOpen,
  onOpenChange,
  // Non-modal by default: a popover is a lightweight anchored panel, not a
  // blocking dialog. Modal mode locks page scroll and `aria-hidden`s the rest of
  // the page (including the focusable trigger → axe `aria-hidden-focus`);
  // non-modal avoids both and matches CC's floating panels. Radix still handles
  // Escape, outside-click, and focus return. Pass `modal` to override.
  modal = false,
  children,
  ...rest
}: PopoverProps): React.JSX.Element {
  const isControlled = open !== undefined;
  const [uncontrolledOpen, setUncontrolledOpen] = useState(
    defaultOpen ?? false,
  );
  const currentOpen = isControlled ? open : uncontrolledOpen;
  useOverlayScope(currentOpen);

  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (!isControlled) setUncontrolledOpen(next);
      onOpenChange?.(next);
    },
    [isControlled, onOpenChange],
  );

  return (
    <RadixPopover.Root
      {...rest}
      modal={modal}
      {...(isControlled ? { open } : { defaultOpen })}
      onOpenChange={handleOpenChange}
    >
      {children}
    </RadixPopover.Root>
  );
}

// Structural parts carry no appearance — re-export Radix directly. `Trigger`
// composes existing primitives via `asChild` + `<Button>`/`<IconButton>`;
// `Anchor` positions the panel against an element other than the trigger;
// `Close` dismisses the panel (consumers wrap it `asChild` around their own
// control, or use the bare element below).
export const PopoverTrigger = RadixPopover.Trigger;
export const PopoverAnchor = RadixPopover.Anchor;
export const PopoverClose = RadixPopover.Close;

// ---------------------------------------------------------------------------
// Content — bakes the Portal, surface, z-tier, side offset, and collision
// padding so a call site cannot forget them.
// ---------------------------------------------------------------------------

type PopoverContentProps = Omit<
  React.ComponentProps<typeof RadixPopover.Content>,
  "className" | "style"
> & {
  /** External-geometry utilities only (e.g. width); appended after appearance. */
  layoutClassName?: string;
};

export function PopoverContent({
  layoutClassName,
  sideOffset = 6,
  collisionPadding = 8,
  ...rest
}: PopoverContentProps): React.JSX.Element {
  return (
    <RadixPopover.Portal>
      <RadixPopover.Content
        sideOffset={sideOffset}
        collisionPadding={collisionPadding}
        {...rest}
        className={cn(contentClass, layoutClassName)}
      />
    </RadixPopover.Portal>
  );
}

// ---------------------------------------------------------------------------
// Arrow — optional pointer connecting the panel to its trigger. Tinted to the
// panel surface so it reads as part of the floating card.
// ---------------------------------------------------------------------------

type PopoverArrowProps = Omit<
  React.ComponentProps<typeof RadixPopover.Arrow>,
  "className" | "style"
> & {
  layoutClassName?: string;
};

export function PopoverArrow({
  layoutClassName,
  ...rest
}: PopoverArrowProps): React.JSX.Element {
  return (
    <RadixPopover.Arrow
      {...rest}
      className={cn("fill-bg-elevated", layoutClassName)}
    />
  );
}
