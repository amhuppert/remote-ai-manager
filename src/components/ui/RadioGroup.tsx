"use client";

import { useId } from "react";
import { RadioGroup as RadixRadioGroup } from "radix-ui";
import { cn } from "@/lib/ui/cn";

// Radix-backed radio-group primitive (WAI-ARIA APG "Radio Group" pattern:
// https://www.w3.org/WAI/ARIA/apg/patterns/radio/). Radix owns the behaviour —
// `role="radiogroup"`/`radio`, `aria-checked`, roving tabindex with arrow-key
// navigation that wraps and skips disabled items, the single-selection
// invariant, label association and form participation — and these wrappers own
// CC appearance via Radix's `data-state` (`checked`/`unchecked`) and
// `data-disabled` attributes. Parts omit `className`/`style`; the only escape
// hatch is the layout-only `layoutClassName` (docs/tailwind-conventions.md §2).
// This is the classic radio-list presentation (a circle + dot per option). For
// the horizontal exclusive-choice button row, use `SegmentedControl`, which is
// built on the same Radix `RadioGroup` (NOT Tabs — a value picker, not a panel
// switcher; see the migration contract §7/§10).

// The list stacks vertically by default; override placement via `layoutClassName`.
const rootClass = "grid gap-sm";

// The control: a 16px circle that gains a cyan ring when selected. The selected
// inner dot is rendered by the indicator (which mounts only while checked).
const itemClass = cn(
  "relative inline-flex size-[16px] shrink-0 cursor-pointer items-center justify-center rounded-full border border-solid border-border-default bg-bg-base transition-all duration-[120ms] ease-[ease] outline-none",
  "hover:border-cyan-dim",
  "data-[state=checked]:border-cyan",
  "focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:[outline-offset:2px]",
  "data-[disabled]:cursor-not-allowed data-[disabled]:opacity-40",
);
const indicatorClass = "inline-flex size-[6px] rounded-full bg-cyan";

type RadioGroupProps = Omit<
  React.ComponentProps<typeof RadixRadioGroup.Root>,
  "className" | "style"
> & {
  /** External-geometry utilities only; appended after appearance. */
  layoutClassName?: string;
};

export function RadioGroup({
  layoutClassName,
  ...rest
}: RadioGroupProps): React.JSX.Element {
  return (
    <RadixRadioGroup.Root
      {...rest}
      className={cn(rootClass, layoutClassName)}
    />
  );
}

type RadioGroupItemProps = Omit<
  React.ComponentProps<typeof RadixRadioGroup.Item>,
  "className" | "style"
> & {
  /** External-geometry utilities only; appended after appearance. */
  layoutClassName?: string;
};

export function RadioGroupItem({
  layoutClassName,
  ...rest
}: RadioGroupItemProps): React.JSX.Element {
  return (
    <RadixRadioGroup.Item {...rest} className={cn(itemClass, layoutClassName)}>
      <RadixRadioGroup.Indicator className={indicatorClass} />
    </RadixRadioGroup.Item>
  );
}

// ---------------------------------------------------------------------------
// RadioGroupOption — labelled convenience: a radio control paired with a
// clickable mono label and an optional muted description. Wires `htmlFor`/`id`
// so the whole label selects the option and the description is announced via
// `aria-describedby`.
// ---------------------------------------------------------------------------

type RadioGroupOptionProps = RadioGroupItemProps & {
  /** Visible, clickable label text. */
  label: React.ReactNode;
  /** Optional muted helper line under the label. */
  description?: React.ReactNode;
  /** Override the generated id used to wire the label + control. */
  id?: string;
};

export function RadioGroupOption({
  label,
  description,
  id,
  layoutClassName,
  "aria-describedby": ariaDescribedBy,
  ...rest
}: RadioGroupOptionProps): React.JSX.Element {
  const generatedId = useId();
  const generatedDescId = useId();
  const itemId = id ?? generatedId;
  const descId = description ? generatedDescId : undefined;
  const describedBy =
    [descId, ariaDescribedBy].filter(Boolean).join(" ") || undefined;

  return (
    <div className={cn("flex items-start gap-sm", layoutClassName)}>
      <RadioGroupItem
        id={itemId}
        aria-describedby={describedBy}
        layoutClassName="mt-[1px]"
        {...rest}
      />
      <div className="flex min-w-0 flex-col gap-[2px]">
        <label
          htmlFor={itemId}
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
