"use client";

import type { DerivedSessionStatus } from "@/lib/sessions/schemas";
import { cn } from "@/lib/ui/cn";
type StatusPillStatus = DerivedSessionStatus | "merged" | "error";

interface StatusPillProps {
  status: StatusPillStatus;
  /** External-geometry utilities only; appended after appearance. */
  layoutClassName?: string;
}

function displayLabel(status: StatusPillStatus): string {
  // "waiting_for_input" surfaces in the UI as "awaiting"; the data-status stays raw.
  if (status === "waiting_for_input") return "awaiting";
  return status;
}

const wrapperBase =
  "inline-flex items-center gap-[6px] font-mono text-[0.7rem] font-semibold uppercase tracking-[0.06em]";

// Appearance keyed by the status union (not a data-* variant): the
// `waiting_for_input` value contains an underscore, which Tailwind's
// `data-[status=…]` variant rewrites to a space in the selector — a silent
// mismatch. A static map keyed by the union sidesteps it.
const wrapperColor: Record<StatusPillStatus, string> = {
  new: "text-cyan",
  running: "text-cyan",
  awaiting: "text-green",
  waiting_for_input: "text-amber",
  merged: "text-green",
  idle: "text-text-secondary",
  error: "text-red",
};

const dotBase = "size-[6px] rounded-full shrink-0";
const dotColor: Record<StatusPillStatus, string> = {
  new: "bg-cyan shadow-[0_0_6px_var(--color-cyan-glow)] animate-[pulse-dot_1.8s_ease_infinite]",
  running:
    "bg-cyan shadow-[0_0_6px_var(--color-cyan-glow)] animate-[pulse-dot_1.5s_ease_infinite]",
  awaiting: "bg-green shadow-[0_0_6px_var(--color-green-glow)]",
  waiting_for_input:
    "bg-amber shadow-[0_0_6px_var(--color-amber-glow)] animate-[pulse-dot_2s_ease_infinite]",
  merged: "bg-green shadow-[0_0_6px_var(--color-green-glow)]",
  idle: "bg-text-tertiary",
  error: "bg-red shadow-[0_0_6px_var(--color-red-glow)]",
};

export default function StatusPill({
  status,
  layoutClassName,
}: StatusPillProps): React.JSX.Element {
  return (
    <span
      className={cn(wrapperBase, wrapperColor[status], layoutClassName)}
      data-status={status}
    >
      <span className={cn(dotBase, dotColor[status])} />
      <span>{displayLabel(status)}</span>
    </span>
  );
}
