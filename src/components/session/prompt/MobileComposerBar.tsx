"use client";

import { cn } from "@/lib/ui/cn";

export interface MobileComposerBarProps {
  placeholder: string;
  /** Expand the full composer and focus the editor. */
  onExpand: () => void;
  disabled?: boolean;
}

// Collapsed idle form of the mobile prompt composer: a single 44px affordance
// standing in for the editor + toolbar when the composer is empty and
// unfocused, so reading the conversation owns the screen. Tapping it expands
// the real composer and focuses the editor.
export default function MobileComposerBar({
  placeholder,
  onExpand,
  disabled,
}: MobileComposerBarProps): React.JSX.Element {
  return (
    <button
      type="button"
      className={cn(
        "flex min-h-[44px] w-full cursor-text appearance-none items-center gap-sm rounded-md border border-solid border-border-default bg-bg-surface px-[14px] py-0 text-left font-mono text-[0.85rem] text-text-tertiary transition-colors duration-150",
        disabled
          ? "cursor-not-allowed opacity-60"
          : "hover:border-cyan-dim hover:text-text-secondary",
      )}
      onClick={onExpand}
      disabled={disabled}
      aria-label="Expand composer"
    >
      <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap">
        {placeholder}
      </span>
      <span
        className="flex-none text-[0.9rem] leading-none text-text-tertiary"
        aria-hidden="true"
      >
        ▶
      </span>
    </button>
  );
}
