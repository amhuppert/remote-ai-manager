"use client";

import { useCallback, useState } from "react";
import { Dialog as RadixDialog } from "radix-ui";
import { useOverlayScope } from "@/hooks/useOverlayScope";
import { cn } from "@/lib/ui/cn";
import {
  type DialogSize,
  overlayScrim,
  overlayCentering,
  overlayCenteringSheet,
  cardBase,
  cardSize,
  cardSheet,
  dialogTitle,
  dialogDescription,
  dialogActions,
} from "./dialog-recipe";

// Radix-backed modal dialog primitive (WAI-ARIA APG "Dialog (Modal)" pattern:
// https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/). Radix owns the
// behaviour — focus trap + focus return to the trigger, Escape + outside-click
// dismissal, scroll-lock, `role="dialog"`/`aria-modal`/`aria-labelledby`/
// `aria-describedby` wiring, and the inert background — while these wrappers own
// the CC appearance (shared with `AlertDialog` via `dialog-recipe.ts`). Unlike
// the menu/popover primitives this is a true blocking dialog, so Radix's default
// `modal` is kept. Parts omit `className`/`style`; the only escape hatch is the
// layout-only `layoutClassName` (docs/tailwind-conventions.md §2).

// ---------------------------------------------------------------------------
// Root — wraps Radix Root and registers the open dialog with the global overlay
// scope so page-level hotkeys are suppressed while it is open. Supports both
// controlled and uncontrolled use; the value fed to `useOverlayScope` tracks
// whichever is active. (Radix manages Escape/focus itself, so no `onEscape`.)
// ---------------------------------------------------------------------------

type DialogProps = React.ComponentProps<typeof RadixDialog.Root>;

export function Dialog({
  open,
  defaultOpen,
  onOpenChange,
  children,
  ...rest
}: DialogProps): React.JSX.Element {
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
    <RadixDialog.Root
      {...rest}
      {...(isControlled ? { open } : { defaultOpen })}
      onOpenChange={handleOpenChange}
    >
      {children}
    </RadixDialog.Root>
  );
}

// Structural parts carry no appearance — re-export Radix directly. `DialogClose`
// and `DialogTrigger` compose existing primitives via `asChild` + `<Button>`/
// `<IconButton>` (which own their own focus ring + box appearance).
export const DialogTrigger = RadixDialog.Trigger;
export const DialogClose = RadixDialog.Close;

// ---------------------------------------------------------------------------
// Content — bakes Portal + Overlay (scrim) + the centring layer + the card so a
// call site cannot forget the overlay or mis-centre the card.
// ---------------------------------------------------------------------------

type DialogContentProps = Omit<
  React.ComponentProps<typeof RadixDialog.Content>,
  "className" | "style"
> & {
  /** Card width: `default` (480px) or `confirm` (400px). */
  size?: DialogSize;
  /** Dock to a full-width bottom sheet below 768px (the legacy `.modal` sheet). */
  mobileSheet?: boolean;
  /** External-geometry utilities only; appended after appearance. */
  layoutClassName?: string;
};

export function DialogContent({
  size = "default",
  mobileSheet = false,
  layoutClassName,
  children,
  ...rest
}: DialogContentProps): React.JSX.Element {
  return (
    <RadixDialog.Portal>
      <RadixDialog.Overlay className={overlayScrim} />
      <div
        className={cn(overlayCentering, mobileSheet && overlayCenteringSheet)}
      >
        <RadixDialog.Content
          {...rest}
          className={cn(
            cardBase,
            cardSize[size],
            mobileSheet && cardSheet,
            layoutClassName,
          )}
        >
          {children}
        </RadixDialog.Content>
      </div>
    </RadixDialog.Portal>
  );
}

// ---------------------------------------------------------------------------
// Title / Description — wrap the Radix parts that drive `aria-labelledby` /
// `aria-describedby`, owning the CC heading/body recipes.
// ---------------------------------------------------------------------------

type DialogTitleProps = Omit<
  React.ComponentProps<typeof RadixDialog.Title>,
  "className" | "style"
> & {
  layoutClassName?: string;
};

export function DialogTitle({
  layoutClassName,
  ...rest
}: DialogTitleProps): React.JSX.Element {
  return (
    <RadixDialog.Title {...rest} className={cn(dialogTitle, layoutClassName)} />
  );
}

type DialogDescriptionProps = Omit<
  React.ComponentProps<typeof RadixDialog.Description>,
  "className" | "style"
> & {
  layoutClassName?: string;
};

export function DialogDescription({
  layoutClassName,
  ...rest
}: DialogDescriptionProps): React.JSX.Element {
  return (
    <RadixDialog.Description
      {...rest}
      className={cn(dialogDescription, layoutClassName)}
    />
  );
}

// ---------------------------------------------------------------------------
// Actions — layout-only right-aligned button row (the legacy `.modal-actions`).
// ---------------------------------------------------------------------------

type DialogActionsProps = Omit<
  React.HTMLAttributes<HTMLDivElement>,
  "className" | "style"
> & {
  layoutClassName?: string;
};

export function DialogActions({
  layoutClassName,
  ...rest
}: DialogActionsProps): React.JSX.Element {
  return <div {...rest} className={cn(dialogActions, layoutClassName)} />;
}
