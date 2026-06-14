"use client";

import type { LayoutMode } from "@/lib/sessions/schemas";
interface LayoutSwitcherProps {
  activeLayout: LayoutMode;
  onLayoutChange: (mode: LayoutMode) => void;
}

const layouts: { mode: LayoutMode; tooltip: string; icon: React.ReactNode }[] =
  [
    {
      mode: "default",
      tooltip: "Conversation + Diff sidebar",
      icon: (
        <svg
          width="14"
          height="12"
          viewBox="0 0 14 12"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.2"
        >
          <rect x="0.5" y="0.5" width="9" height="11" rx="1" />
          <rect x="10.5" y="0.5" width="3" height="11" rx="1" />
        </svg>
      ),
    },
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
      tooltip: "Diff only",
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
