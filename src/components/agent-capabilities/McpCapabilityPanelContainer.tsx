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

import type { AgentCapabilityLayerOption } from "./AgentCapabilityPanel";

interface McpCapabilityPanelContainerProps {
  layerOptions: readonly AgentCapabilityLayerOption[];
  selectedScope: AgentCapabilityScope;
}

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

export function McpCapabilityPanelContainer({
  selectedScope,
}: McpCapabilityPanelContainerProps): React.JSX.Element {
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<McpFilter>("all");
  const [expandedServerId, setExpandedServerId] = useState<string | null>(null);

  const globalQuery = useGlobalMcpConfigQuery({
    enabled: selectedScope.level === "global",
  });
  const projectName =
    selectedScope.level === "global" ? "" : selectedScope.projectName;
  const sessionName =
    selectedScope.level === "session" || selectedScope.level === "conversation"
      ? selectedScope.sessionName
      : "";
  const conversationId =
    selectedScope.level === "conversation" ? selectedScope.conversationId : "";
  const projectQuery = useProjectMcpConfigQuery(projectName, {
    enabled: selectedScope.level === "project",
  });
  const sessionQuery = useSessionMcpConfigQuery(projectName, sessionName, {
    enabled: selectedScope.level === "session",
  });
  const conversationQuery = useConversationMcpConfigQuery(
    projectName,
    sessionName,
    conversationId,
    { enabled: selectedScope.level === "conversation" },
  );

  const activeQuery =
    selectedScope.level === "global"
      ? globalQuery
      : selectedScope.level === "project"
        ? projectQuery
        : selectedScope.level === "session"
          ? sessionQuery
          : conversationQuery;

  const servers = useMemo(() => {
    if (!activeQuery.data) return [];
    return adaptServerViewsForLevel(activeQuery.data, selectedScope.level);
  }, [activeQuery.data, selectedScope.level]);

  const mutationScope = useMemo<McpMutationScope>(
    () => toMcpMutationScope(selectedScope),
    [selectedScope],
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
      className="agent-capability-panel agent-capability-panel--mcp"
      data-cascade-kind="mcp"
    >
      <div className="agent-capability-panel__toolbar">
        <label className="agent-capability-panel__field">
          <span>Search</span>
          <input
            aria-label="Search MCP Servers"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search mcp servers..."
          />
        </label>
        <div className="agent-capability-panel__filters">
          {MCP_FILTERS.map((item) => (
            <button
              key={item.key}
              type="button"
              className={`agent-capability-filter${filter === item.key ? " agent-capability-filter--active" : ""}`}
              aria-label={item.ariaLabel}
              aria-pressed={filter === item.key}
              onClick={() => setFilter(item.key)}
            >
              {item.label}
            </button>
          ))}
        </div>
        <div className="agent-capability-panel__scope-note">
          {scopeLabel(selectedScope)}
        </div>
      </div>

      {activeQuery.isPending ? (
        <div className="agent-capability-panel__notice">
          Loading MCP servers
        </div>
      ) : null}
      {activeQuery.isError ? (
        <div className="agent-capability-panel__error" role="alert">
          Failed to load MCP servers:{" "}
          {activeQuery.error?.message ?? "unknown error"}
        </div>
      ) : null}

      <div className="agent-capability-panel__rows agent-capability-panel__rows--mcp">
        {visibleServers.map((server) => (
          <McpCapabilityRow
            key={server.id}
            server={server}
            scopeName={scopeLabel(selectedScope)}
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
          <div className="agent-capability-panel__empty">
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
      className={[
        "agent-capability-row",
        "agent-capability-row--mcp",
        server.enabled ? "agent-capability-row--enabled" : "",
        explicitHere ? "agent-capability-row--explicit" : "",
        expanded ? "agent-capability-row--expanded" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      data-effective={server.enabled ? "on" : "off"}
      data-server-id={server.id}
    >
      <button
        type="button"
        className="agent-capability-row__expand"
        aria-expanded={expanded}
        onClick={onExpand}
      >
        <span aria-hidden="true">›</span>
      </button>
      <div className="agent-capability-row__body">
        <div className="agent-capability-row__main">
          <div className="agent-capability-row__identity">
            <span className="agent-capability-row__name">{server.name}</span>
            <span className="agent-capability-row__id">{server.id}</span>
          </div>
          <div className="agent-capability-row__details">
            <span>source: {server.scope}</span>
            <McpInheritanceChip server={server} scopeName={scopeName} />
            <span>{toolSummary(server)}</span>
            {server.pending ? (
              <span className="agent-capability-row__control-note">
                pending
              </span>
            ) : null}
          </div>
        </div>
      </div>

      <div className="agent-capability-row__controls">
        {explicitHere ? (
          <button
            type="button"
            className="btn btn-ghost btn-sm agent-capability-row__reset"
            onClick={onReset}
          >
            Reset
          </button>
        ) : null}
        <button
          type="button"
          className={`agent-capability-row__switch${server.enabled ? " agent-capability-row__switch--on" : ""}`}
          aria-pressed={server.enabled}
          aria-label={`${server.enabled ? "Disable" : "Enable"} ${server.name}`}
          onClick={() => onToggle(!server.enabled)}
        >
          <span />
        </button>
      </div>

      {expanded ? (
        <div className="agent-capability-mcp-tools">
          <div className="agent-capability-mcp-tools__head">
            <span>Tools</span>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={onRefreshTools}
            >
              refresh
            </button>
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
      <div className="agent-capability-mcp-tools__empty">
        Tools load when this server is expanded or refreshed.
      </div>
    );
  }
  if (discovery.kind === "loading") {
    return (
      <div className="agent-capability-mcp-tools__empty">Discovering tools</div>
    );
  }
  if (discovery.kind === "error") {
    return (
      <div className="agent-capability-mcp-tools__empty">
        {discovery.message}
      </div>
    );
  }

  return (
    <div className="agent-capability-mcp-tools__list">
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

  return (
    <div
      className="agent-capability-mcp-tool"
      data-effective={serverEnabled && tool.enabled ? "on" : "off"}
    >
      <span className="agent-capability-mcp-tool__dot" />
      <span className="agent-capability-mcp-tool__name">{tool.name}</span>
      <span className="agent-capability-mcp-tool__state">
        {!serverEnabled ? "server off" : tool.enabled ? "" : "denied"}
      </span>
      {explicitHere ? (
        <button
          type="button"
          className="btn btn-ghost btn-sm agent-capability-mcp-tool__reset"
          onClick={onReset}
        >
          Reset
        </button>
      ) : null}
      <button
        type="button"
        className={`agent-capability-row__switch agent-capability-row__switch--small${tool.enabled ? " agent-capability-row__switch--on" : ""}`}
        aria-label={`${tool.enabled ? "Disable" : "Enable"} ${tool.name}`}
        aria-pressed={tool.enabled}
        disabled={!serverEnabled}
        onClick={onToggle}
      >
        <span />
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
      <span className="agent-capability-inheritance agent-capability-inheritance--explicit-off">
        Set off at {scopeName}
      </span>
    );
  }
  if (server.status.kind === "overridden") {
    return (
      <span className="agent-capability-inheritance agent-capability-inheritance--explicit">
        Set on at {scopeName}
      </span>
    );
  }
  if (server.status.kind === "inherited") {
    return (
      <span className="agent-capability-inheritance">
        Inherits {server.enabled ? "on" : "off"} from {server.status.from}
      </span>
    );
  }
  return (
    <span className="agent-capability-inheritance agent-capability-inheritance--explicit">
      Set {server.enabled ? "on" : "off"} at {scopeName}
    </span>
  );
}

function toMcpMutationScope(scope: AgentCapabilityScope): McpMutationScope {
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

function scopeLabel(scope: AgentCapabilityScope): string {
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
