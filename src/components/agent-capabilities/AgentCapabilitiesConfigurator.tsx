"use client";

import { useState } from "react";

import type { AgentCapabilityCascadeKind } from "@/lib/schemas";
import type { AgentCapabilityScope } from "@/hooks/use-agent-capabilities";

import { AgentCapabilityPanelContainer } from "./AgentCapabilityPanelContainer";
import {
  AgentCapabilityLevelSwitcher,
  type AgentCapabilityLayerOption,
} from "./AgentCapabilityPanel";
import { McpCapabilityPanelContainer } from "./McpCapabilityPanelContainer";

export interface AgentCapabilitiesConfiguratorProps {
  layerOptions: readonly AgentCapabilityLayerOption[];
  initialScope?: AgentCapabilityScope;
  drawer?: boolean;
  onClose?: () => void;
}

type CapabilityTabId = "mcp" | AgentCapabilityCascadeKind;

const CAPABILITY_TAB_GROUPS: Array<{
  group: "Shared" | "Claude" | "Codex";
  tabs: Array<{
    id: CapabilityTabId;
    label: string;
    count?: number;
  }>;
}> = [
  {
    group: "Shared",
    tabs: [{ id: "mcp", label: "MCP Servers" }],
  },
  {
    group: "Claude",
    tabs: [
      { id: "claude-skills", label: "Skills" },
      { id: "claude-agents", label: "Agents" },
      { id: "claude-plugins", label: "Plugins" },
    ],
  },
  {
    group: "Codex",
    tabs: [
      { id: "codex-skills", label: "Skills" },
      { id: "codex-plugins", label: "Plugins" },
    ],
  },
];

export function AgentCapabilitiesConfigurator({
  layerOptions,
  initialScope,
  drawer,
  onClose,
}: AgentCapabilitiesConfiguratorProps): React.JSX.Element {
  const [activeTab, setActiveTab] = useState<CapabilityTabId>("mcp");
  const [pluginSearches, setPluginSearches] = useState<
    Partial<Record<AgentCapabilityCascadeKind, string>>
  >({});
  const [selectedScope, setSelectedScope] = useState<AgentCapabilityScope>(
    () => initialScope ?? layerOptions[0]?.scope ?? { level: "global" },
  );
  const openPluginTab = (pluginId: string, backend: "claude" | "codex") => {
    const pluginTab = backend === "claude" ? "claude-plugins" : "codex-plugins";
    setPluginSearches((current) => ({
      ...current,
      [pluginTab]: pluginDisplayName(pluginId),
    }));
    setActiveTab(pluginTab);
  };

  return (
    <section
      className={`agent-capabilities-configurator cap-root${drawer ? " cap-root--drawer" : ""}`}
    >
      <header
        className={`agent-capabilities-configurator__head cap-head${drawer ? " cap-head--drawer" : ""}`}
      >
        <div className="cap-title-row">
          <div>
            <h1
              className={`agent-capabilities-configurator__title cap-title${drawer ? " cap-title--drawer" : ""}`}
            >
              Agent <span className="accent">capabilities</span>
            </h1>
            <p className="agent-capabilities-configurator__subtitle cap-subtitle">
              Toggle MCP servers, skills, agents and plugins. Changes cascade
              global → project → session → conversation.
            </p>
          </div>
          {drawer && onClose ? (
            <button
              type="button"
              className="cap-close"
              onClick={onClose}
              aria-label="Close"
            >
              ×
            </button>
          ) : null}
        </div>

        <AgentCapabilityLevelSwitcher
          layerOptions={layerOptions}
          selectedScope={selectedScope}
          onScopeChange={setSelectedScope}
        />

        <div className="agent-capabilities-tabs cap-tabs" role="tablist">
          {CAPABILITY_TAB_GROUPS.map((group) => (
            <div
              key={group.group}
              className="agent-capabilities-tabs__group cap-tabs__group"
            >
              <span
                className="agent-capabilities-tabs__label cap-tab__group"
                data-agent={
                  group.group === "Codex"
                    ? "codex"
                    : group.group === "Claude"
                      ? "claude"
                      : undefined
                }
              >
                {group.group}
              </span>
              {group.tabs.map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  role="tab"
                  className={`agent-capabilities-tab cap-tab${activeTab === tab.id ? " agent-capabilities-tab--active active" : ""}`}
                  data-agent={
                    group.group === "Codex"
                      ? "codex"
                      : group.group === "Claude"
                        ? "claude"
                        : undefined
                  }
                  aria-selected={activeTab === tab.id}
                  onClick={() => setActiveTab(tab.id)}
                >
                  <span>{tab.label}</span>
                  {tab.count !== undefined ? (
                    <span className="cap-tab__count">{tab.count}</span>
                  ) : null}
                </button>
              ))}
            </div>
          ))}
        </div>
      </header>

      {activeTab === "mcp" ? (
        <McpCapabilityPanelContainer
          layerOptions={layerOptions}
          selectedScope={selectedScope}
        />
      ) : (
        <AgentCapabilityPanelContainer
          key={activeTab}
          cascadeKind={activeTab}
          layerOptions={layerOptions}
          initialScope={initialScope}
          selectedScope={selectedScope}
          onScopeChange={setSelectedScope}
          onOpenPlugin={openPluginTab}
          initialSearch={pluginSearches[activeTab]}
          hideHeader
          hideLevels
        />
      )}

      <footer className="cap-foot">
        <span className="diag">
          Editing <strong>{scopeLabel(selectedScope)}</strong> scope
        </span>
        <span className="spacer" />
      </footer>
    </section>
  );
}

function pluginDisplayName(pluginId: string): string {
  return pluginId.startsWith("plugin:")
    ? pluginId.slice("plugin:".length)
    : pluginId;
}

function scopeLabel(scope: AgentCapabilityScope): string {
  if (scope.level === "global") return "Global";
  if (scope.level === "project") return "Project";
  if (scope.level === "session") return "Session";
  return "Conversation";
}
