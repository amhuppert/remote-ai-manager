"use client";

import type { ButtonHTMLAttributes, HTMLAttributes } from "react";
import { Tabs as RadixTabs } from "radix-ui";
import { cn } from "@/lib/ui/cn";

// ===========================================================================
// Radix-backed TRUE Tabs (WAI-ARIA APG "Tabs" pattern:
// https://www.w3.org/WAI/ARIA/apg/patterns/tabs/). Radix owns the behaviour —
// roving tabindex, Arrow/Home/End navigation, automatic activation, `role`
// (tablist/tab/tabpanel) + `aria-selected`/`aria-controls`/`aria-labelledby`
// wiring, and panel mount/unmount. These wrappers own only CC appearance via
// Radix's `data-state` (active/inactive) + `data-disabled` attributes. Parts
// omit `className`/`style`; the only escape hatch is the layout-only
// `layoutClassName` (docs/tailwind-conventions.md §2), appended last via cn().
//
// A bespoke-appearance tabset (grouped underline tabs, a vertical settings nav)
// passes `asChild` on `TabsList`/`TabsTrigger` to adopt its own elements: Radix
// keeps roving focus + automatic activation + aria wiring while the baked
// pill-strip recipe is dropped. `orientation="vertical"` passes straight through
// `TabsRoot` to Radix (Up/Down arrow nav + `data-orientation` on the parts).
//
// This is for panel-switchers (one of N content panels visible at a time). For
// value-pickers (a filter/mode/backend where exactly one is selected but no
// content panel is swapped) use a segmented control / RadioGroup, NOT this — see
// the presentational `Tabs`/`Tab`/`TabCount` recipe below and
// docs/reports/ui-primitive-migration-contract.md §7 / §10.
//
// NOTE (transitional naming): the Radix Root is exported as `TabsRoot` because
// the pre-existing presentational container already owns the `Tabs` name and its
// 7 consumers are migrated in a separate downstream context. Once those
// consumers move (6 → TabsRoot, ProjectsIndexPage → §7 segmented), rename
// `TabsRoot` → `Tabs` and delete the presentational recipe.
// ===========================================================================

// Root — re-wraps Radix's Root for a layout-only escape hatch (consumers often
// need `flex flex-col h-full` to stack the list over a flex-1 panel). Carries no
// appearance. `value`/`defaultValue`/`onValueChange`/`orientation`/
// `activationMode` pass straight through to Radix (default: automatic activation).
type TabsRootProps = Omit<
  React.ComponentProps<typeof RadixTabs.Root>,
  "className" | "style"
> & {
  /** External-geometry utilities only; appended after appearance. */
  layoutClassName?: string;
};

export function TabsRoot({
  layoutClassName,
  ...rest
}: TabsRootProps): React.JSX.Element {
  return <RadixTabs.Root {...rest} className={cn(layoutClassName)} />;
}

// List — the tab strip (role=tablist). Same recipe as the presentational `Tabs`
// container so the two look identical during the migration window.
const tabsListClass =
  "flex gap-[2px] p-[3px] bg-bg-surface border border-solid border-border-default rounded-md";

type TabsListProps = Omit<
  React.ComponentProps<typeof RadixTabs.List>,
  "className" | "style"
> & {
  layoutClassName?: string;
};

export function TabsList({
  asChild = false,
  layoutClassName,
  ...rest
}: TabsListProps): React.JSX.Element {
  // Unstyled escape hatch: the consumer's element becomes the tablist (e.g. a
  // bespoke underline strip with interleaved group labels, or a vertical nav
  // column). Radix keeps roving focus across the Triggers; the baked pill-strip
  // recipe is dropped so it cannot pollute the child.
  if (asChild) {
    return <RadixTabs.List {...rest} asChild className={cn(layoutClassName)} />;
  }
  return (
    <RadixTabs.List {...rest} className={cn(tabsListClass, layoutClassName)} />
  );
}

