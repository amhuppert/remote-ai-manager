"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { DevServerRuntimeState } from "@/types";

// ── Types ──────────────────────────────────────────────────────

export interface DevServerDrawerProps {
  open: boolean;
  servers: DevServerRuntimeState[];
  onClose: () => void;
  onToggle: () => void;
  onStart: (name: string) => void;
  onStop: (name: string) => void;
  onStartAll: () => void;
  onStopAll: () => void;
}

// ── Icons ──────────────────────────────────────────────────────

function ServerIcon() {
  return (
    <svg
      width={14}
      height={14}
      viewBox="0 0 14 14"
      fill="none"
      className="ds-trigger-icon"
    >
      <rect
        x="1.5"
        y="1.5"
        width="11"
        height="4.5"
        rx="1.2"
        stroke="currentColor"
        strokeWidth="1.1"
      />
      <rect
        x="1.5"
        y="8"
        width="11"
        height="4.5"
        rx="1.2"
        stroke="currentColor"
        strokeWidth="1.1"
      />
      <circle cx="4" cy="3.75" r="0.7" fill="currentColor" />
      <circle cx="4" cy="10.25" r="0.7" fill="currentColor" />
    </svg>
  );
}

// ── Sub-components ─────────────────────────────────────────────

function StatusDot({ status }: { status: DevServerRuntimeState["status"] }) {
  return <span className={`ds-dot ds-dot-${status}`} />;
}

function ServerRow({
  server,
  onStart,
  onStop,
}: {
  server: DevServerRuntimeState;
  onStart: () => void;
  onStop: () => void;
}) {
  const isActive = server.status === "running" || server.status === "starting";

  return (
    <div className="ds-row">
      <div className="ds-row-info">
        <StatusDot status={server.status} />
        {server.remoteUrl && server.status === "running" ? (
          <a
            href={server.remoteUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="ds-name ds-name-link"
            onClick={(e) => e.stopPropagation()}
          >
            {server.serverName}
          </a>
        ) : (
          <span className="ds-name">{server.serverName}</span>
        )}
        <span className="ds-status-text">{server.status}</span>
        {server.port != null && <span className="ds-port">:{server.port}</span>}
        {server.source === "external-adopted" && (
          <span
            className="ds-source-tag"
            title={
              server.ownerPid != null
                ? `Adopted external listener (pid ${server.ownerPid})`
                : "Adopted external listener"
            }
          >
            adopted
          </span>
        )}
      </div>
      <div className="ds-row-actions">
        {isActive ? (
          <button className="btn btn-sm" onClick={onStop} type="button">
            Stop
          </button>
        ) : (
          <button
            className="btn btn-sm btn-primary"
            onClick={onStart}
            type="button"
          >
            Start
          </button>
        )}
      </div>
      {server.status === "error" && server.errorMessage && (
        <div className="ds-error">
          <pre className="ds-error-output">
            {server.errorMessage.slice(0, 500)}
          </pre>
        </div>
      )}
    </div>
  );
}

// ── Main Component ─────────────────────────────────────────────

export default function DevServerDrawer({
  open,
  servers,
  onClose,
  onToggle,
  onStart,
  onStop,
  onStartAll,
  onStopAll,
}: DevServerDrawerProps) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [panelPos, setPanelPos] = useState<{ top: number; right: number }>({
    top: 0,
    right: 0,
  });

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [open, onClose]);

  // Position panel below trigger when opening
  useEffect(() => {
    if (!open || !triggerRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    setPanelPos({
      top: rect.bottom + 4,
      right: window.innerWidth - rect.right,
    });
  }, [open]);

  const runningCount = servers.filter(
    (s) => s.status === "running" || s.status === "starting",
  ).length;
  const hasStoppable = servers.some(
    (s) => s.status === "running" || s.status === "starting",
  );
  const hasStopped = servers.some(
    (s) => s.status === "stopped" || s.status === "error",
  );
  const hasError = servers.some((s) => s.status === "error");
  const hasRunning = runningCount > 0;

  if (servers.length === 0) return null;

  const triggerClass = [
    "ds-trigger",
    hasRunning && "ds-trigger-active",
    hasError && !hasRunning && "ds-trigger-error",
    open && "ds-trigger-open",
  ]
    .filter(Boolean)
    .join(" ");

  const dotClass = hasRunning
    ? "ds-trigger-dot running"
    : hasError
      ? "ds-trigger-dot error"
      : "ds-trigger-dot";

  return (
    <div className="ds-wrapper">
      {/* Inline trigger button */}
      <button
        ref={triggerRef}
        className={triggerClass}
        onClick={onToggle}
        type="button"
      >
        <span className={dotClass} />
        <span className="ds-trigger-label">
          {hasRunning
            ? `${runningCount}/${servers.length}`
            : hasError
              ? "err"
              : "off"}
        </span>
        <ServerIcon />
      </button>

      {/* Panel + backdrop rendered via portal to escape topbar stacking context */}
      {open &&
        createPortal(
          <>
            <div className="ds-backdrop" onClick={onClose} />
            <div
              className="ds-panel"
              style={{ top: panelPos.top, right: panelPos.right }}
            >
              <div className="ds-header">
                <span className="ds-title">Dev Servers</span>
                <button
                  className="ds-close"
                  onClick={onClose}
                  type="button"
                  title="Close"
                >
                  &#10005;
                </button>
              </div>
              <div className="ds-body">
                {servers.map((server) => (
                  <ServerRow
                    key={server.serverName}
                    server={server}
                    onStart={() => onStart(server.serverName)}
                    onStop={() => onStop(server.serverName)}
                  />
                ))}
              </div>
              {(hasStopped || hasStoppable) && (
                <div className="ds-footer">
                  {hasStopped && (
                    <button
                      className="btn btn-sm btn-primary"
                      onClick={onStartAll}
                      type="button"
                    >
                      Start All
                    </button>
                  )}
                  {hasStoppable && (
                    <button
                      className="btn btn-sm"
                      onClick={onStopAll}
                      type="button"
                    >
                      Stop All
                    </button>
                  )}
                </div>
              )}
            </div>
          </>,
          document.body,
        )}
    </div>
  );
}
