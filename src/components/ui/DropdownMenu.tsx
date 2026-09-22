"use client";

import { useCallback, useState } from "react";
import { DropdownMenu as RadixDropdownMenu } from "radix-ui";
import { CheckIcon, ChevronRightIcon } from "@/components/icons";
import { useOverlayScope } from "@/hooks/useOverlayScope";
import { cn } from "@/lib/ui/cn";
import {
  menuSurface,
  menuItemBase,
  menuItemTone,
  menuItemDanger,
  menuItemTouch,
  menuChoiceBase,
  menuChoiceTone,
  menuChoiceIndicator,
  menuSubTriggerOpen,
  menuLabel,
  menuSeparator,
  menuShortcut,
} from "./menu-recipe";

// Radix-backed menu-button primitive (WAI-ARIA APG "Menu Button" pattern:
// https://www.w3.org/WAI/ARIA/apg/patterns/menu-button/). Radix owns the
// behaviour — roving focus, type-ahead, arrow/Home/End/Escape keys,
// collision-aware positioning, outside-click dismissal, `role`/`aria-*` wiring —
// and these wrappers own the CC appearance, sharing the menu recipe with
// `ContextMenu` (see `menu-recipe.ts`). State is read off Radix's own `data-*`
// attributes (`data-state`, `data-highlighted`, `data-disabled`) via Tailwind
// `data-*` variants; the parts omit `className`/`style` so a call site cannot
// inject appearance, exposing only the layout-only `layoutClassName` escape hatch
// (docs/tailwind-conventions.md §2).

// Content-only extras: cap the height to Radix's collision-computed available
// space (long menus scroll instead of overflowing the viewport) and anchor the
// transform to Radix's side/align-aware origin.
const contentExtras =
  "max-h-[var(--radix-dropdown-menu-content-available-height)] overflow-y-auto origin-[var(--radix-dropdown-menu-content-transform-origin)]";

// ---------------------------------------------------------------------------
// Root — wraps Radix Root and registers the open menu with the global overlay
// scope so page-level hotkeys are suppressed while it is open. Supports both
// controlled and uncontrolled use; the open value fed to `useOverlayScope`
// tracks whichever is active.
// ---------------------------------------------------------------------------

type DropdownMenuProps = React.ComponentProps<typeof RadixDropdownMenu.Root>;

export function DropdownMenu({
  open,
  defaultOpen,
  onOpenChange,
  // Non-modal by default: a menu is not a blocking dialog. Modal mode locks page
  // scroll and `aria-hidden`s the rest of the page (including the trigger, which
  // stays focusable → axe `aria-hidden-focus`); non-modal avoids both and matches
  // CC's lightweight menus. Radix still handles Escape, outside-click, and Tab-to-
  // close. Pass `modal` to override per call site.
  modal = false,
  children,
  ...rest
}: DropdownMenuProps): React.JSX.Element {
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
    <RadixDropdownMenu.Root
      {...rest}
      modal={modal}
      {...(isControlled ? { open } : { defaultOpen })}
      onOpenChange={handleOpenChange}
    >
      {children}
    </RadixDropdownMenu.Root>
  );
}

// Structural parts carry no appearance — re-export Radix directly.
export const DropdownMenuTrigger = RadixDropdownMenu.Trigger;
/** @public */
export const DropdownMenuPortal = RadixDropdownMenu.Portal;
/** @public */
export const DropdownMenuGroup = RadixDropdownMenu.Group;
export const DropdownMenuRadioGroup = RadixDropdownMenu.RadioGroup;
export const DropdownMenuSub = RadixDropdownMenu.Sub;

// ---------------------------------------------------------------------------
// Content
// ---------------------------------------------------------------------------

type DropdownMenuContentProps = Omit<
  React.ComponentProps<typeof RadixDropdownMenu.Content>,
  "className" | "style"
> & {
  /** External-geometry utilities only (e.g. width); appended after appearance. */
  layoutClassName?: string;
};

export function DropdownMenuContent({
  layoutClassName,
  sideOffset = 6,
  collisionPadding = 8,
  ...rest
}: DropdownMenuContentProps): React.JSX.Element {
  return (
    <RadixDropdownMenu.Portal>
      <RadixDropdownMenu.Content
        sideOffset={sideOffset}
        collisionPadding={collisionPadding}
        {...rest}
        className={cn(menuSurface, contentExtras, layoutClassName)}
      />
    </RadixDropdownMenu.Portal>
  );
}

// ---------------------------------------------------------------------------
// Item
// ---------------------------------------------------------------------------

type DropdownMenuItemProps = Omit<
  React.ComponentProps<typeof RadixDropdownMenu.Item>,
  "className" | "style"
> & {
  /** Destructive action styling (red text, red-tinted highlight). */
  danger?: boolean;
  /** 44px row minimum below 768px, for menus reached by thumb. */
  touch?: boolean;
  /** External-geometry utilities only; appended after appearance. */
  layoutClassName?: string;
};

