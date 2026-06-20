"use client";

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

// The default and compact variants override most box properties (padding, gap,
// radius, font, height, margin), so their utilities are partitioned into
// mutually-exclusive per-variant maps — never layered on a shared base — so no
// two applied utilities target the same property on one element (the cascade
// between same-property utilities is sort-order dependent; the compact variant
// breaks if base values leak through). Same partition for track + knob dims.
//
// Custom-alpha greens with no existing token (0.25 / 0.4 / 0.06 / 0.5) are kept
// as exact inline values to preserve parity; flagged for token extraction in the
// Stage B-2 integration context. 0.15 → --green-glow, 0.3 → --cc-green-border.
const rootShared =
  "group inline-flex items-center bg-transparent border border-solid border-border-subtle cursor-pointer " +
  "font-mono text-text-tertiary transition-[border-color,color,background] duration-150 ease-[ease] " +
  "disabled:opacity-40 disabled:cursor-not-allowed " +
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

const trackShared =
  "relative inline-block bg-bg-raised border border-solid border-border-default shrink-0 " +
  "transition-[background,border-color,box-shadow] duration-200 ease-[ease] " +
  "group-data-[on=true]:bg-green-dim group-data-[on=true]:border-green " +
  "group-data-[on=true]:[box-shadow:0_0_8px_var(--green-glow),0_0_2px_var(--cc-green-border)]";

const trackDefault = "w-[32px] h-[16px] rounded-[8px]";
const trackCompact = "w-[22px] h-[12px] rounded-[999px]";

const knobShared =
  "absolute top-[1px] rounded-full bg-text-tertiary " +
  "[transition:transform_0.2s_cubic-bezier(0.4,0,0.2,1),background_0.2s_ease,box-shadow_0.2s_ease] " +
  "group-data-[on=true]:bg-white group-data-[on=true]:[box-shadow:var(--cc-tdd-knob-glow)]";

// Movement is an arbitrary `transform` property (NOT Tailwind `translate-x-*`,
// which v4 emits as the CSS `translate` property) so the knob animates under the
// preserved `transition: transform …` — matching the legacy slide exactly.
const knobDefault =
  "w-[12px] h-[12px] left-[2px] group-data-[on=true]:[transform:translateX(16px)]";
const knobCompact =
  "w-[8px] h-[8px] left-[1px] group-data-[on=true]:[transform:translateX(10px)]";

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
  return (
    <button
      type="button"
      className={cn(
        rootShared,
        hostOverrides,
        compact ? rootCompact : rootDefault,
      )}
      data-on={enabled}
      onClick={(e) => {
        e.stopPropagation();
        if (!disabled) onChange(!enabled);
      }}
      disabled={disabled}
      data-tooltip={
        compact
          ? enabled
            ? "Red-green TDD enabled (click to disable)"
            : "Red-green TDD disabled (click to enable)"
          : undefined
      }
      aria-pressed={enabled}
      aria-label="Toggle red-green TDD"
    >
      <span
        className={cn(trackShared, compact ? trackCompact : trackDefault)}
        aria-hidden="true"
      >
        <span className={cn(knobShared, compact ? knobCompact : knobDefault)} />
      </span>
      <span className={labelClass}>{compact ? "TDD" : "Red-green TDD"}</span>
    </button>
  );
}
