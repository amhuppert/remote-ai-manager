"use client";

import { useState } from "react";

import { cn } from "@/lib/ui/cn";
import {
  TabsRoot,
  TabsList,
  TabsTrigger,
  TabsContent,
} from "@/components/ui/Tabs";
import type { AgentCapabilityCascadeKind } from "@/lib/agent-capabilities/schemas";
import { commandCascadesForBackend } from "@/lib/agent-capabilities/metadata";
import type { AgentCapabilityScope } from "@/hooks/use-agent-capabilities";
import type { AgentBackendId } from "@/lib/shared/schemas";

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

const ALL_CAPABILITY_TAB_IDS: readonly CapabilityTabId[] =
  CAPABILITY_TAB_GROUPS.flatMap((group) => group.tabs.map((tab) => tab.id));

// The non-MCP tabs each render a cascade panel; narrow off the "mcp" id so the
// container receives a typed `AgentCapabilityCascadeKind`.
const CASCADE_TAB_IDS: readonly AgentCapabilityCascadeKind[] =
  ALL_CAPABILITY_TAB_IDS.filter(
    (id): id is AgentCapabilityCascadeKind => id !== "mcp",
  );

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
  const openPluginTab = (pluginId: string, backend: AgentBackendId) => {
    // The capability registry owns which plugin cascade a backend has, so the
    // tab is looked up rather than spelled. A backend that registers no plugin
    // kind — Cursor declares no capability kinds at all — resolves to null and
    // has no tab to reveal.
    const pluginCascade = commandCascadesForBackend(backend).plugins;
    const pluginTab =
      pluginCascade === null
        ? undefined
        : ALL_CAPABILITY_TAB_IDS.find((id) => id === pluginCascade);
    if (pluginTab === undefined) return;
    setPluginSearches((current) => ({
      ...current,
      [pluginTab]: pluginDisplayName(pluginId),
    }));
    setActiveTab(pluginTab);
  };
  // Radix emits the raw string value; narrow it back to a known tab id.
  const handleTabChange = (value: string) => {
    const next = ALL_CAPABILITY_TAB_IDS.find((id) => id === value);
    if (next) setActiveTab(next);
  };

  return (
    <TabsRoot asChild value={activeTab} onValueChange={handleTabChange}>
      <section
        className="flex h-full min-h-0 min-w-0 flex-col gap-md bg-bg-base text-text-primary"
        data-cap-drawer={drawer ? "" : undefined}
      >
        <header
          className={cn(
            "flex flex-none flex-col items-stretch justify-start border-x-0 border-t-0 border-b border-solid border-border-subtle",
            drawer ? "px-lg pt-lg" : "px-xl pt-xl",
          )}
        >
          <div className="mb-md flex items-start justify-between gap-md">
            <div>
              <h1
                className={cn(
                  "font-display leading-[1.1] tracking-normal text-text-primary",
                  drawer
                    ? "text-[1.2rem] font-bold"
                    : "text-[1.7rem] font-extrabold",
                )}
              >
                Agent{" "}
                <span className="text-cyan [text-shadow:0_0_18px_var(--cyan-glow-text)]">
                  capabilities
                </span>
              </h1>
              <p className="mt-xs font-mono text-[0.76rem] text-text-secondary">
                Toggle MCP servers, skills, agents and plugins. Changes cascade
                global → project → session → conversation.
              </p>
            </div>
            {drawer && onClose ? (
              <button
                type="button"
                className="inline-flex h-[30px] w-[30px] cursor-pointer items-center justify-center rounded-sm border border-solid border-border-default bg-transparent font-mono text-base text-text-secondary transition-all duration-150 hover:border-border-strong hover:bg-bg-hover hover:text-text-primary"
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

          <TabsList asChild aria-label="Agent capabilities">
            <div
              className={cn(
                "flex flex-wrap items-stretch border-x-0 border-t border-b-0 border-solid border-border-subtle bg-transparent",
                drawer ? "-mx-lg flex-col px-lg" : "-mx-xl px-xl",
              )}
            >
              {CAPABILITY_TAB_GROUPS.map((group, groupIndex) => {
                const dataAgent =
                  group.group === "Codex"
                    ? "codex"
                    : group.group === "Claude"
                      ? "claude"
                      : undefined;
                return (
                  <div
                    key={group.group}
                    className={cn(
                      "flex min-w-0 shrink-0 items-stretch",
                      drawer && "self-stretch",
                      drawer &&
                        groupIndex > 0 &&
                        "border-x-0 border-t border-b-0 border-solid border-border-subtle",
                    )}
                  >
                    <span
                      className={cn(
                        "flex items-center gap-[5px] self-stretch font-mono text-[0.7rem] font-semibold tracking-[0.1em] text-text-tertiary uppercase data-[agent=claude]:text-cyan data-[agent=codex]:text-violet",
                        drawer
                          ? "ml-0 min-w-[84px] pr-md pl-0"
                          : "ml-0 pr-sm pl-0",
                      )}
                      data-agent={dataAgent}
                    >
                      {group.group}
                    </span>
                    {group.tabs.map((tab) => (
                      <TabsTrigger asChild key={tab.id} value={tab.id}>
                        <button
                          type="button"
                          className={cn(
                            "flex cursor-pointer items-center gap-[7px] border-x-0 border-t-0 border-b-2 border-solid border-transparent bg-transparent px-[14px] py-[11px] font-mono text-[0.74rem] font-medium whitespace-nowrap text-text-secondary transition-[color,border-color] duration-150 outline-none",
                            "data-[state=active]:border-b-cyan data-[state=active]:text-text-primary data-[state=active]:data-[agent=codex]:border-b-violet data-[state=inactive]:hover:text-text-primary",
                            "focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:[outline-offset:2px]",
                          )}
                          data-agent={dataAgent}
                        >
                          <span>{tab.label}</span>
                          {tab.count !== undefined ? (
                            <span className="rounded-full bg-bg-raised px-[5px] py-[1px] text-[0.7rem] text-text-tertiary">
                              {tab.count}
                            </span>
                          ) : null}
                        </button>
                      </TabsTrigger>
                    ))}
                  </div>
                );
              })}
            </div>
          </TabsList>
        </header>

        <TabsContent
          value="mcp"
          layoutClassName="flex min-h-0 flex-auto flex-col"
        >
          <McpCapabilityPanelContainer
            layerOptions={layerOptions}
            selectedScope={selectedScope}
          />
        </TabsContent>
        {CASCADE_TAB_IDS.map((id) => (
          <TabsContent
            key={id}
            value={id}
            layoutClassName="flex min-h-0 flex-auto flex-col"
          >
            <AgentCapabilityPanelContainer
              cascadeKind={id}
              layerOptions={layerOptions}
              initialScope={initialScope}
              selectedScope={selectedScope}
              onScopeChange={setSelectedScope}
              onOpenPlugin={openPluginTab}
              initialSearch={pluginSearches[id]}
              hideHeader
              hideLevels
            />
          </TabsContent>
        ))}

        <footer
          className={cn(
            "flex flex-none items-center gap-md border-x-0 border-t border-b-0 border-solid border-border-subtle bg-bg-void font-mono text-[0.7rem] text-text-secondary",
            drawer ? "px-lg py-[8px]" : "px-xl py-[10px]",
          )}
        >
          <span className="flex items-center gap-[5px]">
            Editing{" "}
            <strong className="text-text-primary">
              {scopeLabel(selectedScope)}
            </strong>{" "}
            scope
          </span>
          <span className="flex-1" />
        </footer>
      </section>
    </TabsRoot>
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
