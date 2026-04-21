"use client";

import McpInheritBadge from "./McpInheritBadge";
import type { McpToolView, McpViewLevel } from "./types";

interface McpToolRowProps {
  serverId: string;
  viewLevel: McpViewLevel;
  tool: McpToolView;
  /** Is the parent server effectively disabled? Controls the dim/lock treatment. */
  serverDisabled: boolean;
  /** Readonly surface (e.g. inherited server row). */
  readonly?: boolean;
  onToggle?(serverId: string, toolName: string, nextEnabled: boolean): void;
  onReset?(serverId: string, toolName: string): void;
}

export default function McpToolRow({
  serverId,
  viewLevel,
  tool,
  serverDisabled,
  readonly = false,
  onToggle,
  onReset,
}: McpToolRowProps): React.JSX.Element {
  const canEdit = !readonly && !serverDisabled;
  const handleToggle = () => {
    if (!canEdit) return;
    onToggle?.(serverId, tool.name, !tool.enabled);
  };
  const handleReset = () => {
    if (!canEdit) return;
    onReset?.(serverId, tool.name);
  };

  const canReset =
    tool.status.kind === "overridden" || tool.status.kind === "disabled";

  const rowClass = [
    "mcp-tool-row",
    `mcp-tool-row--source-${tool.status.kind}`,
    serverDisabled ? "mcp-tool-row--parent-disabled" : "",
    !tool.enabled ? "mcp-tool-row--off" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={rowClass}>
      <button
        type="button"
        className={`mcp-tool-toggle${tool.enabled ? " active" : ""}`}
        role="switch"
        aria-checked={tool.enabled}
        aria-label={`${tool.enabled ? "Disable" : "Enable"} tool ${tool.name}`}
        disabled={!canEdit}
        onClick={handleToggle}
      >
        <span className="mcp-tool-toggle-track">
          <span className="mcp-tool-toggle-knob" />
        </span>
      </button>
      <div className="mcp-tool-row-main">
        <span className="mcp-tool-name">{tool.name}</span>
        {tool.description ? (
          <span className="mcp-tool-desc">{tool.description}</span>
        ) : null}
      </div>
      <div className="mcp-tool-row-meta">
        {tool.pending ? (
          <span
            className="mcp-pending-dot"
            title="Change will apply on next turn"
            aria-label="Pending"
          />
        ) : null}
        <McpInheritBadge status={tool.status} viewLevel={viewLevel} size="sm" />
        {canReset && onReset ? (
          <button
            type="button"
            className="mcp-tool-reset"
            onClick={handleReset}
            title="Reset to inherited value"
            aria-label={`Reset ${tool.name} to inherited value`}
          >
            ↺
          </button>
        ) : null}
      </div>
    </div>
  );
}
