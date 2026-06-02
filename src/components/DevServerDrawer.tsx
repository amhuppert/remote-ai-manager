"use client";

import { useEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { useOverlayScope } from "@/hooks/useOverlayScope";
import type { DevServerRuntimeState } from "@/lib/dev-server/schemas";

export interface UnmanagedConflictInfo {
  serverName: string;
  port: number;
  pid: number;
  cwd: string;
}

export interface DevServerDrawerProps {
  open: boolean;
  servers: DevServerRuntimeState[];
  onClose: () => void;
  onToggle: () => void;
  onStart: (name: string) => void;
  onStop: (name: string) => void;
  onStartAll: () => void;
  onStopAll: () => void;
  unmanagedConflict?: UnmanagedConflictInfo | null;
  onDismissUnmanagedConflict?: () => void;
  onStopUnmanagedAndRetry?: () => void;
  isStoppingUnmanaged?: boolean;
}

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

export interface DevServerPanelProps extends Omit<
  DevServerDrawerProps,
  "onToggle"
> {
  /** Position the panel below this element. */
  anchorRef: RefObject<HTMLElement | null>;
}

function UnmanagedConflictDialog({
  conflict,
  onCancel,
  onRetry,
  onStop,
  isStopping,
}: {
  conflict: UnmanagedConflictInfo;
  onCancel: () => void;
  onRetry: () => void;
  onStop: () => void;
  isStopping: boolean;
}) {
  return (
    <div
      className="ds-conflict"
      role="dialog"
      aria-label="Unmanaged dev server detected"
    >
      <div className="ds-conflict-title">
        Port {conflict.port} already in use
      </div>
      <div className="ds-conflict-body">
        Another process (pid {conflict.pid}) inside this worktree is listening
        on port {conflict.port}. Command Center didn&apos;t start it, so it
        won&apos;t be managed here.
      </div>
      <div className="ds-conflict-meta">
        <div>
          <span className="ds-conflict-meta-label">cwd:</span>{" "}
          <code>{conflict.cwd}</code>
        </div>
      </div>
      <div className="ds-conflict-actions">
        <button
          type="button"
          className="btn btn-sm"
          onClick={onCancel}
          disabled={isStopping}
        >
          Cancel
        </button>
        <button
          type="button"
          className="btn btn-sm"
          onClick={onRetry}
          disabled={isStopping}
        >
          Try Again
        </button>
        <button
          type="button"
          className="btn btn-sm btn-danger"
          onClick={onStop}
          disabled={isStopping}
        >
          {isStopping ? "Stopping…" : "Stop Server & Retry"}
        </button>
      </div>
    </div>
  );
}

export function DevServerPanel({
  open,
  servers,
  onClose,
  onStart,
  onStop,
  onStartAll,
  onStopAll,
  anchorRef,
  unmanagedConflict,
  onDismissUnmanagedConflict,
  onStopUnmanagedAndRetry,
  isStoppingUnmanaged = false,
}: DevServerPanelProps): React.JSX.Element | null {
  const [panelPos, setPanelPos] = useState<{ top: number; right: number }>({
    top: 0,
    right: 0,
  });

  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [open, onClose]);

  useEffect(() => {
    if (!open) return;
    const el = anchorRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    setPanelPos({
      top: rect.bottom + 4,
      right: window.innerWidth - rect.right,
    });
  }, [open, anchorRef]);

  useOverlayScope(open);

  if (!open) return null;

  const hasStoppable = servers.some(
    (s) => s.status === "running" || s.status === "starting",
  );
  const hasStopped = servers.some(
    (s) => s.status === "stopped" || s.status === "error",
  );

  return createPortal(
    <>
      <div className="ds-backdrop" onClick={onClose} />
      <div
        className="ds-panel"
        style={{ top: panelPos.top, right: panelPos.right }}
        role="dialog"
        aria-label="Dev servers"
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
          {unmanagedConflict && (
            <UnmanagedConflictDialog
              conflict={unmanagedConflict}
              onCancel={onDismissUnmanagedConflict ?? (() => {})}
              onRetry={() => {
                onDismissUnmanagedConflict?.();
                onStart(unmanagedConflict.serverName);
              }}
              onStop={onStopUnmanagedAndRetry ?? (() => {})}
              isStopping={isStoppingUnmanaged}
            />
          )}
          {servers.length === 0 ? (
            <div className="ds-empty">No dev servers configured</div>
          ) : (
            servers.map((server) => (
              <ServerRow
                key={server.serverName}
                server={server}
                onStart={() => onStart(server.serverName)}
                onStop={() => onStop(server.serverName)}
              />
            ))
          )}
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
              <button className="btn btn-sm" onClick={onStopAll} type="button">
                Stop All
              </button>
            )}
          </div>
        )}
      </div>
    </>,
    document.body,
  );
}

export default function DevServerDrawer({
  open,
  servers,
  onClose,
  onToggle,
  onStart,
  onStop,
  onStartAll,
  onStopAll,
  unmanagedConflict = null,
  onDismissUnmanagedConflict,
  onStopUnmanagedAndRetry,
  isStoppingUnmanaged = false,
}: DevServerDrawerProps) {
  const triggerRef = useRef<HTMLButtonElement>(null);

  const runningCount = servers.filter(
    (s) => s.status === "running" || s.status === "starting",
  ).length;
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
      <DevServerPanel
        open={open}
        servers={servers}
        onClose={onClose}
        onStart={onStart}
        onStop={onStop}
        onStartAll={onStartAll}
        onStopAll={onStopAll}
        anchorRef={triggerRef}
        unmanagedConflict={unmanagedConflict}
        onDismissUnmanagedConflict={onDismissUnmanagedConflict}
        onStopUnmanagedAndRetry={onStopUnmanagedAndRetry}
        isStoppingUnmanaged={isStoppingUnmanaged}
      />
    </div>
  );
}
