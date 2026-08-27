"use client";

import { useCallback, useState } from "react";
import { Select as RadixSelect } from "radix-ui";
import { CheckIcon, ChevronDownIcon } from "@/components/icons";
import { useOverlayScope } from "@/hooks/useOverlayScope";
import { cn } from "@/lib/ui/cn";

// Radix-backed single-value picker (WAI-ARIA APG "Select-Only Combobox" / Listbox
// pattern: https://www.w3.org/WAI/ARIA/apg/patterns/combobox/). Radix owns the
// behaviour — listbox roving focus, type-ahead, arrow/Home/End/Escape, collision
// positioning, outside-click, value selection, `role`/`aria-*` wiring — and these
// wrappers own CC appearance via Radix's own `data-*` attributes (`data-state`
// checked/unchecked/open/closed, `data-highlighted`, `data-disabled`,
// `data-placeholder`). Parts omit `className`/`style`; the only escape hatch is the
// layout-only `layoutClassName` (docs/tailwind-conventions.md §2).

// Canonical CC picker trigger: surface rest → border-strong/bg-hover hover →
// cyan-border + cyan-glow ring when open; canonical cyan `:focus-visible`
// outline; 44px touch on mobile.
const triggerClass = cn(
  "group inline-flex h-9 cursor-pointer items-center gap-[6px] rounded-md border border-solid px-3 font-mono text-[0.72rem] font-medium whitespace-nowrap transition-all duration-150 ease-[ease] outline-none max-768:h-[44px]",
  "border-border-default bg-bg-surface text-text-secondary data-[placeholder]:text-text-tertiary",
  "data-[state=closed]:hover:border-border-strong data-[state=closed]:hover:bg-bg-hover data-[state=closed]:hover:text-text-primary",
  "data-[state=open]:border-cyan-dim data-[state=open]:text-text-primary data-[state=open]:shadow-[0_0_0_3px_var(--cyan-glow)]",
  "focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:[outline-offset:2px]",
  "data-[disabled]:cursor-not-allowed data-[disabled]:opacity-40",
);

// Listbox surface — the canonical CC overlay (elevated card + menu drop shadow),
// shared visual language with DropdownMenu. `min-w` tracks the trigger width;
// height is capped to Radix's collision-computed space so long lists scroll.
const contentClass = cn(
  "max-h-[var(--radix-select-content-available-height)] min-w-[var(--radix-select-trigger-width)] overflow-hidden rounded-md border border-solid border-border-default bg-bg-elevated shadow-menu",
  "origin-[var(--radix-select-content-transform-origin)] data-[state=open]:motion-safe:animate-[fadeIn_0.12s_ease]",
);
export type SelectContentLayer = "menu" | "popover";
const contentLayerClass: Record<SelectContentLayer, string> = {
  menu: "z-menu",
  popover: "z-popover",
};

const scrollButtonClass =
  "flex h-[20px] cursor-default items-center justify-center bg-bg-elevated text-text-tertiary";

// Option row. The checked row takes the cyan-glow tint (the legacy active-option
// affordance) plus a left check indicator; the highlighted-but-unchecked bg and
// the checked bg are mutually exclusive via chained data-* variants so no two
// utilities target `background` on one element. `group` lets the description dim
// to cyan when its row is selected (better contrast than tertiary on the tint).
const itemClass = cn(
  "group relative flex w-full cursor-pointer items-center gap-[8px] rounded-sm py-[7px] pr-[10px] pl-[28px] text-left font-mono text-[0.74rem] font-medium transition-[background,color] duration-[100ms] ease-[ease] outline-none select-none",
  "data-[disabled]:pointer-events-none data-[disabled]:opacity-40",
  "data-[state=unchecked]:text-text-primary data-[state=unchecked]:data-[highlighted]:bg-[var(--cc-cyan-a08)]",
  "data-[state=checked]:bg-cyan-glow data-[state=checked]:text-cyan",
  "focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:[outline-offset:-2px]",
);
const itemIndicatorClass =
  "absolute left-[8px] top-1/2 inline-flex -translate-y-1/2 items-center justify-center text-cyan";
const itemDescriptionClass =
  "ml-auto pl-[16px] font-mono text-[0.7rem] text-text-tertiary group-data-[state=checked]:text-cyan-dim";

const labelClass =
  "select-none px-[10px] pt-[6px] pb-[4px] font-mono text-[0.7rem] font-semibold uppercase tracking-[0.08em] text-text-tertiary";
const separatorClass = "mx-[2px] my-[4px] h-px bg-border-subtle";

// ---------------------------------------------------------------------------
// Root — wires the open state into the global overlay scope (controlled +
// uncontrolled), so page-level hotkeys stay suppressed while the listbox is open.
// ---------------------------------------------------------------------------

type SelectProps = React.ComponentProps<typeof RadixSelect.Root>;

export function Select({
  open,
  defaultOpen,
  onOpenChange,
  children,
  ...rest
}: SelectProps): React.JSX.Element {
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
    <RadixSelect.Root
      {...rest}
      {...(isControlled ? { open } : { defaultOpen })}
      onOpenChange={handleOpenChange}
    >
      {children}
    </RadixSelect.Root>
  );
}

