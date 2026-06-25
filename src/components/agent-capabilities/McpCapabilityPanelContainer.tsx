"use client";

import { useMemo, useState } from "react";

import type { AgentCapabilityScope } from "@/hooks/use-agent-capabilities";
import {
  useConversationMcpConfigQuery,
  useGlobalMcpConfigQuery,
  useProjectMcpConfigQuery,
  useSessionMcpConfigQuery,
} from "@/lib/mcp/queries";
import type { McpMutationScope } from "@/lib/mcp/mutations";
import { adaptServerViewsForLevel } from "@/components/mcp/view-adapter";
import { useMcpActions } from "@/components/mcp/use-mcp-actions";
import type { McpServerView, McpToolView } from "@/components/mcp/types";
import { Button } from "@/components/ui/Button";
import {
  SegmentedControl,
  SegmentedControlItem,
} from "@/components/ui/SegmentedControl";
import { Switch } from "@/components/ui/Switch";
import { cn } from "@/lib/ui/cn";

import type { AgentCapabilityLayerOption } from "./AgentCapabilityPanel";

interface McpCapabilityPanelContainerProps {
  layerOptions: readonly AgentCapabilityLayerOption[];
  selectedScope: AgentCapabilityScope;
}

type McpSupportedAgentCapabilityScope = Exclude<
  AgentCapabilityScope,
  {
    level: "conversation";
    conversationScope: "project";
  }
>;

type McpFilter = "all" | "overridden" | "enabled" | "disabled";

const MCP_FILTERS: Array<{
  key: McpFilter;
  label: string;
  ariaLabel: string;
}> = [
  { key: "all", label: "All", ariaLabel: "Show all MCP servers" },
  {
    key: "overridden",
    label: "Overridden",
    ariaLabel: "Show overridden MCP servers",
  },
  { key: "enabled", label: "On", ariaLabel: "Show enabled MCP servers" },
  { key: "disabled", label: "Off", ariaLabel: "Show disabled MCP servers" },
];

// Direct-span styling from the shared `.agent-capability-row__details span`
// rule (still in globals.css for AgentCapabilityPanel) — every detail span,
// including the inheritance chip, carries it.
const DETAILS_SPAN = "min-w-0 [overflow-wrap:anywhere]";

// Shared `.agent-capability-row__switch` toggle (sizes/knob applied per use).
const SWITCH_BASE =
  "relative flex-none cursor-pointer rounded-full border border-solid transition-all duration-150";
const SWITCH_ON = "border-cyan bg-cyan shadow-[0_0_12px_var(--cyan-glow)]";
const SWITCH_OFF = "border-border-default bg-bg-base";
const SWITCH_KNOB =
  "absolute left-px top-px rounded-full transition-[transform,background] duration-150";

// Shared `.agent-capability-inheritance` chip.
const CHIP_BASE = cn(
  "inline-flex items-center gap-[4px] rounded-full border border-solid px-[7px] py-[2px] font-mono text-[0.7rem] font-medium whitespace-nowrap text-text-tertiary",
  DETAILS_SPAN,
);
const CHIP_EXPLICIT = "border-[var(--cc-cyan-a25)] bg-cyan-glow text-cyan";
const CHIP_EXPLICIT_OFF =
  "border-[var(--cc-amber-a25)] bg-amber-glow text-amber";

