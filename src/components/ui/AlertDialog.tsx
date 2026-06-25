"use client";

import { useCallback, useState } from "react";
import { AlertDialog as RadixAlertDialog } from "radix-ui";
import { Button, type ButtonProps } from "./Button";
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

// Radix-backed confirmation/destructive prompt primitive (WAI-ARIA APG "Alert
// Dialog" pattern: https://www.w3.org/WAI/ARIA/apg/patterns/alertdialog/). Radix
// owns the behaviour — `role="alertdialog"`, focus trap + return, the default
// focus landing on the *cancel* action (the safe choice for destructive
// prompts), Escape dismissal, scroll-lock, and `aria-modal`/`aria-labelledby`/
// `aria-describedby` wiring — while these wrappers own CC appearance (shared with
// `Dialog` via `dialog-recipe.ts`). `AlertDialogContent` adds an open-focus
// fallback so the acknowledge-only (`hideCancel`) and all-actions-disabled states
// still land focus inside the modal (Radix only focuses the registered Cancel).
// AlertDialog is always modal. Parts omit
// `className`/`style`; the only escape hatch is the layout-only `layoutClassName`
// (docs/tailwind-conventions.md §2).

// ---------------------------------------------------------------------------
// Root — wraps Radix Root and registers the open dialog with the global overlay
// scope (controlled + uncontrolled). Radix manages Escape/focus, so no
// `onEscape` is wired.
// ---------------------------------------------------------------------------

type AlertDialogProps = React.ComponentProps<typeof RadixAlertDialog.Root>;

export function AlertDialog({
  open,
  defaultOpen,
  onOpenChange,
  children,
  ...rest
}: AlertDialogProps): React.JSX.Element {
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
    <RadixAlertDialog.Root
      {...rest}
      {...(isControlled ? { open } : { defaultOpen })}
      onOpenChange={handleOpenChange}
    >
      {children}
    </RadixAlertDialog.Root>
  );
}

// Structural part carries no appearance — re-export Radix directly.
export const AlertDialogTrigger = RadixAlertDialog.Trigger;

// Marks the Cancel control so `AlertDialogContent`'s open-focus fallback can tell
// whether Radix's default target (the registered Cancel) is present and enabled.
const CANCEL_ATTR = "data-cc-alert-cancel";

// Tabbable controls inside the card, for the no-enabled-cancel focus fallback.
const FOCUSABLE_SELECTOR =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

// ---------------------------------------------------------------------------
// Content — bakes Portal + Overlay (scrim) + the centring layer + the card.
// Defaults to the confirm width and the mobile bottom-sheet (the ConfirmDialog /
// BulkConfirmModal shape).
// ---------------------------------------------------------------------------

type AlertDialogContentProps = Omit<
  React.ComponentProps<typeof RadixAlertDialog.Content>,
  "className" | "style"
> & {
  /** Card width: `confirm` (400px, default) or `default` (480px). */
  size?: DialogSize;
  /** Dock to a full-width bottom sheet below 768px (default true). */
  mobileSheet?: boolean;
  /** External-geometry utilities only; appended after appearance. */
  layoutClassName?: string;
};

export function AlertDialogContent({
  size = "confirm",
  mobileSheet = true,
  layoutClassName,
  onOpenAutoFocus,
  children,
  ...rest
}: AlertDialogContentProps): React.JSX.Element {
  // Radix focuses the registered Cancel on open (the safe choice for destructive
  // prompts), preventing default — but when there is no *enabled* Cancel
  // (`hideCancel` acknowledge-only, or every action disabled) its focus call is a
  // no-op and focus would stay outside the modal, breaking the APG Alert Dialog
  // focus-trap invariant. This handler runs first (`composeEventHandlers`); it
  // defers to Radix when an enabled Cancel exists, otherwise takes over and lands
  // focus on the first enabled control, falling back to the content element.
  const handleOpenAutoFocus = useCallback(
    (event: Event) => {
      onOpenAutoFocus?.(event);
      if (event.defaultPrevented) return;
      const content = event.currentTarget;
      if (!(content instanceof HTMLElement)) return;
      if (content.querySelector(`[${CANCEL_ATTR}]:not([disabled])`)) return;
      event.preventDefault();
      const focusable =
        content.querySelector<HTMLElement>(FOCUSABLE_SELECTOR) ?? content;
      if (focusable === content) content.tabIndex = -1;
      focusable.focus({ preventScroll: true });
    },
    [onOpenAutoFocus],
  );

  return (
    <RadixAlertDialog.Portal>
      <RadixAlertDialog.Overlay className={overlayScrim} />
      <div
        className={cn(overlayCentering, mobileSheet && overlayCenteringSheet)}
      >
        <RadixAlertDialog.Content
          {...rest}
          onOpenAutoFocus={handleOpenAutoFocus}
          className={cn(
            cardBase,
            cardSize[size],
            mobileSheet && cardSheet,
            layoutClassName,
          )}
        >
          {children}
        </RadixAlertDialog.Content>
      </div>
    </RadixAlertDialog.Portal>
  );
}