// Structural part carries no appearance.
export const SelectGroup = RadixSelect.Group;

// `SelectValue` renders the selected option's text (or the placeholder) inside
// the trigger; re-exported as-is.
export const SelectValue = RadixSelect.Value;

// ---------------------------------------------------------------------------
// Trigger
// ---------------------------------------------------------------------------

type SelectTriggerProps = Omit<
  React.ComponentProps<typeof RadixSelect.Trigger>,
  "className" | "style"
> & {
  /** External-geometry utilities only (e.g. width); appended after appearance. */
  layoutClassName?: string;
};

export function SelectTrigger({
  asChild,
  layoutClassName,
  children,
  ...rest
}: SelectTriggerProps): React.JSX.Element {
  // `asChild`: the consumer supplies the entire trigger element (e.g. a special
  // non-canonical variant like the rainbow effort trigger) and owns its own
  // appearance + chevron. Radix merges the combobox props/ref onto it.
  if (asChild) {
    return (
      <RadixSelect.Trigger asChild {...rest}>
        {children}
      </RadixSelect.Trigger>
    );
  }
  return (
    <RadixSelect.Trigger
      {...rest}
      className={cn(triggerClass, layoutClassName)}
    >
      {children}
      <RadixSelect.Icon className="inline-flex text-text-tertiary transition-transform duration-150 ease-[ease] group-data-[state=open]:rotate-180 group-data-[state=open]:text-text-secondary">
        <ChevronDownIcon size={14} />
      </RadixSelect.Icon>
    </RadixSelect.Trigger>
  );
}

// ---------------------------------------------------------------------------
// Content
// ---------------------------------------------------------------------------

type SelectContentProps = Omit<
  React.ComponentProps<typeof RadixSelect.Content>,
  "className" | "style"
> & {
  /** Stacking tier for the portaled listbox; use popover inside a popover. */
  contentLayer?: SelectContentLayer;
  layoutClassName?: string;
};

export function SelectContent({
  contentLayer = "menu",
  layoutClassName,
  children,
  position = "popper",
  sideOffset = 6,
  collisionPadding = 8,
  ...rest
}: SelectContentProps): React.JSX.Element {
  return (
    <RadixSelect.Portal>
      <RadixSelect.Content
        position={position}
        sideOffset={sideOffset}
        collisionPadding={collisionPadding}
        {...rest}
        className={cn(
          contentClass,
          contentLayerClass[contentLayer],
          layoutClassName,
        )}
      >
        <RadixSelect.ScrollUpButton className={scrollButtonClass}>
          <ChevronDownIcon size={14} className="rotate-180" />
        </RadixSelect.ScrollUpButton>
        <RadixSelect.Viewport className="p-[4px]">
          {children}
        </RadixSelect.Viewport>
        <RadixSelect.ScrollDownButton className={scrollButtonClass}>
          <ChevronDownIcon size={14} />
        </RadixSelect.ScrollDownButton>
      </RadixSelect.Content>
    </RadixSelect.Portal>
  );
}

// ---------------------------------------------------------------------------
// Item
// ---------------------------------------------------------------------------

type SelectItemProps = Omit<
  React.ComponentProps<typeof RadixSelect.Item>,
  "className" | "style"
> & {
  /** Optional muted text shown right-aligned in the row (not in the trigger). */
  description?: React.ReactNode;
  layoutClassName?: string;
};

export function SelectItem({
  description,
  layoutClassName,
  children,
  ...rest
}: SelectItemProps): React.JSX.Element {
  return (
    <RadixSelect.Item {...rest} className={cn(itemClass, layoutClassName)}>
      <RadixSelect.ItemIndicator className={itemIndicatorClass}>
        <CheckIcon size={14} />
      </RadixSelect.ItemIndicator>
      <RadixSelect.ItemText>{children}</RadixSelect.ItemText>
      {description != null && (
        <span className={itemDescriptionClass}>{description}</span>
      )}
    </RadixSelect.Item>
  );
}

// ---------------------------------------------------------------------------
// Label / Separator
// ---------------------------------------------------------------------------

type SelectLabelProps = Omit<
  React.ComponentProps<typeof RadixSelect.Label>,
  "className" | "style"
> & {
  layoutClassName?: string;
};

export function SelectLabel({
  layoutClassName,
  ...rest
}: SelectLabelProps): React.JSX.Element {
  return (
    <RadixSelect.Label {...rest} className={cn(labelClass, layoutClassName)} />
  );
}

type SelectSeparatorProps = Omit<
  React.ComponentProps<typeof RadixSelect.Separator>,
  "className" | "style"
> & {
  layoutClassName?: string;
};

export function SelectSeparator({
  layoutClassName,
  ...rest
}: SelectSeparatorProps): React.JSX.Element {
  return (
    <RadixSelect.Separator
      {...rest}
      className={cn(separatorClass, layoutClassName)}
    />
  );
}
