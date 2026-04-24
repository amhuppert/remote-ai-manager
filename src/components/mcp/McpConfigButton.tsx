"use client";

import { useCallback, useRef, useState } from "react";
import McpConfigPopover from "./McpConfigPopover";
import type { McpServerCardActions, McpServerView } from "./types";

interface McpConfigButtonProps {
  servers: McpServerView[];
  actions: McpServerCardActions;
  hasPending?: boolean;
  pendingServerIds?: string[];
  disabled?: boolean;
  disabledTooltip?: string;
}

export default function McpConfigButton({
  servers,
  actions,
  hasPending,
  pendingServerIds,
  disabled,
  disabledTooltip,
}: McpConfigButtonProps): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const toggle = useCallback(() => {
    if (disabled) return;
    setOpen((prev) => !prev);
  }, [disabled]);

  const close = useCallback(() => setOpen(false), []);

  const total = servers.length;
  const enabled = servers.filter((s) => s.enabled).length;
  const overrides = servers.filter(
    (s) => s.status.kind === "overridden" || s.status.kind === "disabled",
  ).length;

  const label = total === 0 ? "MCP" : `MCP · ${enabled}/${total}`;
  const title =
    disabled && disabledTooltip
      ? disabledTooltip
      : overrides > 0
        ? `${overrides} override${overrides === 1 ? "" : "s"} at this conversation`
        : "MCP server configuration";

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={`mcp-config-trigger${open ? " open" : ""}${overrides > 0 ? " has-overrides" : ""}${hasPending ? " has-pending" : ""}`}
        onClick={toggle}
        disabled={disabled}
        aria-label={title}
        aria-expanded={open}
        title={title}
      >
        <svg
          className="mcp-config-trigger__icon"
          viewBox="0 0 16 16"
          aria-hidden="true"
          width="12"
          height="12"
        >
          <path
            fill="currentColor"
            d="M8 1.5a1.5 1.5 0 0 1 1.5 1.5v1.17a3.5 3.5 0 0 1 1.3.75l1.02-.59a1.5 1.5 0 0 1 2.05.55l.5.87a1.5 1.5 0 0 1-.55 2.05l-1.02.59a3.5 3.5 0 0 1 0 1.5l1.02.59a1.5 1.5 0 0 1 .55 2.05l-.5.87a1.5 1.5 0 0 1-2.05.55l-1.02-.59a3.5 3.5 0 0 1-1.3.75V13a1.5 1.5 0 0 1-1.5 1.5h-1A1.5 1.5 0 0 1 5.5 13v-1.17a3.5 3.5 0 0 1-1.3-.75l-1.02.59a1.5 1.5 0 0 1-2.05-.55l-.5-.87a1.5 1.5 0 0 1 .55-2.05l1.02-.59a3.5 3.5 0 0 1 0-1.5l-1.02-.59a1.5 1.5 0 0 1-.55-2.05l.5-.87a1.5 1.5 0 0 1 2.05-.55l1.02.59a3.5 3.5 0 0 1 1.3-.75V3A1.5 1.5 0 0 1 6.5 1.5h1ZM8 6a2 2 0 1 0 0 4 2 2 0 0 0 0-4Z"
          />
        </svg>
        <span className="mcp-config-trigger__label">{label}</span>
        {overrides > 0 ? (
          <span
            className="mcp-config-trigger__dot"
            aria-label={`${overrides} override${overrides === 1 ? "" : "s"}`}
          />
        ) : null}
        {hasPending ? (
          <span
            className="mcp-pending-dot"
            aria-label="Pending changes"
            title="Changes will apply on next turn"
          />
        ) : null}
      </button>

      <McpConfigPopover
        anchorRef={triggerRef}
        open={open}
        onClose={close}
        servers={servers}
        actions={actions}
        hasPending={hasPending}
        pendingServerIds={pendingServerIds}
      />
    </>
  );
}
