"use client";

import { useCallback, useState } from "react";
import { ContextMenu as RadixContextMenu } from "radix-ui";
import { CheckIcon, ChevronRightIcon } from "@/components/icons";
import { useOverlayScope } from "@/hooks/useOverlayScope";
import { cn } from "@/lib/ui/cn";
import {
  menuSurface,
  menuItemBase,
  menuItemTone,
  menuItemDanger,
  menuChoiceBase,
  menuChoiceTone,
  menuChoiceIndicator,
  menuSubTriggerOpen,
  menuLabel,
  menuSeparator,
  menuShortcut,
} from "./menu-recipe";

// Radix-backed right-click context menu (WAI-ARIA APG menu pattern, opened via the
// `contextmenu` event rather than a button — https://www.w3.org/WAI/ARIA/apg/patterns/menu-button/).
// Radix owns the behaviour — cursor-anchored collision positioning, roving focus,
// type-ahead, arrow/Home/End/Escape, outside-click dismissal, `role`/`aria-*`
// wiring — and these wrappers own the CC appearance, sharing the exact menu recipe
// with `DropdownMenu` (see `menu-recipe.ts`). State is read off Radix's `data-*`
// attributes; parts omit `className`/`style`, exposing only the layout-only
// `layoutClassName` escape hatch (docs/tailwind-conventions.md §2).

// Content-only extras (Radix's context-menu-namespaced collision vars).
const contentExtras =
  "max-h-[var(--radix-context-menu-content-available-height)] overflow-y-auto origin-[var(--radix-context-menu-content-transform-origin)]";

// ---------------------------------------------------------------------------
// Root — registers the open menu with the global overlay scope. Radix ContextMenu
// has no controllable `open` (it opens on right-click), so the open value is read
// from `onOpenChange`. Non-modal by default (no scroll-lock; the trigger area's
// focusable children stay reachable → avoids axe `aria-hidden-focus`).
// ---------------------------------------------------------------------------

type ContextMenuProps = React.ComponentProps<typeof RadixContextMenu.Root>;

export function ContextMenu({
  onOpenChange,
  modal = false,
  children,
  ...rest
}: ContextMenuProps): React.JSX.Element {
  const [open, setOpen] = useState(false);
  useOverlayScope(open);

  const handleOpenChange = useCallback(
    (next: boolean) => {
      setOpen(next);
      onOpenChange?.(next);
    },
    [onOpenChange],
  );

  return (
    <RadixContextMenu.Root
      {...rest}
      modal={modal}
      onOpenChange={handleOpenChange}
    >
      {children}
    </RadixContextMenu.Root>
  );
}

// Structural parts carry no appearance — re-export Radix directly. `Trigger` wraps
// the right-clickable area; consumers provide its content.
export const ContextMenuTrigger = RadixContextMenu.Trigger;
export const ContextMenuPortal = RadixContextMenu.Portal;
export const ContextMenuGroup = RadixContextMenu.Group;
export const ContextMenuRadioGroup = RadixContextMenu.RadioGroup;
export const ContextMenuSub = RadixContextMenu.Sub;

// ---------------------------------------------------------------------------
// Content
// ---------------------------------------------------------------------------

type ContextMenuContentProps = Omit<
  React.ComponentProps<typeof RadixContextMenu.Content>,
  "className" | "style"
> & {
  /** External-geometry utilities only (e.g. width); appended after appearance. */
  layoutClassName?: string;
};

export function ContextMenuContent({
  layoutClassName,
  collisionPadding = 8,
  ...rest
}: ContextMenuContentProps): React.JSX.Element {
  return (
    <RadixContextMenu.Portal>
      <RadixContextMenu.Content
        collisionPadding={collisionPadding}
        {...rest}
        className={cn(menuSurface, contentExtras, layoutClassName)}
      />
    </RadixContextMenu.Portal>
  );
}

// ---------------------------------------------------------------------------
// Item
// ---------------------------------------------------------------------------

type ContextMenuItemProps = Omit<
  React.ComponentProps<typeof RadixContextMenu.Item>,
  "className" | "style"
> & {
  /** Destructive action styling (red text, red-tinted highlight). */
  danger?: boolean;
  /** External-geometry utilities only; appended after appearance. */
  layoutClassName?: string;
};

