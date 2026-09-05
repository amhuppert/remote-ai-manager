"use client";

import MobileActionMenu from "@/components/MobileActionMenu";
import type { MobilePanel } from "@/stores/session-detail/types";

export type MobilePanelTab = MobilePanel;

const TABS: { id: MobilePanelTab; label: string }[] = [
  { id: "chat", label: "Chat" },
  { id: "diff", label: "Diff" },
  { id: "docs", label: "Docs" },
];

const MORE_PANELS: { id: MobilePanel; label: string }[] = [
  { id: "alignment", label: "Alignment" },
  { id: "memory", label: "Memory" },
  { id: "artifact", label: "Compactions" },
  { id: "notepad", label: "Notepad" },
  { id: "specs", label: "Specs" },
  { id: "info", label: "Info" },
];

export interface MobileBottomBarProps {
  mobilePanel: MobilePanelTab;
  onSwitchPanel: (panel: MobilePanelTab) => void;
  tddEnabled: boolean;
  onTddToggle: (enabled: boolean) => void;
  tddDisabled: boolean;
  onDelete: () => void;
  devServerCounts: { running: number; total: number };
  onDevServers: () => void;
  onRebase?: () => void;
}

export default function MobileBottomBar({
  mobilePanel,
  onSwitchPanel,
  tddEnabled,
  onTddToggle,
  tddDisabled,
  onDelete,
  devServerCounts,
  onDevServers,
  onRebase,
}: MobileBottomBarProps): React.JSX.Element {
  return (
    // RETAINED HOOK (foundation-deferred): `.mobile-bottom-bar` and its
    // descendant `.mobile-bottom-bar .cc-tabs` / `.cc-tab` overrides (globals.css)
    // are owned by the globals/graph-context slice, not this one — this file is
    // intentionally excluded from the eslint utility-first allowlist. Swapping
    // `.cc-tabs`/`.cc-tab` to <Tabs>/<Tab> here would detach those descendant
    // rules (selector no longer matches) and regress the mobile bar, so the leaf
    // hooks stay until the bottom-bar is migrated as one unit.
    <div className="mobile-bottom-bar">
      <div className="cc-tabs">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            className={`cc-tab${mobilePanel === tab.id ? " active" : ""}`}
            onClick={() => onSwitchPanel(tab.id)}
            aria-pressed={mobilePanel === tab.id}
          >
            {tab.label}
          </button>
        ))}
      </div>
      <MobileActionMenu
        triggerLabel={
          MORE_PANELS.find((panel) => panel.id === mobilePanel)?.label ?? "More"
        }
        panelActions={MORE_PANELS.map((panel) => ({
          label: panel.label,
          active: mobilePanel === panel.id,
          onSelect: () => onSwitchPanel(panel.id),
        }))}
        onRebase={onRebase}
        tddEnabled={tddEnabled}
        onTddToggle={onTddToggle}
        tddDisabled={tddDisabled}
        onDelete={onDelete}
        devServerCounts={devServerCounts}
        onDevServers={onDevServers}
      />
    </div>
  );
}