// Trigger — role=tab. Same `cc-tab` recipe as the presentational `Tab`, but the
// active/inactive distinction is driven by Radix's `data-state` (active beats
// hover; the two selectors are mutually exclusive so emission order is
// irrelevant) instead of the recipe's `data-active`. Disabled triggers dim and
// drop pointer events. Canonical cyan `:focus-visible` outline (Radix moves real
// DOM focus on arrow nav, so it matches on keyboard).
const tabsTriggerClass = cn(
  "flex min-h-[28px] cursor-pointer items-center gap-[4px] rounded-sm border-0 bg-transparent px-[10px] py-[5px] font-mono text-[0.72rem] font-medium tracking-[0.05em] whitespace-nowrap uppercase transition-all duration-150 ease-[ease] outline-none",
  "text-text-secondary data-[state=active]:bg-cyan data-[state=active]:text-text-inverse data-[state=inactive]:hover:bg-bg-hover data-[state=inactive]:hover:text-text-primary",
  "data-[disabled]:cursor-not-allowed data-[disabled]:opacity-40",
  "focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:[outline-offset:2px]",
);

// Fill/touch mode: on the mobile spine each tab centres its label and grows to a
// 36px touch target. The parent supplies the equal-split geometry
// (`grow shrink basis-0`) via `layoutClassName`; the primitive owns the
// appearance, which the layout-only allowlist forbids in `layoutClassName`.
const tabsTriggerFill = "max-768:justify-center max-768:min-h-[36px]";

type TabsTriggerProps = Omit<
  React.ComponentProps<typeof RadixTabs.Trigger>,
  "className" | "style"
> & {
  /** Mobile-spine fill/touch treatment: centre the label, 36px min-height. */
  fill?: boolean;
  layoutClassName?: string;
};

export function TabsTrigger({
  fill = false,
  asChild = false,
  layoutClassName,
  ...rest
}: TabsTriggerProps): React.JSX.Element {
  // Unstyled escape hatch: the consumer's own button becomes the role=tab. Radix
  // wires roving tabindex + aria-selected/controls + data-state onto it; the
  // baked cc-tab recipe (and the `fill` treatment) are dropped so a bespoke
  // appearance — underline tab, vertical nav item — is not polluted.
  if (asChild) {
    return (
      <RadixTabs.Trigger {...rest} asChild className={cn(layoutClassName)} />
    );
  }
  return (
    <RadixTabs.Trigger
      {...rest}
      className={cn(tabsTriggerClass, fill && tabsTriggerFill, layoutClassName)}
    />
  );
}

// Count/badge inside a trigger. Inherits the trigger's colour (inactive:
// text-secondary; active: text-inverse on cyan; hover: text-primary) — every
// state meets WCAG AA. It is NOT faded with opacity (a fade multiplies the
// inactive count toward its background and drops it below the AA threshold).
const tabsTriggerCountClass =
  "font-mono text-[0.7rem] font-medium px-[4px] rounded-full";

type TabsTriggerCountProps = Omit<
  HTMLAttributes<HTMLSpanElement>,
  "className" | "style"
> & {
  layoutClassName?: string;
};

export function TabsTriggerCount({
  layoutClassName,
  ...rest
}: TabsTriggerCountProps): React.JSX.Element {
  return (
    <span {...rest} className={cn(tabsTriggerCountClass, layoutClassName)} />
  );
}

// Content — the tab panel (role=tabpanel). Radix marks inactive panels hidden;
// mirror that through data-state so consumer display utilities such as `flex`
// cannot override the browser's hidden-attribute rule. Appearance/geometry of
// the panel body belongs to the consumer via `layoutClassName`.
const tabsContentClass =
  "outline-none data-[state=inactive]:hidden focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:[outline-offset:2px]";

type TabsContentProps = Omit<
  React.ComponentProps<typeof RadixTabs.Content>,
  "className" | "style"
