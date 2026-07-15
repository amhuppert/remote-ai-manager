"use client";

import {
  TooltipProvider,
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "./Tooltip";

// Convenience composition for the overwhelmingly common tooltip shape: one
// trigger element that reveals a short text label on hover/focus. It exists so
// call sites migrating off the legacy `data-tooltip` attribute do not have to
// re-scaffold the Root/Trigger/Content triad by hand each time — the same
// ergonomic role the old attribute served, now on the Radix primitive (keyboard
// focus reveal, Escape/blur dismissal, collision-aware positioning, and the
// `role="tooltip"` + `aria-describedby` wiring the attribute never provided).
//
// `label` may be nullish/empty — when so, the child renders bare with no tooltip
// (parity with the legacy conditional-attribute sites that passed `undefined` to
// suppress the hint). The child must be a single element that forwards ref/props:
// Radix merges the trigger onto it via `asChild`.
//
// It carries its own `TooltipProvider` so a single migrated call site is
// self-contained — it works with no app-root provider in scope (unit tests,
// isolated stories) and is harmless under the app-root provider (Radix allows
// nesting; the nearest provider governs its subtree's open delay).
type ContentSide = React.ComponentProps<typeof TooltipContent>["side"];

export function WithTooltip({
  label,
  side,
  sideOffset,
  children,
}: {
  /** Tooltip text; nullish/empty renders the child with no tooltip. */
  label: React.ReactNode;
  side?: ContentSide;
  sideOffset?: number;
  /** A single element that accepts a forwarded ref (Radix `asChild` target). */
  children: React.ReactElement;
}): React.JSX.Element {
  if (
    label === null ||
    label === undefined ||
    label === false ||
    label === ""
  ) {
    return children;
  }
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>{children}</TooltipTrigger>
        <TooltipContent side={side} sideOffset={sideOffset}>
          {label}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