// ---------------------------------------------------------------------------
// Title / Description — wrap the Radix parts driving `aria-labelledby` /
// `aria-describedby`.
// ---------------------------------------------------------------------------

type AlertDialogTitleProps = Omit<
  React.ComponentProps<typeof RadixAlertDialog.Title>,
  "className" | "style"
> & {
  layoutClassName?: string;
};

export function AlertDialogTitle({
  layoutClassName,
  ...rest
}: AlertDialogTitleProps): React.JSX.Element {
  return (
    <RadixAlertDialog.Title
      {...rest}
      className={cn(dialogTitle, layoutClassName)}
    />
  );
}

type AlertDialogDescriptionProps = Omit<
  React.ComponentProps<typeof RadixAlertDialog.Description>,
  "className" | "style"
> & {
  layoutClassName?: string;
};

export function AlertDialogDescription({
  layoutClassName,
  ...rest
}: AlertDialogDescriptionProps): React.JSX.Element {
  return (
    <RadixAlertDialog.Description
      {...rest}
      className={cn(dialogDescription, layoutClassName)}
    />
  );
}

// ---------------------------------------------------------------------------
// Actions — layout-only right-aligned button row (the legacy `.modal-actions`).
// ---------------------------------------------------------------------------

type AlertDialogActionsProps = Omit<
  React.HTMLAttributes<HTMLDivElement>,
  "className" | "style"
> & {
  layoutClassName?: string;
};

export function AlertDialogActions({
  layoutClassName,
  ...rest
}: AlertDialogActionsProps): React.JSX.Element {
  return <div {...rest} className={cn(dialogActions, layoutClassName)} />;
}

// ---------------------------------------------------------------------------
// Action / Cancel — Radix Action/Cancel composed (`asChild`) onto the `Button`
// primitive, which owns the box, variant colours, and the canonical cyan focus
// ring. `Action` confirms (Radix closes + runs `onClick`); `danger` swaps the
// confirm to the destructive variant. `Cancel` is the neutral default Button and
// is the element Radix focuses by default.
// ---------------------------------------------------------------------------

type AlertDialogActionProps = Omit<ButtonProps, "variant"> & {
  /** Render the destructive variant (red) instead of the primary confirm. */
  danger?: boolean;
};

export function AlertDialogAction({
  danger = false,
  size = "sm",
  touch = true,
  layoutClassName,
  children,
  ...rest
}: AlertDialogActionProps): React.JSX.Element {
  return (
    <RadixAlertDialog.Action asChild>
      <Button
        variant={danger ? "danger" : "primary"}
        size={size}
        touch={touch}
        layoutClassName={layoutClassName}
        {...rest}
      >
        {children}
      </Button>
    </RadixAlertDialog.Action>
  );
}

type AlertDialogCancelProps = Omit<ButtonProps, "variant">;

export function AlertDialogCancel({
  size = "sm",
  touch = true,
  layoutClassName,
  children,
  ...rest
}: AlertDialogCancelProps): React.JSX.Element {
  return (
    <RadixAlertDialog.Cancel asChild>
      <Button
        variant="default"
        size={size}
        touch={touch}
        layoutClassName={layoutClassName}
        {...{ [CANCEL_ATTR]: "" }}
        {...rest}
      >
        {children}
      </Button>
    </RadixAlertDialog.Cancel>
  );
}
