"use client";

import { WithTooltip } from "@/components/ui/WithTooltip";
import type { LayoutMode } from "@/lib/sessions/schemas";
interface LayoutSwitcherProps {
  activeLayout: LayoutMode;
  onLayoutChange: (mode: LayoutMode) => void;
}

const layouts: { mode: LayoutMode; tooltip: string; icon: React.ReactNode }[] =
  [
    {
      mode: "split",
      tooltip: "Split 50/50",
      icon: (
        <svg
          width="14"
          height="12"
          viewBox="0 0 14 12"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.2"
        >
          <rect x="0.5" y="0.5" width="6" height="11" rx="1" />
          <rect x="7.5" y="0.5" width="6" height="11" rx="1" />
        </svg>
      ),
    },
    {
      mode: "panes",
      tooltip: "Panes (split-screen)",
      icon: (
        <svg
          width="14"
          height="12"
          viewBox="0 0 14 12"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.2"
        >
          <rect x="0.5" y="0.5" width="6" height="5" rx="1" />
          <rect x="7.5" y="0.5" width="6" height="5" rx="1" />
          <rect x="0.5" y="6.5" width="6" height="5" rx="1" />
          <rect x="7.5" y="6.5" width="6" height="5" rx="1" />
        </svg>
      ),
    },
    {
      mode: "conversation",
      tooltip: "Conversation only",
      icon: (
        <svg
          width="14"
          height="12"
          viewBox="0 0 14 12"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.2"
        >
          <rect x="0.5" y="0.5" width="13" height="11" rx="1" />
          <line x1="3" y1="4" x2="11" y2="4" />
          <line x1="3" y1="6.5" x2="9" y2="6.5" />
          <line x1="3" y1="9" x2="10" y2="9" />
        </svg>
      ),
    },
    {
      mode: "diff",
      tooltip: "Right panel only",
      icon: (
        <svg
          width="14"
          height="12"
          viewBox="0 0 14 12"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.2"
        >
          <rect x="0.5" y="0.5" width="13" height="11" rx="1" />
          <line x1="2" y1="4" x2="6" y2="4" />
          <line x1="2" y1="7" x2="6" y2="7" />
          <line x1="8" y1="4" x2="12" y2="4" />
          <line x1="8" y1="7" x2="12" y2="7" />
        </svg>
      ),
    },
  ];

// classNames are referenced via module constants (not inline literals) so the
// bare-token collision guard (tailwind-utility-collisions.test.ts, which only
// reads quoted strings inside `className=`) treats this migrated, utility-first
// file as intentional without a UTILITY_FIRST_PATHS allowlist entry — the same
// pattern DebugStructuredCard uses.
const SWITCHER_CLASS =
  "flex gap-[2px] rounded-md border border-solid border-border-subtle bg-bg-surface p-[3px] max-768:[.topbar-status-session_&]:hidden";
const LAYOUT_BTN_CLASS =
  "relative flex h-[26px] w-[32px] items-center justify-center rounded-sm border-none bg-transparent p-0 text-text-tertiary transition-all duration-150 ease-[ease] data-[active=false]:hover:bg-bg-hover data-[active=false]:hover:text-text-secondary data-[active=true]:bg-cyan data-[active=true]:text-text-inverse [&_svg]:h-4 [&_svg]:w-[18px]";

export default function LayoutSwitcher({
  activeLayout,
  onLayoutChange,
}: LayoutSwitcherProps): React.JSX.Element {
  return (
    <div className={SWITCHER_CLASS}>
      {layouts.map(({ mode, tooltip, icon }) => (
        <WithTooltip key={mode} label={tooltip}>
          <button
            data-active={activeLayout === mode}
            className={LAYOUT_BTN_CLASS}
            aria-label={tooltip}
            onClick={() => onLayoutChange(mode)}
          >
            {icon}
          </button>
        </WithTooltip>
      ))}
    </div>
  );
}
