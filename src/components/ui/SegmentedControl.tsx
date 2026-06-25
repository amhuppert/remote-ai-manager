"use client";

import { RadioGroup as RadixRadioGroup } from "radix-ui";
import { cn } from "@/lib/ui/cn";

// Radix-backed segmented / exclusive-choice control (WAI-ARIA APG "Radio Group"
// pattern: https://www.w3.org/WAI/ARIA/apg/patterns/radio/). It is a *value*
// picker — exactly one of N segments is active — so it is built on Radix
// `RadioGroup` (role=radiogroup/radio, roving arrow-key navigation, the
// always-one-selected invariant). It is deliberately NOT Tabs: true Tabs switch
// which *panel* is visible (role=tablist/tab/tabpanel + aria-controls); a
// segmented control selects a value (a filter / mode / backend). See the
// migration contract §7 and §10. It is also NOT a `ToggleGroup` — `ToggleGroup
// type="single"` can deselect to an empty value, which is the wrong semantic for
// "pick exactly one". `RadioGroup` and `SegmentedControl` are two presentations
// of one Radix primitive: a vertical radio-dot list vs. this horizontal button
// row. Parts omit `className`/`style`; the only escape hatch is the layout-only
// `layoutClassName` (docs/tailwind-conventions.md §2).

// Container: the inset segmented track. Selection is a cyan-glow tint on the
// active segment — never a full cyan fill (reserved for primary buttons / active
// .cc-tab per the design system).
const rootClass =
  "inline-flex items-center gap-[2px] rounded-sm border border-solid border-border-default bg-bg-surface p-[2px]";

const itemClass = cn(
  "inline-flex h-[22px] min-w-0 cursor-pointer items-center justify-center gap-[5px] rounded-[3px] border-0 bg-transparent px-[10px] font-mono text-[0.7rem] font-semibold tracking-[0.06em] whitespace-nowrap text-text-secondary uppercase transition-[background-color,color] duration-150 ease-[ease] outline-none",
  "data-[state=unchecked]:hover:bg-bg-hover data-[state=unchecked]:hover:text-text-primary",
  "data-[state=checked]:bg-cyan-glow data-[state=checked]:text-cyan",
  "focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:[outline-offset:2px]",
  "data-[disabled]:cursor-not-allowed data-[disabled]:opacity-40",
  "max-768:min-h-[var(--touch-target-min)]",
);

type SegmentedControlProps = Omit<
  React.ComponentProps<typeof RadixRadioGroup.Root>,
  "className" | "style"
> & {
  /** External-geometry utilities only; appended after appearance. */
  layoutClassName?: string;
};

export function SegmentedControl({
  layoutClassName,
  orientation = "horizontal",
  ...rest
}: SegmentedControlProps): React.JSX.Element {
  return (
    <RadixRadioGroup.Root
      orientation={orientation}
      {...rest}
      className={cn(rootClass, layoutClassName)}
    />
  );
}

type SegmentedControlItemProps = Omit<
  React.ComponentProps<typeof RadixRadioGroup.Item>,
  "className" | "style"
> & {
  /** External-geometry utilities only; appended after appearance. */
  layoutClassName?: string;
};

export function SegmentedControlItem({
  layoutClassName,
  ...rest
}: SegmentedControlItemProps): React.JSX.Element {
  return (
    <RadixRadioGroup.Item
      {...rest}
      className={cn(itemClass, layoutClassName)}
    />
  );
}
