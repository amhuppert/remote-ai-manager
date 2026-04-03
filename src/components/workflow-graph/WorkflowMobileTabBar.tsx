"use client";

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
      className={`mobile-bottom-bar wb-mobile-tab-bar${className ? ` ${className}` : ""}`}
    >
      <div className="cc-tabs">
        {tabs.map((tab) => (
          <button
            key={tab.value}
            className={`cc-tab${tab.value === activePanel ? " active" : ""}`}
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
