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
  overlayStretch,
  cardBase,
  cardSize,
  cardSheet,
  cardSheetFullHeight,
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
//
// The `unstyled` escape hatch keeps everything Radix owns (Portal, the focus
// trap + focus return, Escape/outside-press dismissal, scroll-lock, the
// `role="dialog"`/`aria-modal`/`aria-labelledby`/`aria-describedby` wiring, the
// scrim) while dropping the padded card recipe, so a bespoke overlay — an
// edge-anchored slide-over/drawer, a bottom sheet, a full-screen immersive
// surface, or a custom-box-model card — supplies its own box model via
// `layoutClassName` instead of hand-rolling a `role="dialog"` div with a manual
// keydown/outside-click/focus loop. Pair `anchor="stretch"` (full-bleed
// positioning layer) with self-positioning `fixed` geometry for the
// edge-anchored shapes; `scrimClassName` overrides the tokenized scrim
// appearance for overlays whose backdrop differs (blur+saturate drawers, etc.).
// ---------------------------------------------------------------------------

type DialogContentProps = Omit<
  React.ComponentProps<typeof RadixDialog.Content>,
  "className" | "style"
> & {
  /** Card width: `default` (480px) or `confirm` (400px). Ignored when `unstyled`. */
  size?: DialogSize;
  /**
   * Dock to a full-width bottom sheet below 768px (the legacy `.modal` sheet).
   * Use `full-height` when the sheet must fill the mobile viewport.
   */
  mobileSheet?: boolean | "full-height";
  /**
   * Drop the padded card appearance recipe. The consumer owns the whole card box
   * model via `contentClassName`; Radix behaviour and the scrim stay. For a
   * bespoke overlay — an edge-anchored slide-over/drawer, a bottom sheet, a
   * full-screen immersive surface, or a custom-box-model card — that a plain
   * `DialogContent` cannot host.
   */
  unstyled?: boolean;
  /**
   * The card's full box model (appearance + geometry) in the `unstyled` variant —
   * where the primitive relinquishes appearance ownership, so this is a distinct
   * prop from the layout-only `layoutClassName` (the appearance-in-layout
   * guardrail does not apply). Ignored unless `unstyled`.
   */
  contentClassName?: string;
  /**
   * Positioning layer for the card. `center` (default) centres it above the
   * scrim; `stretch` makes the layer full-bleed (`inset-0`) so an edge-anchored
   * card positions itself. Only meaningful with `unstyled`.
   */
  anchor?: "center" | "stretch";
  /** Override the tokenized scrim appearance (kept marked for the freeze rule). */
  scrimClassName?: string;
  /**
   * Dynamic edge insets for a card anchored to a measured rect (`top`/`right`/
   * `bottom`/`left`), the one geometry an arbitrary Tailwind class cannot express
   * because the value is computed at runtime. Not an appearance escape hatch —
   * only positional insets are accepted, and only in the `unstyled` variant.
   */
  positionStyle?: Pick<
    React.CSSProperties,
    "top" | "right" | "bottom" | "left"
  >;
  /** External-geometry utilities only (styled variant); appended after appearance. */
  layoutClassName?: string;
};

export function DialogContent({
  size = "default",
  mobileSheet = false,
  unstyled = false,
  contentClassName,
  anchor = "center",
  scrimClassName,
  positionStyle,
  layoutClassName,
  children,
  ...rest
}: DialogContentProps): React.JSX.Element {
  const positioningLayer =
    unstyled && anchor === "stretch"
      ? overlayStretch
      : cn(overlayCentering, mobileSheet && overlayCenteringSheet);
  return (
    <RadixDialog.Portal>
      {/* `data-cc-modal-scrim` lets the global ambient-animation freeze rule
          (globals.css) pause the page's perpetual status-dot animations while
          this full-viewport `backdrop-filter` blur is mounted — otherwise the
          blur re-rasterizes every frame behind them and saturates the compositor. */}
      <RadixDialog.Overlay
        className={scrimClassName ?? overlayScrim}
        data-cc-modal-scrim=""
      />
      <div className={positioningLayer}>
        <RadixDialog.Content
          {...rest}
          {...(unstyled && positionStyle ? { style: positionStyle } : {})}
          className={
            unstyled
              ? cn(contentClassName)
              : cn(
                  cardBase,
                  cardSize[size],
                  mobileSheet && cardSheet,
                  mobileSheet === "full-height" && cardSheetFullHeight,
                  layoutClassName,
                )
          }
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
