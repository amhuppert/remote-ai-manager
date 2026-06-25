"use client";

import { Collapsible as RadixCollapsible } from "radix-ui";
import { ChevronDownIcon } from "@/components/icons";
import { cn } from "@/lib/ui/cn";
import {
  disclosureTriggerBase,
  disclosureChevron,
  disclosureContentMotion,
} from "./disclosure-recipe";

// Radix-backed disclosure primitive (WAI-ARIA APG "Disclosure" pattern:
// https://www.w3.org/WAI/ARIA/apg/patterns/disclosure/). Radix owns the
// behaviour — Enter/Space toggle, `aria-expanded`/`aria-controls` wiring,
// `data-state` (open/closed), `data-disabled`, mount/unmount of the region —
// and these wrappers own CC appearance via the shared disclosure recipe
// (`disclosure-recipe.ts`, also used by `Accordion`). Parts omit
// `className`/`style` so a call site cannot inject appearance, exposing only the
// layout-only `layoutClassName` escape hatch (docs/tailwind-conventions.md §2).
// A bespoke-appearance consumer that cannot adopt the baked recipe (e.g. a
// header row hosting a sibling control, or a custom-styled trigger) passes
// `asChild` on the trigger/content: Radix wires the disclosure behaviour onto
// the consumer's own element and the baked recipe + chevron are dropped so they
// cannot pollute it.
//
// Use Collapsible for ONE show/hide region driven by ONE trigger. For a stack of
// mutually-aware expandable sections (roving focus, single-vs-multiple open),
// use `Accordion`. Collapsible is in-flow content, not a floating overlay, so it
// does NOT register with the overlay scope (page hotkeys stay live while open) —
// unlike `DropdownMenu`/`Popover`.

// ---------------------------------------------------------------------------
// Root — controlled (`open`/`onOpenChange`) or uncontrolled (`defaultOpen`);
// `disabled` propagates Radix `data-disabled` + the native disabled trigger.
// ---------------------------------------------------------------------------

type CollapsibleProps = Omit<
  React.ComponentProps<typeof RadixCollapsible.Root>,
  "className" | "style"
> & {
  /** External-geometry utilities only; appended after appearance. */
  layoutClassName?: string;
};

export function Collapsible({
  layoutClassName,
  ...rest
}: CollapsibleProps): React.JSX.Element {
  return <RadixCollapsible.Root {...rest} className={cn(layoutClassName)} />;
}

// ---------------------------------------------------------------------------
// Trigger — the header button. Renders a trailing auto-rotating chevron unless
// `hideChevron` is set (for consumers that place their own indicator).
// ---------------------------------------------------------------------------

type CollapsibleTriggerProps = Omit<
  React.ComponentProps<typeof RadixCollapsible.Trigger>,
  "className" | "style"
> & {
  /** Suppress the built-in trailing chevron. */
  hideChevron?: boolean;
  /** External-geometry utilities only; appended after appearance. */
  layoutClassName?: string;
};

export function CollapsibleTrigger({
  hideChevron = false,
  asChild = false,
  layoutClassName,
  children,
  ...rest
}: CollapsibleTriggerProps): React.JSX.Element {
  // Unstyled escape hatch: the consumer's single child element owns the entire
  // appearance (and any expand/collapse indicator); Radix's Slot merges the
  // disclosure behaviour — aria-expanded/controls, data-state, native button
  // semantics — onto it. The baked recipe and the injected chevron are omitted
  // so they cannot pollute the child (the chevron would also break Slot's
  // single-child requirement). Only the layout-only escape hatch is forwarded.
  if (asChild) {
    return (
      <RadixCollapsible.Trigger
        {...rest}
        asChild
        className={cn(layoutClassName)}
      >
        {children}
      </RadixCollapsible.Trigger>
    );
  }
  return (
    <RadixCollapsible.Trigger
      {...rest}
      className={cn(disclosureTriggerBase, layoutClassName)}
    >
      {children}
      {!hideChevron && (
        <ChevronDownIcon size={14} className={disclosureChevron} />
      )}
    </RadixCollapsible.Trigger>
  );
}

// ---------------------------------------------------------------------------
// Content — the revealed region (mounted only while open).
// ---------------------------------------------------------------------------

type CollapsibleContentProps = Omit<
  React.ComponentProps<typeof RadixCollapsible.Content>,
  "className" | "style"
> & {
  /** External-geometry utilities only; appended after appearance. */
  layoutClassName?: string;
};

export function CollapsibleContent({
  asChild = false,
  layoutClassName,
  ...rest
}: CollapsibleContentProps): React.JSX.Element {
  // Unstyled escape hatch: the consumer's region element owns its appearance
  // (and any reveal motion); the baked fade recipe is dropped so it cannot
  // pollute the child. Radix still mounts/unmounts the region with the section.
  if (asChild) {
    return (
      <RadixCollapsible.Content
        {...rest}
        asChild
        className={cn(layoutClassName)}
      />
    );
  }
  return (
    <RadixCollapsible.Content
      {...rest}
      className={cn(disclosureContentMotion, layoutClassName)}
    />
  );
}