export function DropdownMenuItem({
  danger = false,
  touch = false,
  layoutClassName,
  ...rest
}: DropdownMenuItemProps): React.JSX.Element {
  return (
    <RadixDropdownMenu.Item
      {...rest}
      className={cn(
        menuItemBase,
        danger ? menuItemDanger : menuItemTone,
        touch && menuItemTouch,
        layoutClassName,
      )}
    />
  );
}

// ---------------------------------------------------------------------------
// CheckboxItem / RadioItem
// ---------------------------------------------------------------------------

type DropdownMenuCheckboxItemProps = Omit<
  React.ComponentProps<typeof RadixDropdownMenu.CheckboxItem>,
  "className" | "style"
> & {
  layoutClassName?: string;
};

export function DropdownMenuCheckboxItem({
  layoutClassName,
  children,
  ...rest
}: DropdownMenuCheckboxItemProps): React.JSX.Element {
  return (
    <RadixDropdownMenu.CheckboxItem
      {...rest}
      className={cn(menuChoiceBase, menuChoiceTone, layoutClassName)}
    >
      <RadixDropdownMenu.ItemIndicator className={menuChoiceIndicator}>
        <CheckIcon size={14} />
      </RadixDropdownMenu.ItemIndicator>
      {children}
    </RadixDropdownMenu.CheckboxItem>
  );
}

type DropdownMenuRadioItemProps = Omit<
  React.ComponentProps<typeof RadixDropdownMenu.RadioItem>,
  "className" | "style"
> & {
  layoutClassName?: string;
};

export function DropdownMenuRadioItem({
  layoutClassName,
  children,
  ...rest
}: DropdownMenuRadioItemProps): React.JSX.Element {
  return (
    <RadixDropdownMenu.RadioItem
      {...rest}
      className={cn(menuChoiceBase, menuChoiceTone, layoutClassName)}
    >
      <RadixDropdownMenu.ItemIndicator className={menuChoiceIndicator}>
        <CheckIcon size={16} />
      </RadixDropdownMenu.ItemIndicator>
      {children}
    </RadixDropdownMenu.RadioItem>
  );
}

// ---------------------------------------------------------------------------
// Label / Separator / Shortcut
// ---------------------------------------------------------------------------

type DropdownMenuLabelProps = Omit<
  React.ComponentProps<typeof RadixDropdownMenu.Label>,
  "className" | "style"
> & {
  layoutClassName?: string;
};

export function DropdownMenuLabel({
  layoutClassName,
  ...rest
}: DropdownMenuLabelProps): React.JSX.Element {
  return (
    <RadixDropdownMenu.Label
      {...rest}
      className={cn(menuLabel, layoutClassName)}
    />
  );
}

type DropdownMenuSeparatorProps = Omit<
  React.ComponentProps<typeof RadixDropdownMenu.Separator>,
  "className" | "style"
> & {
  layoutClassName?: string;
};

export function DropdownMenuSeparator({
  layoutClassName,
  ...rest
}: DropdownMenuSeparatorProps): React.JSX.Element {
  return (
    <RadixDropdownMenu.Separator
      {...rest}
      className={cn(menuSeparator, layoutClassName)}
    />
  );
}

type DropdownMenuShortcutProps = Omit<
  React.HTMLAttributes<HTMLSpanElement>,
  "className" | "style"
> & {
  layoutClassName?: string;
};

export function DropdownMenuShortcut({
  layoutClassName,
  ...rest
}: DropdownMenuShortcutProps): React.JSX.Element {
  return <span {...rest} className={cn(menuShortcut, layoutClassName)} />;
}

// ---------------------------------------------------------------------------
// Submenu
// ---------------------------------------------------------------------------

type DropdownMenuSubTriggerProps = Omit<
  React.ComponentProps<typeof RadixDropdownMenu.SubTrigger>,
  "className" | "style"
> & {
  layoutClassName?: string;
};

export function DropdownMenuSubTrigger({
  layoutClassName,
  children,
  ...rest
}: DropdownMenuSubTriggerProps): React.JSX.Element {
  return (
    <RadixDropdownMenu.SubTrigger
      {...rest}
      className={cn(
        menuItemBase,
        menuItemTone,
        menuSubTriggerOpen,
        layoutClassName,
      )}
    >
      {children}
      <ChevronRightIcon size={14} className="ml-auto" />
    </RadixDropdownMenu.SubTrigger>
  );
}

type DropdownMenuSubContentProps = Omit<
  React.ComponentProps<typeof RadixDropdownMenu.SubContent>,
  "className" | "style"
> & {
  layoutClassName?: string;
};

export function DropdownMenuSubContent({
  layoutClassName,
  sideOffset = 4,
  ...rest
}: DropdownMenuSubContentProps): React.JSX.Element {
  return (
    <RadixDropdownMenu.Portal>
      <RadixDropdownMenu.SubContent
        sideOffset={sideOffset}
        {...rest}
        className={cn(menuSurface, layoutClassName)}
      />
    </RadixDropdownMenu.Portal>
  );
}
