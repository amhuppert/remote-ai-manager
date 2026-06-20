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
    <section>
      <header className="mb-md flex items-start gap-md">
        <div className="min-w-0 flex-1">
          <h2 className="m-0 mb-[0.3rem] font-mono text-[0.95rem] font-semibold text-text-primary">
            MCP Servers
          </h2>
          <p className="m-0 font-body text-[0.8rem] leading-[1.5] text-[var(--text-muted)] [&_code]:rounded-[2px] [&_code]:bg-bg-surface [&_code]:px-[0.3rem] [&_code]:py-[0.05rem] [&_code]:font-mono [&_code]:text-text-secondary">
            Global MCP servers from Command Center&apos;s <code>.mcp.json</code>
            . Project worktrees can add or override these definitions with their
            own <code>.mcp.json</code> files. Command Center manages
            enable/disable state separately.
          </p>
        </div>
        <div className="flex flex-col items-end gap-[0.25rem]">
          <span className="font-mono text-[0.72rem] whitespace-nowrap text-text-secondary">
            <strong>{on}</strong>/{total} enabled
          </span>
          {overrides > 0 ? (
            <span className="font-mono text-[0.72rem] whitespace-nowrap text-[var(--accent-cyan)]">
              <strong>{overrides}</strong> disabled at global
            </span>
          ) : null}
        </div>
      </header>

      {notice ? (
        <div className="mb-md rounded-[4px] border border-solid border-border-subtle bg-bg-surface px-md py-xs font-mono text-[0.72rem] text-[var(--text-muted)]">
          {notice}
        </div>
      ) : null}

      <div className="flex flex-col gap-sm">
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