export function McpCapabilityPanelContainer({
  selectedScope,
}: McpCapabilityPanelContainerProps): React.JSX.Element {
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<McpFilter>("all");
  const [expandedServerId, setExpandedServerId] = useState<string | null>(null);
  const mcpScope = useMemo(
    () => toMcpSupportedScope(selectedScope),
    [selectedScope],
  );

  const globalQuery = useGlobalMcpConfigQuery({
    enabled: mcpScope.level === "global",
  });
  const projectName = mcpScope.level === "global" ? "" : mcpScope.projectName;
  const sessionName =
    mcpScope.level === "session" || mcpScope.level === "conversation"
      ? mcpScope.sessionName
      : "";
  const conversationId =
    mcpScope.level === "conversation" ? mcpScope.conversationId : "";
  const projectQuery = useProjectMcpConfigQuery(projectName, {
    enabled: mcpScope.level === "project",
  });
  const sessionQuery = useSessionMcpConfigQuery(projectName, sessionName, {
    enabled: mcpScope.level === "session",
  });
  const conversationQuery = useConversationMcpConfigQuery(
    projectName,
    sessionName,
    conversationId,
    { enabled: mcpScope.level === "conversation" },
  );

  const activeQuery =
    mcpScope.level === "global"
      ? globalQuery
      : mcpScope.level === "project"
        ? projectQuery
        : mcpScope.level === "session"
          ? sessionQuery
          : conversationQuery;

  const servers = useMemo(() => {
    if (!activeQuery.data) return [];
    return adaptServerViewsForLevel(activeQuery.data, mcpScope.level);
  }, [activeQuery.data, mcpScope.level]);

  const mutationScope = useMemo<McpMutationScope>(
    () => toMcpMutationScope(mcpScope),
    [mcpScope],
  );
  const actions = useMcpActions(mutationScope, servers);

  const visibleServers = useMemo(() => {
    const term = search.trim().toLowerCase();
    return servers.filter((server) => {
      if (term && !mcpServerMatchesSearch(server, term)) return false;
      return mcpServerMatchesFilter(server, filter);
    });
  }, [filter, search, servers]);

  return (
    <section
      className="flex min-h-0 min-w-0 flex-auto flex-col bg-bg-base"
      data-cascade-kind="mcp"
    >
      <div className="flex min-w-0 flex-none flex-wrap items-center gap-sm rounded-md border border-solid border-border-dim border-b-border-subtle bg-bg-void px-xl py-md max-900:flex-col max-900:items-stretch [[data-cap-drawer]_&]:px-lg [[data-cap-drawer]_&]:py-sm">
        <label className="flex max-w-[360px] min-w-[180px] flex-1 flex-col items-center gap-[7px] rounded-md border border-solid border-border-subtle bg-bg-base px-[10px] py-[6px] font-mono text-[0.7rem] font-semibold tracking-[0.06em] text-text-secondary uppercase transition-all duration-150 focus-within:border-cyan focus-within:shadow-[0_0_0_3px_var(--cyan-glow)] max-900:max-w-none">
          <span className="absolute h-px w-px overflow-hidden whitespace-nowrap [clip:rect(0_0_0_0)]">
            Search
          </span>
          <input
            aria-label="Search MCP Servers"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search mcp servers..."
            className="min-h-[34px] w-full rounded-md border-0 bg-transparent px-[8px] py-[6px] font-mono text-[0.76rem] tracking-normal text-text-primary normal-case outline-0 placeholder:text-text-tertiary"
          />
        </label>
        <SegmentedControl
          aria-label="Filter MCP servers"
          value={filter}
          onValueChange={(next) => {
            const match = MCP_FILTERS.find((item) => item.key === next);
            if (match) setFilter(match.key);
          }}
          layoutClassName="flex-wrap"
        >
          {MCP_FILTERS.map((item) => (
            <SegmentedControlItem
              key={item.key}
              value={item.key}
              aria-label={item.ariaLabel}
            >
              {item.label}
            </SegmentedControlItem>
          ))}
        </SegmentedControl>
        <div className="ml-auto font-mono text-[0.7rem] whitespace-nowrap text-text-tertiary">
          {scopeLabel(mcpScope)}
        </div>
      </div>

      {activeQuery.isPending ? (
        <div className="rounded-sm bg-bg-base p-sm font-mono text-[0.78rem] text-text-secondary">
          Loading MCP servers
        </div>
      ) : null}
      {activeQuery.isError ? (
        <div
          className="rounded-sm border border-solid border-red-dim bg-red-glow p-sm font-mono text-[0.78rem] text-red"
          role="alert"
        >
          Failed to load MCP servers:{" "}
          {activeQuery.error?.message ?? "unknown error"}
        </div>
      ) : null}

      <div className="grid min-h-0 flex-auto auto-rows-auto content-start gap-xs overflow-y-auto px-xl pt-md pb-xl [[data-cap-drawer]_&]:px-lg [[data-cap-drawer]_&]:pt-sm [[data-cap-drawer]_&]:pb-lg">
        {visibleServers.map((server) => (
          <McpCapabilityRow
            key={server.id}
            server={server}
            scopeName={scopeLabel(mcpScope)}
            expanded={expandedServerId === server.id}
            onExpand={() => {
              setExpandedServerId((current) =>
                current === server.id ? null : server.id,
              );
              actions.onExpand?.(server.id);
            }}
            onToggle={(enabled) =>
              actions.onToggleEnabled?.(server.id, enabled)
            }
            onReset={() => actions.onResetToInherit?.(server.id)}
            onRefreshTools={() => actions.onRefreshTools?.(server.id)}
            onToggleTool={(toolName, enabled) =>
              actions.onToggleTool?.(server.id, toolName, enabled)
            }
            onResetTool={(toolName) =>
              actions.onResetTool?.(server.id, toolName)
            }
          />
        ))}
        {!activeQuery.isPending && visibleServers.length === 0 ? (
          <div className="rounded-sm border border-dashed border-border-default p-sm font-mono text-[0.78rem] text-text-tertiary">
            No MCP servers match
          </div>
        ) : null}
      </div>
    </section>
  );
}

