"use client";

import { useId } from "react";
import { Checkbox as RadixCheckbox } from "radix-ui";
import { CheckIcon } from "@/components/icons";
import { cn } from "@/lib/ui/cn";

// Radix-backed checkbox primitive (WAI-ARIA APG "Checkbox" pattern:
// https://www.w3.org/WAI/ARIA/apg/patterns/checkbox/). Radix owns the behaviour —
// `role="checkbox"`, `aria-checked` (incl. `mixed` for indeterminate), Space-to-
// toggle, label association, form participation — and this wrapper owns CC
// appearance via Radix's own `data-state` (`checked`/`unchecked`/`indeterminate`)
// and `data-disabled` attributes. Parts omit `className`/`style`; the only escape
// hatch is the layout-only `layoutClassName` (docs/tailwind-conventions.md §2).
// Reproduces the deleted `.cc-checkbox` recipe: a 16px box that fills cyan when
// checked/indeterminate, with a check glyph or an indeterminate dash.

const boxClass = cn(
  "group inline-flex size-[16px] shrink-0 cursor-pointer items-center justify-center rounded-[3px] border border-solid border-border-default bg-bg-base transition-all duration-[120ms] ease-[ease] outline-none",
  "hover:border-cyan-dim",
  "data-[state=checked]:border-cyan data-[state=checked]:bg-cyan",
  "data-[state=indeterminate]:border-cyan data-[state=indeterminate]:bg-cyan",
  "focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:[outline-offset:2px]",
  "data-[disabled]:cursor-not-allowed data-[disabled]:opacity-40",
);

// The indicator mounts only while checked or indeterminate. The two glyphs are
// gated on the Root's `data-state` (read through the `group`) so a single static
// class string covers both: the check for `checked`, the flat dash for
// `indeterminate`. The dash is a token-backed bar, not a drawn pseudo-element.
const indicatorClass =
  "inline-flex items-center justify-center text-text-inverse";

type CheckboxProps = Omit<
  React.ComponentProps<typeof RadixCheckbox.Root>,
  "className" | "style"
> & {
  /** External-geometry utilities only; appended after appearance. */
  layoutClassName?: string;
};

export function Checkbox({
  layoutClassName,
  ...rest
}: CheckboxProps): React.JSX.Element {
  return (
    <RadixCheckbox.Root {...rest} className={cn(boxClass, layoutClassName)}>
      <RadixCheckbox.Indicator className={indicatorClass}>
        <CheckIcon
          size={12}
          className="hidden group-data-[state=checked]:block"
        />
        <span className="hidden h-[1.6px] w-[8px] rounded-full bg-text-inverse group-data-[state=indeterminate]:block" />
      </RadixCheckbox.Indicator>
    </RadixCheckbox.Root>
  );
}

// ---------------------------------------------------------------------------
// CheckboxField — labelled convenience: pairs a Checkbox with a clickable mono
// label and an optional muted description, wiring `htmlFor`/`id` so the whole
// label toggles the box and the description is announced via `aria-describedby`.
// ---------------------------------------------------------------------------

type CheckboxFieldProps = CheckboxProps & {
  /** Visible, clickable label text. */
  label: React.ReactNode;
  /** Optional muted helper line under the label. */
  description?: React.ReactNode;
  /** Override the generated id used to wire the label + box. */
  id?: string;
};

export function CheckboxField({
  label,
  description,
  id,
  layoutClassName,
  "aria-describedby": ariaDescribedBy,
  ...rest
}: CheckboxFieldProps): React.JSX.Element {
  const generatedId = useId();
  const generatedDescId = useId();
  const boxId = id ?? generatedId;
  const descId = description ? generatedDescId : undefined;
  const describedBy =
    [descId, ariaDescribedBy].filter(Boolean).join(" ") || undefined;

  return (
    <div className={cn("flex items-start gap-sm", layoutClassName)}>
      <Checkbox id={boxId} aria-describedby={describedBy} {...rest} />
      <div className="flex min-w-0 flex-col gap-[2px]">
        <label
          htmlFor={boxId}
          className="cursor-pointer font-mono text-[0.78rem] text-text-primary"
        >
          {label}
        </label>
        {description != null && (
          <span
            id={descId}
            className="font-mono text-[0.7rem] text-text-tertiary"
          >
            {description}
          </span>
        )}
      </div>
    </div>
  );
}
