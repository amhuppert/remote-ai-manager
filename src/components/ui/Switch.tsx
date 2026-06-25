"use client";

import { Switch as RadixSwitch } from "radix-ui";
import { cn } from "@/lib/ui/cn";

// Radix-backed binary on/off control (WAI-ARIA APG "Switch" pattern:
// https://www.w3.org/WAI/ARIA/apg/patterns/switch/). Radix owns behaviour
// (role="switch" + aria-checked, Space/Enter toggle, controlled/uncontrolled
// state, hidden form input via name/value); this wrapper owns CC appearance —
// the track + sliding knob — via data-[state=checked|unchecked] variants.
//
// Appearance is closed: parts accept no className/style. The only escape hatch
// is layoutClassName (external geometry: margin, self-align, order, width/basis,
// responsive hidden — never colour/bg/border/radius/shadow/padding), appended
// last. size + tone cover the dimensions/colours of the audited switch-like
// consumers (TddToggle, AgentCapabilityPanel row, McpServerCard).

type SwitchSize = "compact" | "sm" | "md";
type SwitchTone = "cyan" | "green";

// Track. Off-state and the canonical cyan focus-visible outline are shared;
// the on-state glow is tone-specific so each tone declares its own
// border/bg/shadow trio (no two utilities target one property unconditionally).
const TRACK_BASE = cn(
  "group relative inline-flex shrink-0 cursor-pointer items-center rounded-full",
  "border border-solid transition-all duration-150 outline-none",
  "disabled:cursor-not-allowed disabled:opacity-45",
  "focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:outline-offset-2",
  "data-[state=unchecked]:border-border-default data-[state=unchecked]:bg-bg-raised",
);

const TRACK_TONE: Record<SwitchTone, string> = {
  cyan: cn(
    "data-[state=checked]:border-cyan data-[state=checked]:bg-cyan-glow",
    "data-[state=checked]:shadow-[0_0_8px_var(--cyan-glow)]",
  ),
  green: cn(
    "data-[state=checked]:border-green data-[state=checked]:bg-green-dim",
    "data-[state=checked]:shadow-[0_0_8px_var(--green-glow)]",
  ),
};

const TRACK_SIZE: Record<SwitchSize, string> = {
  md: "h-[18px] w-[34px]",
  sm: "h-[16px] w-[32px]",
  compact: "h-[12px] w-[22px]",
};

// Knob. Movement is an arbitrary `transform` utility (NOT Tailwind translate-x-*,
// which v4 emits as the separate `translate` property) so it animates under the
// `transition: transform` declared in the base — reduced motion snaps instantly.
const KNOB_BASE = cn(
  "pointer-events-none absolute rounded-full bg-text-tertiary",
  "[transition:transform_0.15s_cubic-bezier(0.4,0,0.2,1),background_0.15s_ease]",
  "motion-reduce:transition-none",
  "data-[state=checked]:bg-white",
);

const KNOB_SIZE: Record<SwitchSize, string> = {
  md: "left-px top-px h-[14px] w-[14px] data-[state=checked]:[transform:translateX(16px)]",
  sm: "left-[2px] top-px h-[12px] w-[12px] data-[state=checked]:[transform:translateX(16px)]",
  compact:
    "left-px top-px h-[8px] w-[8px] data-[state=checked]:[transform:translateX(10px)]",
};

export interface SwitchProps extends Omit<
  React.ComponentProps<typeof RadixSwitch.Root>,
  "className" | "style" | "asChild" | "children"
> {
  /** Track + knob dimensions. Defaults to `md`. */
  size?: SwitchSize;
  /** On-state accent glow. Defaults to `cyan`. */
  tone?: SwitchTone;
  /** External geometry only (margin/align/order/width/hidden) — never appearance. */
  layoutClassName?: string;
}

export function Switch({
  size = "md",
  tone = "cyan",
  layoutClassName,
  ...props
}: SwitchProps): React.JSX.Element {
  return (
    <RadixSwitch.Root
      className={cn(
        TRACK_BASE,
        TRACK_TONE[tone],
        TRACK_SIZE[size],
        layoutClassName,
      )}
      {...props}
    >
      <RadixSwitch.Thumb className={cn(KNOB_BASE, KNOB_SIZE[size])} />
    </RadixSwitch.Root>
  );
}
