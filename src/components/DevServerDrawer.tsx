"use client";

import { useEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { useOverlayScope } from "@/hooks/useOverlayScope";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/ui/cn";
import type { DevServerRuntimeState } from "@/lib/dev-server/schemas";

const PANEL =
  "fixed z-dropdown w-[320px] max-h-[calc(100dvh-var(--topbar-height)-80px)] " +
  "bg-bg-surface border border-solid border-border-subtle rounded-lg " +
  "shadow-[0_8px_32px_var(--cc-black-a45),0_0_1px_var(--cc-cyan-a08)] " +
  "flex flex-col overflow-hidden animate-[ds-panel-in_0.15s_ease] " +
  "[backdrop-filter:blur(16px)_saturate(140%)] " +
  "max-768:top-auto max-768:bottom-0 max-768:left-0 max-768:right-0 max-768:w-full " +
  "max-768:max-h-[60vh] max-768:rounded-t-lg max-768:rounded-b-none " +
  "max-768:pb-[env(safe-area-inset-bottom,0px)] max-768:animate-[ds-sheet-in_0.2s_ease]";

const BACKDROP = "fixed inset-0 z-dropdown max-768:bg-[var(--cc-black-a40)]";

const HEADER =
  "flex items-center justify-between px-md py-sm shrink-0 " +
  "border-x-0 border-t-0 border-b border-solid border-border-subtle";

const TITLE =
  "font-mono text-[0.72rem] font-semibold uppercase tracking-[0.06em] text-text-secondary";

const CLOSE =
  "bg-transparent border-none text-text-tertiary text-[0.7rem] cursor-pointer " +
  "px-[6px] py-[4px] leading-none rounded-sm font-mono " +
  "transition-[color] duration-150 ease-[ease] hover:text-text-primary " +
  "max-768:min-w-[44px] max-768:min-h-[44px] max-768:flex max-768:items-center max-768:justify-center";

const BODY = "p-sm overflow-y-auto flex flex-col gap-xs";

const ROW =
  "flex flex-wrap items-center gap-sm py-[6px] px-sm rounded-md bg-bg-raised " +
  // The Stop/Start <Button size="sm"> children carry no mobile sizing of their
  // own (the panel needs the narrower 36px box, not the global 44px touch
  // target). Re-home the full <=768px box onto the row's only <button> child:
  // min-height 36px + the legacy `.btn-sm` mobile padding (10px 16px).
  "max-768:[&_button]:min-h-[36px] max-768:[&_button]:px-[16px] max-768:[&_button]:py-[10px]";

const ROW_INFO = "flex items-center gap-[6px] flex-1 min-w-0";

const NAME_BASE =
  "font-mono text-[0.78rem] font-semibold whitespace-nowrap overflow-hidden text-ellipsis";

const STATUS_TEXT =
  "font-mono text-[0.7rem] text-text-tertiary uppercase tracking-[0.04em]";

const PORT = "font-mono text-[0.7rem] text-text-tertiary";

const ERROR_OUTPUT =
  "font-mono text-[0.7rem] text-red bg-bg-base border border-solid border-red-glow " +
  "rounded-sm px-sm py-xs m-0 max-h-[60px] overflow-auto whitespace-pre-wrap break-all";

const FOOTER =
  "flex gap-xs justify-end px-md py-sm shrink-0 " +
  "border-x-0 border-b-0 border-t border-solid border-border-subtle";

const CONFLICT =
  "mx-md my-sm px-md py-sm border border-solid border-border-subtle rounded-md " +
  "bg-[var(--cc-amber-tint-a05)] flex flex-col gap-xs";

// Inside the `.topbar-status-session` strip, the trigger is hidden on narrow
// viewports via the descendant idiom.
const TRIGGER_WRAPPER =
  "relative inline-flex items-center max-768:[.topbar-status-session_&]:hidden";

const TRIGGER_BASE =
  "relative inline-flex items-center gap-[5px] h-[30px] px-[10px] py-[5px] " +
  "border border-solid rounded-md font-mono text-[0.7rem] font-medium uppercase " +
  "tracking-[0.05em] whitespace-nowrap cursor-pointer transition-all duration-150 ease-[ease] " +
  "max-768:h-[36px] max-768:min-h-[36px] max-768:px-[12px] max-768:py-[6px] " +
  // hover layer — bg/text always change on hover; border is gated per status
  // (active deepens the cyan on hover).
  "hover:bg-bg-hover hover:text-text-primary " +
  "data-[status=active]:hover:border-[var(--cc-cyan-a40)] " +
  "data-[status=error]:hover:border-border-default " +
  "data-[status=default]:hover:border-border-default";

type TriggerStatus = "active" | "error" | "default";

function triggerStatic(status: TriggerStatus, open: boolean): string {
  const bg = open ? "bg-bg-hover" : "bg-bg-surface";
  const border =
    status === "error"
      ? "border-[var(--cc-red-a25)]"
      : status === "active"
        ? open
          ? "border-border-strong"
          : "border-[var(--cc-cyan-a25)]"
        : open
          ? "border-border-strong"
          : "border-border-subtle";
  const text =
    status === "error"
      ? "text-red"
      : open
        ? "text-text-primary"
        : status === "active"
          ? "text-cyan"
          : "text-text-secondary";
  return cn(bg, border, text);
}

const TRIGGER_DOT_BASE = "w-[6px] h-[6px] rounded-full shrink-0";

const DOT_BASE = "w-[7px] h-[7px] rounded-full shrink-0";

const DOT_STATUS: Record<DevServerRuntimeState["status"], string> = {
  stopped: "bg-text-tertiary",
  starting:
    "bg-amber shadow-[0_0_6px_var(--amber-glow)] animate-[pulse-dot_1.5s_ease-in-out_infinite]",
  running: "bg-green shadow-[0_0_6px_var(--green-glow)]",
  error: "bg-red shadow-[0_0_6px_var(--red-glow)]",
};

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
      className="shrink-0 opacity-60"
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
  return <span className={cn(DOT_BASE, DOT_STATUS[status])} />;
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
    <div className={ROW}>
      <div className={ROW_INFO}>
        <StatusDot status={server.status} />
        {server.remoteUrl && server.status === "running" ? (
          <a
            href={server.remoteUrl}
            target="_blank"
            rel="noopener noreferrer"
            className={cn(NAME_BASE, "text-cyan no-underline hover:underline")}
            onClick={(e) => e.stopPropagation()}
          >
            {server.serverName}
          </a>
        ) : (
          <span className={cn(NAME_BASE, "text-text-primary")}>
            {server.serverName}
          </span>
        )}
        <span className={STATUS_TEXT}>{server.status}</span>
        {server.port != null && <span className={PORT}>:{server.port}</span>}
      </div>
      <div className="shrink-0">
        {isActive ? (
          <Button size="sm" onClick={onStop} type="button">
            Stop
          </Button>
        ) : (
          <Button variant="primary" size="sm" onClick={onStart} type="button">
            Start
          </Button>
        )}
      </div>
      {server.status === "error" && server.errorMessage && (
        <div className="mt-xs w-full">
          <pre className={ERROR_OUTPUT}>
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
      className={CONFLICT}
      role="dialog"
      aria-label="Unmanaged dev server detected"
    >
      <div className="text-[0.85rem] font-semibold">
        Port {conflict.port} already in use
      </div>
      <div className="text-[0.8rem] leading-[1.4] text-inherit">
        Another process (pid {conflict.pid}) inside this worktree is listening
        on port {conflict.port}. Command Center didn&apos;t start it, so it
        won&apos;t be managed here.
      </div>
      <div className="text-[0.75rem] break-all text-inherit">
        <div>
          <span className="font-semibold">cwd:</span>{" "}
          <code>{conflict.cwd}</code>
        </div>
      </div>
      <div className="mt-xs flex justify-end gap-xs">
        <Button
          type="button"
          size="sm"
          touch
          onClick={onCancel}
          disabled={isStopping}
        >
          Cancel
        </Button>
        <Button
          type="button"
          size="sm"
          touch
          onClick={onRetry}
          disabled={isStopping}
        >
          Try Again
        </Button>
        <Button
          type="button"
          variant="danger"
          size="sm"
          touch
          onClick={onStop}
          disabled={isStopping}
        >
          {isStopping ? "Stopping…" : "Stop Server & Retry"}
        </Button>
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

  // Migration deferred (overlay-consumer dispositions): this is an anchored
  // drawer with a mobile backdrop + bottom-sheet variant and a bespoke status
  // trigger, custom-positioned from the trigger rect. Its custom fixed
  // positioning, backdrop, and slide animations are not modelled by the shipped
  // `Popover` primitive's padded canonical floating surface, so the manual
  // Escape/positioning is retained.

  if (!open) return null;

  const hasStoppable = servers.some(
    (s) => s.status === "running" || s.status === "starting",
  );
  const hasStopped = servers.some(
    (s) => s.status === "stopped" || s.status === "error",
  );

  return createPortal(
    <>
      <div className={BACKDROP} onClick={onClose} />
      <div
        className={PANEL}
        style={{ top: panelPos.top, right: panelPos.right }}
        role="dialog"
        aria-label="Dev servers"
      >
        <div className={HEADER}>
          <span className={TITLE}>Dev Servers</span>
          <button
            className={CLOSE}
            onClick={onClose}
            type="button"
            title="Close"
          >
            &#10005;
          </button>
        </div>
        <div className={BODY}>
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
            <div>No dev servers configured</div>
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
          <div className={FOOTER}>
            {hasStopped && (
              <Button
                variant="primary"
                size="sm"
                touch
                onClick={onStartAll}
                type="button"
              >
                Start All
              </Button>
            )}
            {hasStoppable && (
              <Button size="sm" touch onClick={onStopAll} type="button">
                Stop All
              </Button>
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

  const status: TriggerStatus = hasRunning
    ? "active"
    : hasError
      ? "error"
      : "default";

  const dotClass = hasRunning
    ? "bg-green shadow-[0_0_6px_var(--green-glow)] animate-pulse-dot"
    : hasError
      ? "bg-red shadow-[0_0_6px_var(--red-glow)]"
      : "bg-text-tertiary";

  return (
    <div className={TRIGGER_WRAPPER}>
      <button
        ref={triggerRef}
        data-status={status}
        className={cn(TRIGGER_BASE, triggerStatic(status, open))}
        onClick={onToggle}
        type="button"
      >
        <span className={cn(TRIGGER_DOT_BASE, dotClass)} />
        <span className="leading-none">
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
