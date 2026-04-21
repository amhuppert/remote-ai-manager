"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import McpInheritBadge from "./McpInheritBadge";
import McpToolRow from "./McpToolRow";
import type {
  McpServerCardActions,
  McpServerView,
  McpViewLevel,
} from "./types";

export interface McpServerCardProps {
  /** Which level is viewing this card. Determines badge text and editability. */
  viewLevel: McpViewLevel;
  server: McpServerView;
  actions: McpServerCardActions;
  /** Controls whether the card is initially expanded. */
  defaultOpen?: boolean;
}

function backendLabel(backend: McpServerView["backend"]): string {
  if (backend === "claude") return "Claude";
  if (backend === "codex") return "Codex";
  return "Shared";
}

function truncatePath(path: string, maxLen = 48): string {
  if (path.length <= maxLen) return path;
  const keepStart = 10;
  const keepEnd = maxLen - keepStart - 1;
  return `${path.slice(0, keepStart)}…${path.slice(-keepEnd)}`;
}

function toolSummary(server: McpServerView): string {
  const d = server.toolDiscovery;
  if (d.kind === "loaded") {
    const on = d.tools.filter((t) => t.enabled).length;
    return `${d.tools.length} tools · ${on} enabled`;
  }
  if (d.kind === "loading") return "Discovering tools…";
  if (d.kind === "error") return "Tool discovery failed";
  return "Tools not yet discovered";
}

