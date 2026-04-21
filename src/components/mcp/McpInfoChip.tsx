"use client";

import type { McpServerView } from "./types";

interface McpInfoChipProps {
  servers: McpServerView[];
  onClick(): void;
  /** Tighter spacing for info strips. */
  compact?: boolean;
}

/**
 * Small pill summarising the MCP state at a given level. Shows total/enabled
 * counts and an amber accent when overrides exist at this level. Clicking
 * opens the owning surface (session or project modal).
 */
export default function McpInfoChip({
  servers,
  onClick,
  compact,
}: McpInfoChipProps): React.JSX.Element {
  const total = servers.length;
  const on = servers.filter((s) => s.enabled).length;
  const overrides = servers.filter(
    (s) => s.status.kind === "overridden" || s.status.kind === "disabled",
  ).length;
  const hasPending = servers.some((s) => s.pending);

  const label = total === 0 ? "MCP · none" : `MCP · ${on}/${total}`;
  const title =
    overrides > 0
      ? `${on} of ${total} enabled — ${overrides} override${overrides === 1 ? "" : "s"} at this level`
      : `${on} of ${total} MCP server${total === 1 ? "" : "s"} enabled`;

  return (
    <button
      type="button"
      onClick={onClick}
      className={`mcp-info-chip${overrides > 0 ? " has-overrides" : ""}${compact ? " compact" : ""}`}
      title={title}
      aria-label={title}
    >
      <span className="mcp-info-chip__dot" aria-hidden />
      <span className="mcp-info-chip__label">{label}</span>
      {overrides > 0 ? (
        <span className="mcp-info-chip__badge" aria-hidden>
          {overrides}
        </span>
      ) : null}
      {hasPending ? (
        <span
          className="mcp-pending-dot"
          aria-label="Pending changes"
          title="Changes will apply on next turn"
        />
      ) : null}
    </button>
  );
}