> & {
  layoutClassName?: string;
};

export function TabsContent({
  layoutClassName,
  ...rest
}: TabsContentProps): React.JSX.Element {
  return (
    <RadixTabs.Content
      {...rest}
      className={cn(tabsContentClass, layoutClassName)}
    />
  );
}

// ===========================================================================
// Presentational segmented recipe (NOT APG tabs — no role=tab/tablist, no panel
// switching). Retained UNCHANGED for not-yet-migrated true-tab consumers (until
// they move to the Radix Tabs above) and for genuine value-pickers. Do not add
// ARIA tab semantics here; a value-picker is a RadioGroup/segmented control
// (contract §7), and a panel-switcher is the Radix Tabs above (§10).
// ===========================================================================

const tabsBase =
  "flex gap-[2px] p-[3px] bg-bg-surface border border-solid border-border-default rounded-md";

export type TabsProps = Omit<
  HTMLAttributes<HTMLDivElement>,
  "className" | "style"
> & {
  /** External-geometry utilities only; appended after appearance. */
  layoutClassName?: string;
};

export function Tabs({ layoutClassName, ...rest }: TabsProps) {
  return <div {...rest} className={cn(tabsBase, layoutClassName)} />;
}

const tabBase =
  "flex items-center gap-[4px] px-[10px] py-[5px] min-h-[28px] border-0 rounded-sm bg-transparent font-mono text-[0.72rem] font-medium uppercase tracking-[0.05em] cursor-pointer transition-all duration-150 ease-[ease] whitespace-nowrap";

// Active beats hover (legacy source order). Expressed order-independently: the
// active appearance is gated on `data-active=true` and the hover override on
// `data-active=false`, so the two selectors are mutually exclusive — no reliance
// on Tailwind's variant emission order.
const tabState =
  "text-text-secondary data-[active=true]:bg-cyan data-[active=true]:text-text-inverse data-[active=false]:hover:bg-bg-hover data-[active=false]:hover:text-text-primary";

// Fill/touch mode: on the mobile spine each tab centers its label and grows to a
// 36px touch target. The parent supplies the equal-split geometry
// (`grow shrink basis-0`) via `layoutClassName`; the primitive owns the
// appearance (`justify-center`/`min-h`), which the layout-only allowlist forbids
// in `layoutClassName` (docs/tailwind-conventions.md §2).
const tabFill = "max-768:justify-center max-768:min-h-[36px]";

export type TabProps = Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  "className" | "style"
> & {
  active?: boolean;
  /** Mobile-spine fill/touch treatment: center the label, 36px min-height. */
  fill?: boolean;
  /** External-geometry utilities only; appended after appearance. */
  layoutClassName?: string;
};

export function Tab({
  active = false,
  fill = false,
  layoutClassName,
  ...rest
}: TabProps) {
  return (
    <button
      {...rest}
      data-active={active}
      className={cn(tabBase, tabState, fill && tabFill, layoutClassName)}
    />
  );
}

// The active/inactive distinction is carried by the parent tab's color, which
// the count inherits (inactive: text-secondary on bg-surface; active:
// text-inverse on cyan; hover: text-primary) — every state meets WCAG AA. It is
// NOT faded with opacity: an opacity fade multiplies the inactive count toward
// its background and drops it below the AA text-contrast threshold.
const tabCountBase =
  "font-mono text-[0.7rem] font-medium px-[4px] rounded-full";

export type TabCountProps = Omit<
  HTMLAttributes<HTMLSpanElement>,
  "className" | "style"
> & {
  active?: boolean;
  /** External-geometry utilities only; appended after appearance. */
  layoutClassName?: string;
};

export function TabCount({
  active = false,
  layoutClassName,
  ...rest
}: TabCountProps) {
  return (
    <span
      {...rest}
      data-active={active}
      className={cn(tabCountBase, layoutClassName)}
    />
  );
}
