"use client";

import { cn } from "@/lib/ui/cn";

type Tab<TPanel extends string> = {
  value: TPanel;
  label: string;
};

interface WorkflowMobileTabBarProps<TPanel extends string> {
  tabs: readonly Tab<TPanel>[];
  activePanel: TPanel;
  onChange: (panel: TPanel) => void;
  className?: string;
}

export function WorkflowMobileTabBar<TPanel extends string>({
  tabs,
  activePanel,
  onChange,
  className,
}: WorkflowMobileTabBarProps<TPanel>) {
  return (
    <div
      className={cn(
        "hidden max-768:fixed max-768:right-0 max-768:bottom-0 max-768:left-0 max-768:z-[100] max-768:flex max-768:h-[48px] max-768:flex-row max-768:items-center max-768:gap-sm max-768:border-t max-768:border-solid max-768:border-border-subtle max-768:bg-[var(--cc-bg-base-a92)] max-768:px-md max-768:py-0 max-768:pb-[env(safe-area-inset-bottom,0px)] max-768:[backdrop-filter:blur(16px)_saturate(140%)]",
        className,
      )}
    >
      <div className="flex min-w-0 flex-1 [scrollbar-width:none] gap-[2px] overflow-x-auto rounded-md border border-solid border-border-default bg-bg-surface p-[3px] [-webkit-overflow-scrolling:touch] [&::-webkit-scrollbar]:hidden">
        {tabs.map((tab) => (
          <button
            key={tab.value}
            data-active={tab.value === activePanel}
            className="flex min-h-[32px] flex-shrink-0 cursor-pointer appearance-none items-center gap-[4px] rounded-sm border-none bg-transparent px-[10px] py-[4px] font-mono text-[0.7rem] font-medium tracking-[0.05em] whitespace-nowrap text-text-secondary uppercase transition-all duration-150 ease-[ease] data-[active=false]:hover:bg-bg-hover data-[active=false]:hover:text-text-primary data-[active=true]:bg-cyan data-[active=true]:text-text-inverse"
            onClick={() => {
              if (tab.value !== activePanel) {
                onChange(tab.value);
              }
            }}
          >
            {tab.label}
          </button>
        ))}
      </div>
    </div>
  );
}