export default function McpServerCard({
  viewLevel,
  server,
  actions,
  defaultOpen,
}: McpServerCardProps): React.JSX.Element {
  const [open, setOpen] = useState<boolean>(defaultOpen ?? false);
  const discoveryRequestedRef = useRef<boolean>(
    server.toolDiscovery.kind === "loaded" ||
      server.toolDiscovery.kind === "loading",
  );

  useEffect(() => {
    if (
      open &&
      !discoveryRequestedRef.current &&
      server.toolDiscovery.kind === "idle"
    ) {
      discoveryRequestedRef.current = true;
      actions.onExpand?.(server.id);
    }
  }, [open, server.toolDiscovery.kind, server.id, actions]);

  const { status } = server;
  const isInherited = status.kind === "inherited";
  const isDisabled = status.kind === "disabled";
  const isOverridden = status.kind === "overridden";
  const isIncompatible = server.backendCompatibility?.compatible === false;

  const toggleLocked = isIncompatible;

  const handleHeadClick = useCallback(() => {
    setOpen((prev) => !prev);
  }, []);

  const handleToggle = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      if (toggleLocked) return;
      actions.onToggleEnabled?.(server.id, !server.enabled);
    },
    [actions, server.id, server.enabled, toggleLocked],
  );

  const handleReset = useCallback(() => {
    actions.onResetToInherit?.(server.id);
  }, [actions, server.id]);

  const handleOverride = useCallback(() => {
    actions.onOverride?.(server.id);
  }, [actions, server.id]);

  const handleRefresh = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      actions.onRefreshTools?.(server.id);
    },
    [actions, server.id],
  );

  const cardClass = [
    "mcp-server-card",
    `mcp-server-card--source-${status.kind}`,
    isIncompatible ? "mcp-server-card--incompatible" : "",
    !server.enabled ? "mcp-server-card--off" : "",
    server.pending ? "mcp-server-card--pending" : "",
    open ? "mcp-server-card--open" : "",
  ]
    .filter(Boolean)
    .join(" ");

  const statusDotClass = (() => {
    if (isIncompatible) return "mcp-status-dot mcp-status-dot--warning";
    if (server.runtimeError) return "mcp-status-dot mcp-status-dot--error";
    if (!server.enabled) return "mcp-status-dot mcp-status-dot--off";
    return "mcp-status-dot mcp-status-dot--on";
  })();

  // Tool toggles stay interactive on inherited rows so a user can change a
  // single tool without first overriding the whole server — the per-tool
  // mutation auto-promotes at the current scope. Tools render read-only only
  // when the server is effectively off (handled via parent-disabled styling).
  const showResetServer = isOverridden || isDisabled;

  return (
    <div
      className={cardClass}
      data-source={status.kind}
      data-server-id={server.id}
    >
      <button
        type="button"
        className="mcp-server-card__head"
        aria-expanded={open}
        aria-controls={`mcp-server-body--${server.id}`}
        onClick={handleHeadClick}
      >
        <span
          className={`cc-section-chevron${open ? "" : " collapsed"}`}
          aria-hidden="true"
        >
          ▾
        </span>
        <span className={statusDotClass} aria-hidden="true" />
        <span className="mcp-server-card__name">{server.name}</span>
        <span className="mcp-server-card__summary">{toolSummary(server)}</span>
        {server.pending ? (
          <span
            className="mcp-pending-dot"
            title="Change will apply on next turn"
            aria-label="Pending"
          />
        ) : null}
        <McpInheritBadge status={status} viewLevel={viewLevel} />
        <span
          role="switch"
          tabIndex={0}
          aria-checked={server.enabled}
          aria-label={`${server.enabled ? "Disable" : "Enable"} ${server.name}`}
          aria-disabled={toggleLocked || undefined}
          className={`mcp-server-toggle${server.enabled ? " active" : ""}${toggleLocked ? " locked" : ""}`}
          onClick={handleToggle}
          onKeyDown={(e) => {
            if (e.key === " " || e.key === "Enter") {
              e.preventDefault();
              e.stopPropagation();
              if (!toggleLocked) {
                actions.onToggleEnabled?.(server.id, !server.enabled);
              }
            }
          }}
        >
          <span className="mcp-server-toggle-track">
            <span className="mcp-server-toggle-knob" />
          </span>
        </span>
      </button>

      <div
        id={`mcp-server-body--${server.id}`}
        className="mcp-server-card__body"
        hidden={!open}
      >
        <div className="mcp-server-card__meta">
          <span className="mcp-server-card__meta-label">SOURCE</span>
          <span className="mcp-server-card__path" title={server.sourceFile}>
            {truncatePath(server.sourceFile)}
          </span>
          <span className="mcp-server-card__meta-sep">·</span>
          <span className="mcp-server-card__backend">
            {backendLabel(server.backend)}
          </span>
          <span className="mcp-server-card__meta-sep">·</span>
          <span className="mcp-server-card__scope">
            {server.scope.toUpperCase()}
          </span>
        </div>

        {isIncompatible && server.backendCompatibility?.reason ? (
          <div className="mcp-server-card__warn" role="status">
            <span className="mcp-warn-icon" aria-hidden>
              ⚠
            </span>
            <span>{server.backendCompatibility.reason}</span>
          </div>
        ) : null}

        {server.runtimeError ? (
          <div className="mcp-server-card__error" role="alert">
            <span className="mcp-err-icon" aria-hidden>
              ✕
            </span>
            <span>{server.runtimeError}</span>
          </div>
        ) : null}

        <div className="mcp-server-card__tools">
          <div className="mcp-server-card__tools-head">
            <span className="cc-section-label">TOOLS</span>
            <span className="mcp-server-card__tools-count">
              {toolSummary(server)}
            </span>
            {actions.onRefreshTools ? (
              <button
                type="button"
                className="mcp-icon-btn"
                onClick={handleRefresh}
                title="Refresh tool list"
                aria-label="Refresh tool list"
              >
                ↻
              </button>
            ) : null}
          </div>

          <McpToolList
            serverId={server.id}
            viewLevel={viewLevel}
            discovery={server.toolDiscovery}
            serverDisabled={!server.enabled}
            readonly={false}
            onToggle={actions.onToggleTool}
            onReset={actions.onResetTool}
          />
        </div>

        <div className="mcp-server-card__foot">
          {isInherited && actions.onOverride ? (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={handleOverride}
            >
              Override at {viewLevel}
            </button>
          ) : null}

          {showResetServer && actions.onResetToInherit ? (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={handleReset}
            >
              {isDisabled ? "Re-enable (inherit)" : "Reset to inherit"}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

interface McpToolListProps {
  serverId: string;
  viewLevel: McpViewLevel;
  discovery: McpServerView["toolDiscovery"];
  serverDisabled: boolean;
  readonly: boolean;
  onToggle?: McpServerCardActions["onToggleTool"];
  onReset?: McpServerCardActions["onResetTool"];
}

function McpToolList({
  serverId,
  viewLevel,
  discovery,
  serverDisabled,
  readonly,
  onToggle,
  onReset,
}: McpToolListProps): React.JSX.Element {
  if (discovery.kind === "idle") {
    return (
      <div className="mcp-tool-placeholder mcp-tool-placeholder--idle">
        Tools will load when the server is first used, or click ↻ to discover
        now.
      </div>
    );
  }
  if (discovery.kind === "loading") {
    return (
      <div className="mcp-tool-list" aria-busy="true">
        {[0, 1, 2].map((i) => (
          <div
            key={i}
            className="mcp-tool-skeleton"
            style={{ animationDelay: `${i * 80}ms` }}
          />
        ))}
      </div>
    );
  }
  if (discovery.kind === "error") {
    return (
      <div className="mcp-tool-placeholder mcp-tool-placeholder--error">
        <span className="mcp-err-icon" aria-hidden>
          ✕
        </span>
        <span>Tool discovery failed: {discovery.message}</span>
      </div>
    );
  }
  if (discovery.tools.length === 0) {
    return (
      <div className="mcp-tool-placeholder">This server exposes no tools.</div>
    );
  }
  return (
    <div className="mcp-tool-list">
      {discovery.tools.map((tool) => (
        <McpToolRow
          key={tool.name}
          serverId={serverId}
          viewLevel={viewLevel}
          tool={tool}
          serverDisabled={serverDisabled}
          readonly={readonly}
          onToggle={onToggle}
          onReset={onReset}
        />
      ))}
    </div>
  );
}