function McpCapabilityRow({
  server,
  scopeName,
  expanded,
  onExpand,
  onToggle,
  onReset,
  onRefreshTools,
  onToggleTool,
  onResetTool,
}: {
  server: McpServerView;
  scopeName: string;
  expanded: boolean;
  onExpand(): void;
  onToggle(enabled: boolean): void;
  onReset(): void;
  onRefreshTools(): void;
  onToggleTool(toolName: string, enabled: boolean): void;
  onResetTool(toolName: string): void;
}): React.JSX.Element {
  const explicitHere =
    server.status.kind === "overridden" || server.status.kind === "disabled";

  return (
    <article
      className={cn(
        "mb-sm grid min-w-0 grid-cols-[28px_minmax(0,1fr)_auto] items-center gap-md rounded-md border border-solid border-border-subtle bg-bg-surface px-[14px] py-[11px] transition-[border-color,background] duration-150 hover:border-border-default max-900:grid-cols-[1fr]",
        explicitHere &&
          (server.enabled
            ? "border-l-2 border-l-cyan"
            : "border-l-2 border-l-amber"),
      )}
      data-effective={server.enabled ? "on" : "off"}
      data-server-id={server.id}
    >
      <button
        type="button"
        className={cn(
          "flex h-[22px] w-[22px] items-center justify-center border-0 bg-transparent font-mono text-base [transition:transform_0.2s_ease,color_0.15s_ease]",
          expanded ? "rotate-90 text-cyan" : "text-text-tertiary",
        )}
        aria-expanded={expanded}
        onClick={onExpand}
      >
        <span aria-hidden="true">›</span>
      </button>
      <div className="grid min-w-0 gap-xs">
        <div className="flex min-w-0 items-start justify-between gap-md max-768:flex-col">
          <div className="grid min-w-0 gap-[3px]">
            <span
              className={cn(
                "min-w-0 overflow-hidden font-mono text-[0.86rem] font-medium [overflow-wrap:anywhere] text-ellipsis whitespace-nowrap",
                server.enabled
                  ? "text-text-primary"
                  : "text-text-secondary line-through decoration-text-tertiary decoration-1",
              )}
            >
              {server.name}
            </span>
            <span className="min-w-0 overflow-hidden font-mono text-[0.7rem] [overflow-wrap:anywhere] text-ellipsis whitespace-nowrap text-text-tertiary">
              {server.id}
            </span>
          </div>
          <div className="mt-[5px] flex min-w-0 flex-wrap items-center gap-sm font-mono text-[0.7rem] text-text-tertiary">
            <span className={DETAILS_SPAN}>source: {server.scope}</span>
            <McpInheritanceChip server={server} scopeName={scopeName} />
            <span className={DETAILS_SPAN}>{toolSummary(server)}</span>
            {server.pending ? (
              <span className={cn(DETAILS_SPAN, "font-mono text-[0.7rem]")}>
                pending
              </span>
            ) : null}
          </div>
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-end gap-sm">
        {explicitHere ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            touch
            onClick={onReset}
          >
            Reset
          </Button>
        ) : null}
        <Switch
          size="md"
          tone="cyan"
          checked={server.enabled}
          aria-label={`${server.enabled ? "Disable" : "Enable"} ${server.name}`}
          onCheckedChange={(next) => onToggle(next)}
        />
      </div>

      {expanded ? (
        <div className="col-[1/-1] -mx-md mt-sm -mb-sm border-x-0 border-t border-b-0 border-solid border-border-subtle bg-bg-base px-lg pt-sm pb-md">
          <div className="grid grid-cols-[1fr_auto] items-center gap-md py-[6px] font-mono text-[0.7rem] font-semibold tracking-[0.08em] text-text-tertiary uppercase">
            <span>Tools</span>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              touch
              onClick={onRefreshTools}
            >
              refresh
            </Button>
          </div>
          <McpToolRows
            serverEnabled={server.enabled}
            discovery={server.toolDiscovery}
            onToggleTool={onToggleTool}
            onResetTool={onResetTool}
          />
        </div>
      ) : null}
    </article>
  );
}

