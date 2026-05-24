"use client";

import MobileActionMenu from "@/components/MobileActionMenu";

export type MobilePanelTab = "chat" | "diff" | "docs" | "specs" | "info";

const TABS: { id: MobilePanelTab; label: string }[] = [
  { id: "chat", label: "Chat" },
  { id: "diff", label: "Diff" },
  { id: "docs", label: "Docs" },
  { id: "specs", label: "Specs" },
  { id: "info", label: "Info" },
];

export interface MobileBottomBarProps {
  mobilePanel: MobilePanelTab;
  onSwitchPanel: (panel: MobilePanelTab) => void;
  tddEnabled: boolean;
  onTddToggle: (enabled: boolean) => void;
  tddDisabled: boolean;
  commitDisabled: boolean;
  mergeDisabled: boolean;
  targetBranch?: string;
  onCommit: () => void;
  onMerge: () => void;
  onDelete: () => void;
  devServerCounts: { running: number; total: number };
  onDevServers: () => void;
}

export default function MobileBottomBar({
  mobilePanel,
  onSwitchPanel,
  tddEnabled,
  onTddToggle,
  tddDisabled,
  commitDisabled,
  mergeDisabled,
  targetBranch,
  onCommit,
  onMerge,
  onDelete,
  devServerCounts,
  onDevServers,
}: MobileBottomBarProps): React.JSX.Element {
  return (
    <div className="mobile-bottom-bar">
      <div className="cc-tabs">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            className={`cc-tab${mobilePanel === tab.id ? " active" : ""}`}
            onClick={() => onSwitchPanel(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>
      <MobileActionMenu
        tddEnabled={tddEnabled}
        onTddToggle={onTddToggle}
        tddDisabled={tddDisabled}
        commitDisabled={commitDisabled}
        mergeDisabled={mergeDisabled}
        targetBranch={targetBranch}
        onCommit={onCommit}
        onMerge={onMerge}
        onDelete={onDelete}
        devServerCounts={devServerCounts}
        onDevServers={onDevServers}
      />
    </div>
  );
}
