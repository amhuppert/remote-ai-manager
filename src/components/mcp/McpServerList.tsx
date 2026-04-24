"use client";

import { useMemo } from "react";
import McpServerCard from "./McpServerCard";
import type {
  McpScope,
  McpServerCardActions,
  McpServerView,
  McpViewLevel,
} from "./types";

interface McpServerListProps {
  viewLevel: McpViewLevel;
  servers: McpServerView[];
  actions: McpServerCardActions;
  /** Which server IDs should render initially expanded. */
  openServerIds?: string[];
  /** Rendered when the list is empty. */
  emptyMessage?: string;
  /** Optional subtitle rendered above each scope group. */
  hideScopeGroups?: boolean;
}

const SCOPE_ORDER: McpScope[] = ["project", "global"];

const SCOPE_LABEL: Record<McpScope, string> = {
  project: "Project",
  global: "Global",
};

const SCOPE_HINT: Record<McpScope, string> = {
  project: "From this worktree's .mcp.json",
  global: "From Command Center global .mcp.json",
};

export default function McpServerList({
  viewLevel,
  servers,
  actions,
  openServerIds,
  emptyMessage,
  hideScopeGroups,
}: McpServerListProps): React.JSX.Element {
  const grouped = useMemo(() => {
    const byScope = new Map<McpScope, McpServerView[]>();
    for (const server of servers) {
      const bucket = byScope.get(server.scope) ?? [];
      bucket.push(server);
      byScope.set(server.scope, bucket);
    }
    return SCOPE_ORDER.flatMap((scope) => {
      const list = byScope.get(scope);
      if (!list || list.length === 0) return [];
      return [{ scope, servers: list }];
    });
  }, [servers]);

  if (servers.length === 0) {
    return (
      <div className="mcp-list-empty">
        {emptyMessage ?? "No MCP servers discovered for this level."}
      </div>
    );
  }

  const openSet = new Set(openServerIds ?? []);

  if (hideScopeGroups) {
    return (
      <div className="mcp-server-list">
        {servers.map((server) => (
          <McpServerCard
            key={`${server.scope}:${server.id}`}
            server={server}
            viewLevel={viewLevel}
            actions={actions}
            defaultOpen={openSet.has(server.id)}
          />
        ))}
      </div>
    );
  }

  return (
    <div className="mcp-server-list">
      {grouped.map(({ scope, servers: scopeServers }) => (
        <section key={scope} className="mcp-scope-group">
          <header className="mcp-scope-group__head">
            <span className="mcp-scope-group__label">
              {SCOPE_LABEL[scope].toUpperCase()}
            </span>
            <span className="mcp-scope-group__hint">{SCOPE_HINT[scope]}</span>
            <span className="mcp-scope-group__count">
              {scopeServers.length}
            </span>
          </header>
          <div className="mcp-scope-group__body">
            {scopeServers.map((server) => (
              <McpServerCard
                key={`${scope}:${server.id}`}
                server={server}
                viewLevel={viewLevel}
                actions={actions}
                defaultOpen={openSet.has(server.id)}
              />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