function McpToolRows({
  serverEnabled,
  discovery,
  onToggleTool,
  onResetTool,
}: {
  serverEnabled: boolean;
  discovery: McpServerView["toolDiscovery"];
  onToggleTool(toolName: string, enabled: boolean): void;
  onResetTool(toolName: string): void;
}): React.JSX.Element {
  if (discovery.kind === "idle") {
    return (
      <div className="font-mono text-[0.7rem] text-text-tertiary">
        Tools load when this server is expanded or refreshed.
      </div>
    );
  }
  if (discovery.kind === "loading") {
    return (
      <div className="font-mono text-[0.7rem] text-text-tertiary">
        Discovering tools
      </div>
    );
  }
  if (discovery.kind === "error") {
    return (
      <div className="font-mono text-[0.7rem] text-text-tertiary">
        {discovery.message}
      </div>
    );
  }

  return (
    <div>
      {discovery.tools.map((tool) => (
        <McpToolRow
          key={tool.name}
          tool={tool}
          serverEnabled={serverEnabled}
          onToggle={() => onToggleTool(tool.name, !tool.enabled)}
          onReset={() => onResetTool(tool.name)}
        />
      ))}
    </div>
  );
}

function McpToolRow({
  tool,
  serverEnabled,
  onToggle,
  onReset,
}: {
  tool: McpToolView;
  serverEnabled: boolean;
  onToggle(): void;
  onReset(): void;
}): React.JSX.Element {
  const explicitHere =
    tool.status.kind === "overridden" || tool.status.kind === "disabled";
  const effectiveOn = serverEnabled && tool.enabled;

  return (
    <div className="grid grid-cols-[12px_minmax(0,1fr)_auto_auto_auto] items-center gap-md border-x-0 border-t border-b-0 border-solid border-border-dim py-[6px] font-mono first:border-t-0">
      <span
        className={cn(
          "ml-[3px] h-[5px] w-[5px] rounded-full",
          effectiveOn
            ? "bg-green shadow-[0_0_6px_var(--green-glow)]"
            : "bg-text-tertiary shadow-none",
        )}
      />
      <span
        className={cn(
          "overflow-hidden text-[0.76rem] text-ellipsis whitespace-nowrap",
          effectiveOn
            ? "text-text-primary"
            : "text-text-secondary line-through decoration-1",
        )}
      >
        {tool.name}
      </span>
      <span className="font-mono text-[0.7rem] text-text-tertiary">
        {!serverEnabled ? "server off" : tool.enabled ? "" : "denied"}
      </span>
      {explicitHere ? (
        <Button type="button" variant="ghost" size="sm" touch onClick={onReset}>
          Reset
        </Button>
      ) : null}
      <button
        type="button"
        className={cn(
          SWITCH_BASE,
          "h-[14px] w-[26px] disabled:cursor-not-allowed disabled:opacity-45",
          tool.enabled ? SWITCH_ON : SWITCH_OFF,
        )}
        aria-label={`${tool.enabled ? "Disable" : "Enable"} ${tool.name}`}
        aria-pressed={tool.enabled}
        disabled={!serverEnabled}
        onClick={onToggle}
      >
        <span
          className={cn(
            SWITCH_KNOB,
            "h-[10px] w-[10px]",
            tool.enabled
              ? "translate-x-[12px] bg-text-inverse"
              : "bg-text-tertiary",
          )}
        />
      </button>
    </div>
  );
}

