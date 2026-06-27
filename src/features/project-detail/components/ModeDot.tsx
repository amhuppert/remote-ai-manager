"use client";

import type { SessionCreationMode } from "@/lib/sessions/schemas";
import { cn } from "@/lib/ui/cn";
type ModeKey = SessionCreationMode | "merged";

const MODE_LABEL: Record<ModeKey, string> = {
  normal: "N",
  optimistic: "O",
  merged: "✓",
};

const MODE_TITLE: Record<ModeKey, string> = {
  normal: "Normal session",
  optimistic: "Optimistic session",
  merged: "Merged to target",
};

const dotBase =
  "inline-flex items-center justify-center size-[14px] shrink-0 rounded-[3px] border border-solid font-mono text-[0.56rem] font-bold leading-none cursor-help";

// border tone keyed by mode.
const dotColor: Record<ModeKey, string> = {
  normal: "text-amber bg-amber-glow border-[var(--cc-amber-a30)]",
  optimistic: "text-green bg-green-glow border-[var(--cc-green-border)]",
  merged: "text-green bg-green-glow border-[var(--cc-green-border)]",
};

interface ModeDotProps {
  mode: ModeKey | null | undefined;
  /** External-geometry utilities only; appended after appearance. */
  layoutClassName?: string;
}

export default function ModeDot({
  mode,
  layoutClassName,
}: ModeDotProps): React.JSX.Element {
  if (!mode) {
    return (
      <span
        className={cn(
          "font-mono text-[0.68rem] text-text-tertiary",
          layoutClassName,
        )}
        aria-hidden="true"
      >
        —
      </span>
    );
  }
  return (
    <span
      className={cn(dotBase, dotColor[mode], layoutClassName)}
      title={MODE_TITLE[mode]}
    >
      {MODE_LABEL[mode]}
    </span>
  );
}