export function ContextMenuItem({
  danger = false,
  layoutClassName,
  ...rest
}: ContextMenuItemProps): React.JSX.Element {
  return (
    <RadixContextMenu.Item
      {...rest}
      className={cn(
        menuItemBase,
        danger ? menuItemDanger : menuItemTone,
        layoutClassName,
      )}
    />
  );
}

// ---------------------------------------------------------------------------
// CheckboxItem / RadioItem
// ---------------------------------------------------------------------------

type ContextMenuCheckboxItemProps = Omit<
  React.ComponentProps<typeof RadixContextMenu.CheckboxItem>,
  "className" | "style"
> & {
  layoutClassName?: string;
};

export function ContextMenuCheckboxItem({
  layoutClassName,
  children,
  ...rest
}: ContextMenuCheckboxItemProps): React.JSX.Element {
  return (
    <RadixContextMenu.CheckboxItem
      {...rest}
      className={cn(menuChoiceBase, menuChoiceTone, layoutClassName)}
    >
      <RadixContextMenu.ItemIndicator className={menuChoiceIndicator}>
        <CheckIcon size={14} />
      </RadixContextMenu.ItemIndicator>
      {children}
    </RadixContextMenu.CheckboxItem>
  );
}

type ContextMenuRadioItemProps = Omit<
  React.ComponentProps<typeof RadixContextMenu.RadioItem>,
  "className" | "style"
> & {
  layoutClassName?: string;
};

export function ContextMenuRadioItem({
  layoutClassName,
  children,
  ...rest
}: ContextMenuRadioItemProps): React.JSX.Element {
  return (
    <RadixContextMenu.RadioItem
      {...rest}
      className={cn(menuChoiceBase, menuChoiceTone, layoutClassName)}
    >
      <RadixContextMenu.ItemIndicator className={menuChoiceIndicator}>
        <span className="size-[5px] rounded-full bg-current" />
      </RadixContextMenu.ItemIndicator>
      {children}
    </RadixContextMenu.RadioItem>
  );
}

// ---------------------------------------------------------------------------
// Label / Separator / Shortcut
// ---------------------------------------------------------------------------

type ContextMenuLabelProps = Omit<
  React.ComponentProps<typeof RadixContextMenu.Label>,
  "className" | "style"
> & {
  layoutClassName?: string;
};

export function ContextMenuLabel({
  layoutClassName,
  ...rest
}: ContextMenuLabelProps): React.JSX.Element {
  return (
    <RadixContextMenu.Label
      {...rest}
      className={cn(menuLabel, layoutClassName)}
    />
  );
}

type ContextMenuSeparatorProps = Omit<
  React.ComponentProps<typeof RadixContextMenu.Separator>,
  "className" | "style"
> & {
  layoutClassName?: string;
};

export function ContextMenuSeparator({
  layoutClassName,
  ...rest
}: ContextMenuSeparatorProps): React.JSX.Element {
  return (
    <RadixContextMenu.Separator
      {...rest}
      className={cn(menuSeparator, layoutClassName)}
    />
  );
}

type ContextMenuShortcutProps = Omit<
  React.HTMLAttributes<HTMLSpanElement>,
  "className" | "style"
> & {
  layoutClassName?: string;
};

export function ContextMenuShortcut({
  layoutClassName,
  ...rest
}: ContextMenuShortcutProps): React.JSX.Element {
  return <span {...rest} className={cn(menuShortcut, layoutClassName)} />;
}

// ---------------------------------------------------------------------------
// Submenu
// ---------------------------------------------------------------------------

type ContextMenuSubTriggerProps = Omit<
  React.ComponentProps<typeof RadixContextMenu.SubTrigger>,
  "className" | "style"
> & {
  layoutClassName?: string;
};

export function ContextMenuSubTrigger({
  layoutClassName,
  children,
  ...rest
}: ContextMenuSubTriggerProps): React.JSX.Element {
  return (
    <RadixContextMenu.SubTrigger
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
    </RadixContextMenu.SubTrigger>
  );
}

type ContextMenuSubContentProps = Omit<
  React.ComponentProps<typeof RadixContextMenu.SubContent>,
  "className" | "style"
> & {
  layoutClassName?: string;
};

export function ContextMenuSubContent({
  layoutClassName,
  ...rest
}: ContextMenuSubContentProps): React.JSX.Element {
  return (
    <RadixContextMenu.Portal>
      <RadixContextMenu.SubContent
        {...rest}
        className={cn(menuSurface, layoutClassName)}
      />
    </RadixContextMenu.Portal>
  );
}
