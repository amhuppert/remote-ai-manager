"use client";

import type { SessionCreationMode } from "@/lib/sessions/schemas";
type ModeKey = SessionCreationMode | "merged";

const MODE_LABEL: Record<ModeKey, string> = {
  fast: "F",
  focus: "★",
  optimistic: "O",
  merged: "✓",
};

const MODE_TITLE: Record<ModeKey, string> = {
  fast: "Fast session (no plan)",
  focus: "Focus session",
  optimistic: "Optimistic session",
  merged: "Merged to target",
};

interface ModeDotProps {
  mode: ModeKey | null | undefined;
}

export default function ModeDot({ mode }: ModeDotProps): React.JSX.Element {
  if (!mode) {
    return (
      <span
        style={{
          color: "var(--text-tertiary)",
          fontFamily: "var(--font-mono)",
          fontSize: ".68rem",
        }}
        aria-hidden="true"
      >
        —
      </span>
    );
  }
  return (
    <span className="s-mode-dot" data-mode={mode} title={MODE_TITLE[mode]}>
      {MODE_LABEL[mode]}
    </span>
  );
}
