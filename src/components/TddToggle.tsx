"use client";

import { Switch } from "@/components/ui/Switch";
import { WithTooltip } from "@/components/ui/WithTooltip";
import { cn } from "@/lib/ui/cn";

interface TddToggleProps {
  /** Whether TDD mode is enabled */
  enabled: boolean;
  /** Callback when toggle is clicked */
  onChange: (enabled: boolean) => void;
  /** Whether the toggle is disabled (e.g. during mutation) */
  disabled?: boolean;
  /** Compact mode for info strips — omits label, shows just the switch + "TDD" */
  compact?: boolean;
}

// The pill chrome (border, padding, hover, green-on label colour) lives on this
// container; the track + sliding knob are the Radix-backed `Switch` primitive
// (role="switch" + native Space/Enter, green tone). The default and compact
// variants override most box properties (padding, gap, radius, font, height,
// margin), so their utilities are partitioned into mutually-exclusive per-variant
// maps — never layered on a shared base — so no two applied utilities target the
// same property (the cascade between same-property utilities is sort-order
// dependent; the compact variant breaks if base values leak through).
const rootShared =
  "inline-flex items-center bg-transparent border border-solid border-border-subtle cursor-pointer " +
  "font-mono text-text-tertiary transition-[border-color,color,background] duration-150 ease-[ease] " +
  "data-[disabled]:opacity-40 data-[disabled]:cursor-not-allowed data-[disabled]:[&_*]:cursor-not-allowed " +
  "data-[on=false]:hover:border-border-default data-[on=false]:hover:text-text-secondary data-[on=false]:hover:bg-bg-hover " +
  "data-[on=true]:[border-color:var(--cc-tdd-border)] data-[on=true]:text-green " +
  "data-[on=true]:hover:[border-color:var(--cc-tdd-border-hover)] data-[on=true]:hover:[background-color:var(--cc-tdd-bg-hover)]";

// Descendant overrides that previously lived as legacy `.parent .tdd-toggle`
// rules in regions outside this component (mobile action sheet, topbar, session
// row). Reattached onto the migrated element via arbitrary parent variants so no
// legacy rule is left half-owning it (conventions §1.3 / §8.2).
const hostOverrides =
  "[.mobile-action-tdd-row_&]:mt-0 [.mobile-action-tdd-row_&]:border-0 " +
  "[.mobile-action-tdd-row_&]:py-[4px] [.mobile-action-tdd-row_&]:px-0 [.mobile-action-tdd-row_&]:flex-1 " +
  "max-768:[.topbar-status-session_&]:hidden max-768:[.v3-row_&]:hidden";

const rootDefault =
  "gap-sm rounded-md py-[6px] px-[12px] text-[0.72rem] font-medium mt-md";
const rootCompact =
  "gap-[6px] rounded-[999px] h-[22px] py-0 px-[8px] text-[0.7rem] font-semibold uppercase tracking-[0.06em] mt-0";

const labelClass = "whitespace-nowrap";

/**
 * Toggle switch for Red-Green TDD methodology.
 *
 * Two variants:
 * - **Default**: Full row with switch + "Red-green TDD" label (for modals)
 * - **Compact**: Small inline button with switch + "TDD" label (for info strips / tables)
 */
export default function TddToggle({
  enabled,
  onChange,
  disabled = false,
  compact = false,
}: TddToggleProps): React.JSX.Element {
  // The visible pill (border + padding + gap) stays clickable as one target, as
  // the legacy single-button control was. The Radix `Switch` is the real focusable
  // accessible control (role="switch", native Space/Enter); the wrapper adds a
  // redundant pointer affordance over its padding/label. The Switch stops click
  // propagation so a direct hit toggles once via `onCheckedChange` instead of also
  // firing the wrapper handler; clicks anywhere else on the pill (padding, border,
  // label) bubble to the wrapper. Both paths `stopPropagation` so an embedding row
  // (e.g. a session row) is not activated by toggling TDD.
  const toggle = (): void => {
    if (!disabled) onChange(!enabled);
  };
  const tooltip = compact
    ? enabled
      ? "Red-green TDD enabled (click to disable)"
      : "Red-green TDD disabled (click to enable)"
    : null;
  return (
    <WithTooltip label={tooltip}>
      <span
        className={cn(
          rootShared,
          hostOverrides,
          compact ? rootCompact : rootDefault,
        )}
        data-on={enabled}
        data-disabled={disabled || undefined}
        onClick={(e) => {
          e.stopPropagation();
          toggle();
        }}
      >
        <Switch
          tone="green"
          size={compact ? "compact" : "sm"}
          checked={enabled}
          disabled={disabled}
          aria-label="Toggle red-green TDD"
          onCheckedChange={(next) => {
            if (!disabled) onChange(next);
          }}
          onClick={(e) => e.stopPropagation()}
        />
        <span className={labelClass}>{compact ? "TDD" : "Red-green TDD"}</span>
      </span>
    </WithTooltip>
  );
}
