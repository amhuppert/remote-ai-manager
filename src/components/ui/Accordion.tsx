"use client";

import { Accordion as RadixAccordion } from "radix-ui";
import { ChevronDownIcon } from "@/components/icons";
import { cn } from "@/lib/ui/cn";
import {
  disclosureTriggerBase,
  disclosureChevron,
  disclosureContentMotion,
} from "./disclosure-recipe";

// Radix-backed accordion primitive (WAI-ARIA APG "Accordion" pattern:
// https://www.w3.org/WAI/ARIA/apg/patterns/accordion/). Radix owns the
// behaviour — roving focus across headers (Up/Down/Home/End), Enter/Space
// toggle, `single` vs `multiple` open semantics, `aria-expanded`/`aria-controls`
// + `region` wiring, `data-state`/`data-disabled`, mount/unmount of panels — and
// these wrappers own CC appearance via the shared disclosure recipe
// (`disclosure-recipe.ts`, also used by `Collapsible`). Parts omit
// `className`/`style`, exposing only the layout-only `layoutClassName` escape
// hatch (docs/tailwind-conventions.md §2).
//
// A structurally-bespoke consumer (e.g. a timeline rail with a CSS-grid header,
// or a flat borderless group list) passes `asChild` on any part — root, item,
// trigger, content — to adopt its own element: Radix keeps roving focus, single-
// vs-multiple semantics, aria wiring and mount/unmount, while the baked card /
// hairline / trigger recipe + injected chevron are dropped so they cannot
// pollute the consumer's element.
//
// Use Accordion for a STACK of expandable sections that share roving focus and
// (optionally) a one-open-at-a-time rule (`type="single"`). For a single
// standalone show/hide region, use `Collapsible`. Like Collapsible, an accordion
// is in-flow content, not a floating overlay (no overlay-scope registration).

// Grouped-section container: a bordered card whose items divide with a hairline.
const accordionRoot =
  "flex flex-col overflow-hidden rounded-md border border-solid border-border-subtle bg-bg-surface";

// Each section after the first is separated by a top hairline.
const accordionItem =
  "border-x-0 border-t border-b-0 border-solid border-border-subtle first:border-t-0";

// Radix `Accordion.Root` is a discriminated union over `type` (single |
// multiple), each arm carrying its own `value`/`defaultValue`/`onValueChange`
// shape. A plain `Omit` collapses a union to its shared keys, dropping those
// per-arm props — distribute the omit across each arm to preserve the union.
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
  ? Omit<T, K>
  : never;

// ---------------------------------------------------------------------------
// Root
// ---------------------------------------------------------------------------

type AccordionProps = DistributiveOmit<
  React.ComponentProps<typeof RadixAccordion.Root>,
  "className" | "style"
> & {
  /** External-geometry utilities only; appended after appearance. */
  layoutClassName?: string;
};

export function Accordion({
  layoutClassName,
  ...rest
}: AccordionProps): React.JSX.Element {
  // The union arms both carry `asChild`; read it without narrowing the union.
  if (rest.asChild) {
    return <RadixAccordion.Root {...rest} className={cn(layoutClassName)} />;
  }
  return (
    <RadixAccordion.Root
      {...rest}
      className={cn(accordionRoot, layoutClassName)}
    />
  );
}

// ---------------------------------------------------------------------------
// Item
// ---------------------------------------------------------------------------

type AccordionItemProps = Omit<
  React.ComponentProps<typeof RadixAccordion.Item>,
  "className" | "style"
> & {
  /** External-geometry utilities only; appended after appearance. */
  layoutClassName?: string;
};

export function AccordionItem({
  asChild = false,
  layoutClassName,
  ...rest
}: AccordionItemProps): React.JSX.Element {
  if (asChild) {
    return (
      <RadixAccordion.Item {...rest} asChild className={cn(layoutClassName)} />
    );
  }
  return (
    <RadixAccordion.Item
      {...rest}
      className={cn(accordionItem, layoutClassName)}
    />
  );
}

// ---------------------------------------------------------------------------
// Trigger — wrapped in the required `Accordion.Header` (the APG heading button).
// Renders a trailing auto-rotating chevron unless `hideChevron` is set.
// ---------------------------------------------------------------------------

type AccordionTriggerProps = Omit<
  React.ComponentProps<typeof RadixAccordion.Trigger>,
  "className" | "style"
> & {
  /** Suppress the built-in trailing chevron. */
  hideChevron?: boolean;
  /** External-geometry utilities only; appended after appearance. */
  layoutClassName?: string;
};

export function AccordionTrigger({
  hideChevron = false,
  asChild = false,
  layoutClassName,
  children,
  ...rest
}: AccordionTriggerProps): React.JSX.Element {
  // The trigger stays inside the required `Accordion.Header` (the APG heading
  // wrapper) either way. With `asChild` the consumer's single child element
  // becomes the heading button — Radix wires aria-expanded/controls + data-state
  // onto it — and the baked recipe + chevron are dropped so they cannot pollute
  // it (a CSS-grid header button supplies its own layout). Only the layout-only
  // escape hatch is forwarded.
  if (asChild) {
    return (
      <RadixAccordion.Header className="flex">
        <RadixAccordion.Trigger
          {...rest}
          asChild
          className={cn(layoutClassName)}
        >
          {children}
        </RadixAccordion.Trigger>
      </RadixAccordion.Header>
    );
  }
  return (
    <RadixAccordion.Header className="flex">
      <RadixAccordion.Trigger
        {...rest}
        className={cn(disclosureTriggerBase, layoutClassName)}
      >
        {children}
        {!hideChevron && (
          <ChevronDownIcon size={14} className={disclosureChevron} />
        )}
      </RadixAccordion.Trigger>
    </RadixAccordion.Header>
  );
}

// ---------------------------------------------------------------------------
// Content — the revealed panel (mounted only while its section is open).
// ---------------------------------------------------------------------------

type AccordionContentProps = Omit<
  React.ComponentProps<typeof RadixAccordion.Content>,
  "className" | "style"
> & {
  /** External-geometry utilities only; appended after appearance. */
  layoutClassName?: string;
};

export function AccordionContent({
  asChild = false,
  layoutClassName,
  ...rest
}: AccordionContentProps): React.JSX.Element {
  // Unstyled escape hatch: the consumer's panel element owns its appearance; the
  // baked fade recipe is dropped. Radix still mounts/unmounts it with the section.
  if (asChild) {
    return (
      <RadixAccordion.Content
        {...rest}
        asChild
        className={cn(layoutClassName)}
      />
    );
  }
  return (
    <RadixAccordion.Content
      {...rest}
      className={cn(disclosureContentMotion, layoutClassName)}
    />
  );
}
