"use client";

import McpServerList from "./McpServerList";
import type { McpServerCardActions, McpServerView } from "./types";

interface McpGlobalSectionProps {
  /** Global MCP servers from Command Center's `.mcp.json`. */
  servers: McpServerView[];
  actions: McpServerCardActions;
  /** Displayed in the sub-heading, e.g. a warning when discovery failed. */
  notice?: React.ReactNode;
}

export default function McpGlobalSection({
  servers,
  actions,
  notice,
}: McpGlobalSectionProps): React.JSX.Element {
  const total = servers.length;
  const on = servers.filter((s) => s.enabled).length;
  const overrides = servers.filter((s) => s.status.kind === "disabled").length;

  return (
    <section className="mcp-global-section">
      <header className="mcp-global-section__head">
        <div className="mcp-global-section__headings">
          <h2 className="mcp-global-section__title">MCP Servers</h2>
          <p className="mcp-global-section__subtitle">
            Global MCP servers from Command Center&apos;s <code>.mcp.json</code>
            . Project worktrees can add or override these definitions with their
            own <code>.mcp.json</code> files. Command Center manages
            enable/disable state separately.
          </p>
        </div>
        <div className="mcp-global-section__meta">
          <span className="mcp-global-section__stat">
            <strong>{on}</strong>/{total} enabled
          </span>
          {overrides > 0 ? (
            <span className="mcp-global-section__stat mcp-global-section__stat--overrides">
              <strong>{overrides}</strong> disabled at global
            </span>
          ) : null}
        </div>
      </header>

      {notice ? (
        <div className="mcp-global-section__notice">{notice}</div>
      ) : null}

      <div className="mcp-global-section__body">
        <McpServerList
          viewLevel="global"
          servers={servers}
          actions={actions}
          hideScopeGroups
          emptyMessage="No global MCP servers configured. Add entries to Command Center's .mcp.json to get started."
        />
      </div>
    </section>
  );
}
