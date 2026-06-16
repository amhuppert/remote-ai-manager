import type { HTMLAttributes } from "react";
import { cn } from "@/lib/ui/cn";

export type StatusDotTone = "green" | "cyan" | "amber" | "warning";

// `inline-block` is added deliberately: the legacy `.status-dot` sets no
// `display` and relies on being blockified inside a flex row to honour its 7px
// box. `inline-block` makes the dot render its box in any context with no change
// to the (flex-context) parity baseline. The pulse animation is unconditional —
// legacy `.status-dot` has no `prefers-reduced-motion` override, so neither does
// this primitive (parity).
const base = "inline-block size-[7px] rounded-full animate-pulse-dot";

const toneClass: Record<StatusDotTone, string> = {
  green:
    "bg-green shadow-[0_0_8px_var(--color-green-glow),0_0_3px_var(--color-green)]",
  cyan: "bg-cyan shadow-[0_0_8px_var(--color-cyan-glow),0_0_3px_var(--color-cyan)]",
  amber:
    "bg-amber shadow-[0_0_8px_var(--color-amber-glow),0_0_3px_var(--color-amber)]",
  warning:
    "bg-amber shadow-[0_0_8px_var(--color-amber-glow),0_0_3px_var(--color-amber)]",
};

export type StatusDotProps = Omit<
  HTMLAttributes<HTMLSpanElement>,
  "className" | "style"
> & {
  tone?: StatusDotTone;
  /** External-geometry utilities only; appended after appearance. */
  layoutClassName?: string;
};

export function StatusDot({
  tone = "green",
  layoutClassName,
  ...rest
}: StatusDotProps) {
  return (
    <span
      {...rest}
      data-tone={tone}
      className={cn(base, toneClass[tone], layoutClassName)}
    />
  );
}
