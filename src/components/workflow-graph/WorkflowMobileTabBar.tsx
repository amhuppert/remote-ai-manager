"use client";

import { cn } from "@/lib/ui/cn";

/**
 * The mobile bottom toolbar (design bundle `Workflow Mobile.dc.html` M1/M2).
 *
 * Fixed, safe-area padded and 44px-tall targets: it is the only way between
 * panels, so it never moves and never hides — not while a nested config screen
 * pushes, not while a sheet is open.
 */

export type WorkflowMobileTabIcon = "graph" | "list" | "panel" | "log";

type Tab<TPanel extends string> = {
  value: TPanel;
  label: string;
  icon: WorkflowMobileTabIcon;
};

interface WorkflowMobileTabBarProps<TPanel extends string> {
  tabs: readonly Tab<TPanel>[];
  activePanel: TPanel;
  onChange: (panel: TPanel) => void;
  /** Names the tab set for assistive technology ("Builder panels"). */
  label: string;
  className?: string;
}

function TabGlyph({
  icon,
}: {
  icon: WorkflowMobileTabIcon;
}): React.JSX.Element {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      {icon === "graph" && (
        <>
          <rect
            x="1.5"
            y="3"
            width="5"
            height="4"
            rx="1"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.3"
          />
          <rect
            x="9.5"
            y="9"
            width="5"
            height="4"
            rx="1"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.3"
          />
          <path
            d="M6.5 5h2.2a1.3 1.3 0 0 1 1.3 1.3V9"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.3"
            strokeLinecap="round"
          />
        </>
      )}
      {icon === "list" && (
        <path
          d="M3 4.5h10M3 8h10M3 11.5h10"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinecap="round"
        />
      )}
      {icon === "panel" && (
        <>
          <rect
            x="2"
            y="3"
            width="12"
            height="10"
            rx="1.5"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.3"
          />
          <path
            d="M10 3v10"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.3"
          />
        </>
      )}
      {icon === "log" && (
        <>
          <path
            d="M3 4.5h7M3 8h10M3 11.5h6"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
          />
          <circle cx="12.5" cy="4.5" r="1.4" fill="currentColor" />
        </>
      )}
    </svg>
  );
}

export function WorkflowMobileTabBar<TPanel extends string>({
  tabs,
  activePanel,
  onChange,
  label,
  className,
}: WorkflowMobileTabBarProps<TPanel>) {
  return (
    <nav
      aria-label={label}
      className={cn(
        "hidden max-768:fixed max-768:right-0 max-768:bottom-0 max-768:left-0 max-768:z-[100] max-768:flex max-768:flex-row max-768:items-stretch max-768:gap-[6px] max-768:border-t max-768:border-solid max-768:border-border-dim max-768:bg-[var(--cc-bg-surface-a92)] max-768:px-[10px] max-768:pt-[8px] max-768:pb-[calc(8px+env(safe-area-inset-bottom,0px))] max-768:[backdrop-filter:blur(16px)_saturate(140%)]",
        className,
      )}
    >
      {tabs.map((tab) => {
        const active = tab.value === activePanel;
        return (
          <button
            key={tab.value}
            type="button"
            aria-current={active ? "page" : undefined}
            data-active={active}
            className="flex min-h-[44px] flex-1 cursor-pointer appearance-none flex-col items-center justify-center gap-[2px] rounded-md border border-solid border-transparent bg-transparent px-[8px] py-[4px] font-mono text-[0.7rem] font-medium tracking-[0.04em] whitespace-nowrap text-text-secondary transition-colors duration-150 focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:[outline-offset:2px] data-[active=false]:hover:bg-bg-hover data-[active=false]:hover:text-text-primary data-[active=true]:border-[var(--cyan-glow-strong)] data-[active=true]:bg-[var(--cc-cyan-a12)] data-[active=true]:text-cyan"
            onClick={() => {
              if (!active) onChange(tab.value);
            }}
          >
            <TabGlyph icon={tab.icon} />
            {tab.label}
          </button>
        );
      })}
    </nav>
  );
}
