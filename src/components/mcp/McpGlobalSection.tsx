"use client";

import McpServerList from "./McpServerList";
import type {
  McpBackendId,
  McpServerCardActions,
  McpServerView,
} from "./types";

interface McpGlobalSectionProps {
  /** User-level servers from ~/.claude/settings.json and ~/.codex/config.toml. */
  servers: McpServerView[];
  actions: McpServerCardActions;
  backendFilter?: McpBackendId | "all";
  onBackendFilterChange?(filter: McpBackendId | "all"): void;
  /** Displayed in the sub-heading, e.g. a warning when discovery failed. */
  notice?: React.ReactNode;
}

export default function McpGlobalSection({
  servers,
  actions,
  backendFilter = "all",
  onBackendFilterChange,
  notice,
}: McpGlobalSectionProps): React.JSX.Element {
  const visible =
    backendFilter === "all"
      ? servers
      : servers.filter(
          (s) => s.backend === backendFilter || s.backend === "shared",
        );

  const total = servers.length;
  const on = servers.filter((s) => s.enabled).length;
  const overrides = servers.filter((s) => s.status.kind === "disabled").length;

  return (
    <section className="mcp-global-section">
      <header className="mcp-global-section__head">
        <div className="mcp-global-section__headings">
          <h2 className="mcp-global-section__title">MCP Servers</h2>
          <p className="mcp-global-section__subtitle">
            User-level MCP servers from <code>~/.claude/settings.json</code> and{" "}
            <code>~/.codex/config.toml</code>. These are read-only here — edit
            the source files to add or remove servers. Command Center manages
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

      {onBackendFilterChange ? (
        <div className="mcp-global-section__filters">
          {(["all", "claude", "codex"] as const).map((f) => (
            <button
              key={f}
              type="button"
              className={`mcp-filter-chip${f === backendFilter ? " active" : ""}`}
              onClick={() => onBackendFilterChange(f)}
            >
              {f === "all" ? "All" : f === "claude" ? "Claude" : "Codex"}
            </button>
          ))}
        </div>
      ) : null}

      <div className="mcp-global-section__body">
        <McpServerList
          viewLevel="global"
          servers={visible}
          actions={actions}
          hideScopeGroups
          emptyMessage="No user-level MCP servers configured. Add entries to ~/.claude/settings.json or ~/.codex/config.toml to get started."
        />
      </div>
    </section>
  );
}
