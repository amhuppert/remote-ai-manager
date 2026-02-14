"use client";

import type { LayoutMode } from "@/types";

interface LayoutSwitcherProps {
  activeLayout: LayoutMode;
  onLayoutChange: (mode: LayoutMode) => void;
}

const layouts: { mode: LayoutMode; tooltip: string; icon: React.ReactNode }[] =
  [
    {
      mode: "conversation",
      tooltip: "Conversation only",
      icon: (
        <svg viewBox="0 0 18 12" fill="none">
          <rect
            x="0.5"
            y="0.5"
            width="17"
            height="11"
            rx="1.5"
            fill="currentColor"
            opacity="0.9"
          />
        </svg>
      ),
    },
    {
      mode: "default",
      tooltip: "Default split",
      icon: (
        <svg viewBox="0 0 18 12" fill="none">
          <rect
            x="0.5"
            y="0.5"
            width="11"
            height="11"
            rx="1.5"
            fill="currentColor"
            opacity="0.9"
          />
          <rect
            x="13"
            y="0.5"
            width="4.5"
            height="11"
            rx="1.5"
            fill="currentColor"
            opacity="0.4"
          />
        </svg>
      ),
    },
    {
      mode: "split",
      tooltip: "50 / 50 split",
      icon: (
        <svg viewBox="0 0 18 12" fill="none">
          <rect
            x="0.5"
            y="0.5"
            width="7.5"
            height="11"
            rx="1.5"
            fill="currentColor"
            opacity="0.9"
          />
          <rect
            x="10"
            y="0.5"
            width="7.5"
            height="11"
            rx="1.5"
            fill="currentColor"
            opacity="0.9"
          />
        </svg>
      ),
    },
    {
      mode: "diff",
      tooltip: "Diff only",
      icon: (
        <svg viewBox="0 0 18 12" fill="none">
          <rect
            x="0.5"
            y="0.5"
            width="17"
            height="11"
            rx="1.5"
            fill="currentColor"
            opacity="0.4"
          />
          <line
            x1="3"
            y1="4"
            x2="15"
            y2="4"
            stroke="currentColor"
            strokeWidth="1"
            opacity="0.7"
          />
          <line
            x1="3"
            y1="6.5"
            x2="12"
            y2="6.5"
            stroke="currentColor"
            strokeWidth="1"
            opacity="0.7"
          />
          <line
            x1="3"
            y1="9"
            x2="14"
            y2="9"
            stroke="currentColor"
            strokeWidth="1"
            opacity="0.7"
          />
        </svg>
      ),
    },
  ];

export default function LayoutSwitcher({
  activeLayout,
  onLayoutChange,
}: LayoutSwitcherProps): React.JSX.Element {
  return (
    <div className="layout-switcher">
      {layouts.map(({ mode, tooltip, icon }) => (
        <button
          key={mode}
          className={`layout-btn${activeLayout === mode ? " active" : ""}`}
          data-tooltip={tooltip}
          onClick={() => onLayoutChange(mode)}
        >
          {icon}
        </button>
      ))}
    </div>
  );
}
