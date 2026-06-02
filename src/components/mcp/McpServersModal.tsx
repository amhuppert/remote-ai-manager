"use client";

import { useCallback, useEffect } from "react";
import { createPortal } from "react-dom";
import { useOverlayScope } from "@/hooks/useOverlayScope";
import McpServerList from "./McpServerList";
import type {
  McpServerCardActions,
  McpServerView,
  McpViewLevel,
} from "./types";

interface McpServersModalProps {
  open: boolean;
  onClose(): void;
  /** View level for inheritance labelling (project | session). */
  viewLevel: Exclude<McpViewLevel, "global" | "conversation">;
  servers: McpServerView[];
  actions: McpServerCardActions;
  /** Headline shown at the top of the modal (e.g. "Session MCP configuration"). */
  title: string;
  /** Sub-headline giving context (e.g. the project or session name). */
  subtitle?: string;
  /** Optional banner (e.g. "Changes apply to next turn in active conversations"). */
  banner?: React.ReactNode;
}

export default function McpServersModal({
  open,
  onClose,
  viewLevel,
  servers,
  actions,
  title,
  subtitle,
  banner,
}: McpServersModalProps): React.JSX.Element | null {
  const handleKey = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    },
    [onClose],
  );

  useEffect(() => {
    if (!open) return;
    document.addEventListener("keydown", handleKey, { capture: true });
    return () =>
      document.removeEventListener("keydown", handleKey, { capture: true });
  }, [open, handleKey]);

  useOverlayScope(open);

  if (!open || typeof document === "undefined") return null;

  const total = servers.length;
  const on = servers.filter((s) => s.enabled).length;
  const overrides = servers.filter(
    (s) => s.status.kind === "overridden" || s.status.kind === "disabled",
  ).length;

  const overlay = (
    <div
      className="modal-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal mcp-servers-modal" role="dialog" aria-label={title}>
        <header className="mcp-servers-modal__head">
          <div className="mcp-servers-modal__headings">
            <span className="mcp-servers-modal__eyebrow">
              {viewLevel.toUpperCase()}
            </span>
            <h2 className="mcp-servers-modal__title">{title}</h2>
            {subtitle ? (
              <span className="mcp-servers-modal__subtitle">{subtitle}</span>
            ) : null}
          </div>
          <div className="mcp-servers-modal__meta">
            <span className="mcp-servers-modal__stat">
              <strong>{on}</strong>/{total} enabled
            </span>
            {overrides > 0 ? (
              <span className="mcp-servers-modal__stat mcp-servers-modal__stat--overrides">
                <strong>{overrides}</strong> override
                {overrides === 1 ? "" : "s"}
              </span>
            ) : null}
          </div>
          <button
            type="button"
            className="mcp-servers-modal__close"
            onClick={onClose}
            aria-label="Close"
          >
            ×
          </button>
        </header>

        {banner ? (
          <div className="mcp-servers-modal__banner">{banner}</div>
        ) : null}

        <div className="mcp-servers-modal__body">
          <McpServerList
            viewLevel={viewLevel}
            servers={servers}
            actions={actions}
          />
        </div>
      </div>
    </div>
  );

  return createPortal(overlay, document.body);
}
