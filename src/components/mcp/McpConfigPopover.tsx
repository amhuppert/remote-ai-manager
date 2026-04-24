"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import McpServerList from "./McpServerList";
import type { McpServerCardActions, McpServerView } from "./types";

interface McpConfigPopoverProps {
  /** Reference to the trigger button — used to anchor the popover. */
  anchorRef: React.RefObject<HTMLElement | null>;
  open: boolean;
  onClose(): void;
  /** Servers resolved at the conversation view level. */
  servers: McpServerView[];
  actions: McpServerCardActions;
  /** When true, a "change pending — applies next turn" banner is shown. */
  hasPending?: boolean;
  /** Servers with changes pending relative to the last emission. */
  pendingServerIds?: string[];
}

export default function McpConfigPopover({
  anchorRef,
  open,
  onClose,
  servers,
  actions,
  hasPending,
  pendingServerIds,
}: McpConfigPopoverProps): React.JSX.Element | null {
  const popoverRef = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState<React.CSSProperties>({});

  useLayoutEffect(() => {
    if (!open || !anchorRef.current) return;
    const rect = anchorRef.current.getBoundingClientRect();
    const width = Math.min(480, window.innerWidth - 24);
    const right = Math.max(12, window.innerWidth - rect.right);
    setStyle({
      position: "fixed",
      bottom: window.innerHeight - rect.top + 8,
      right,
      width,
      maxHeight: Math.min(640, window.innerHeight - 80),
    });
  }, [open, anchorRef]);

  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      const target = e.target as Node;
      if (popoverRef.current?.contains(target)) return;
      if (anchorRef.current?.contains(target)) return;
      onClose();
    }
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("mousedown", handleClick);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleKey);
    };
  }, [open, onClose, anchorRef]);

  const summary = summarise(servers);
  const pendingCount = pendingServerIds?.length ?? 0;

  if (!open || typeof document === "undefined") return null;

  const body = (
    <div
      ref={popoverRef}
      className="mcp-config-popover"
      style={style}
      role="dialog"
      aria-label="MCP configuration"
    >
      <header className="mcp-config-popover__head">
        <div className="mcp-config-popover__title">
          <span className="mcp-config-popover__eyebrow">CONVERSATION</span>
          <span className="mcp-config-popover__heading">MCP Servers</span>
        </div>
        <span className="mcp-config-popover__summary">{summary}</span>
        <button
          type="button"
          className="mcp-config-popover__close"
          onClick={onClose}
          aria-label="Close"
        >
          ×
        </button>
      </header>

      {hasPending || pendingCount > 0 ? (
        <div className="mcp-config-popover__pending" role="status">
          <span className="mcp-pending-dot" aria-hidden />
          <span>
            {pendingCount > 0
              ? `${pendingCount} change${pendingCount === 1 ? "" : "s"} queued — will apply on next turn`
              : "Changes will apply on next turn"}
          </span>
        </div>
      ) : null}

      <div className="mcp-config-popover__body">
        <McpServerList
          viewLevel="conversation"
          servers={servers}
          actions={actions}
        />
      </div>
    </div>
  );

  return createPortal(body, document.body);
}

function summarise(servers: McpServerView[]): string {
  const total = servers.length;
  const on = servers.filter((s) => s.enabled).length;
  const overrides = servers.filter(
    (s) => s.status.kind === "overridden" || s.status.kind === "disabled",
  ).length;
  if (overrides > 0) {
    return `${on}/${total} enabled · ${overrides} override${overrides === 1 ? "" : "s"}`;
  }
  return `${on}/${total} enabled`;
}