function McpInheritanceChip({
  server,
  scopeName,
}: {
  server: McpServerView;
  scopeName: string;
}): React.JSX.Element {
  if (server.status.kind === "disabled") {
    return (
      <span className={cn(CHIP_BASE, CHIP_EXPLICIT_OFF)}>
        Set off at {scopeName}
      </span>
    );
  }
  if (server.status.kind === "overridden") {
    return (
      <span className={cn(CHIP_BASE, CHIP_EXPLICIT)}>
        Set on at {scopeName}
      </span>
    );
  }
  if (server.status.kind === "inherited") {
    return (
      <span className={cn(CHIP_BASE, "border-border-subtle")}>
        Inherits {server.enabled ? "on" : "off"} from {server.status.from}
      </span>
    );
  }
  return (
    <span className={cn(CHIP_BASE, CHIP_EXPLICIT)}>
      Set {server.enabled ? "on" : "off"} at {scopeName}
    </span>
  );
}

function toMcpSupportedScope(
  scope: AgentCapabilityScope,
): McpSupportedAgentCapabilityScope {
  if (scope.level === "conversation" && scope.conversationScope === "project") {
    return { level: "project", projectName: scope.projectName };
  }
  return scope;
}

function toMcpMutationScope(
  scope: McpSupportedAgentCapabilityScope,
): McpMutationScope {
  if (scope.level === "global") return { level: "global" };
  if (scope.level === "project") {
    return { level: "project", projectName: scope.projectName };
  }
  if (scope.level === "session") {
    return {
      level: "session",
      projectName: scope.projectName,
      sessionName: scope.sessionName,
    };
  }
  return {
    level: "conversation",
    projectName: scope.projectName,
    sessionName: scope.sessionName,
    conversationId: scope.conversationId,
  };
}

function scopeLabel(scope: McpSupportedAgentCapabilityScope): string {
  if (scope.level === "global") return "Global";
  if (scope.level === "project") return "Project";
  if (scope.level === "session") return "Session";
  return "Conversation";
}

function mcpServerMatchesSearch(server: McpServerView, term: string): boolean {
  return [server.name, server.id, server.sourceFile, server.scope].some(
    (value) => value.toLowerCase().includes(term),
  );
}

function mcpServerMatchesFilter(
  server: McpServerView,
  filter: McpFilter,
): boolean {
  if (filter === "all") return true;
  if (filter === "enabled") return server.enabled;
  if (filter === "disabled") return !server.enabled;
  return (
    server.status.kind === "overridden" || server.status.kind === "disabled"
  );
}

function toolSummary(server: McpServerView): string {
  if (server.toolDiscovery.kind === "loaded") {
    const enabled = server.toolDiscovery.tools.filter((tool) => tool.enabled);
    return `${server.toolDiscovery.tools.length} tools · ${enabled.length} enabled`;
  }
  if (server.toolDiscovery.kind === "loading") return "discovering tools";
  if (server.toolDiscovery.kind === "error") return "tool discovery failed";
  return "tools not loaded";
}
