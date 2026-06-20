"use client";

import { useEffect, useRef } from "react";
import {
  DevServerPanel,
  type UnmanagedConflictInfo,
} from "@/components/DevServerDrawer";
import type { DevServerRuntimeState } from "@/lib/dev-server/schemas";
import { cn } from "@/lib/ui/cn";

const TRIGGER_BASE =
  "relative inline-flex items-center gap-[6px] h-[26px] px-[9px] " +
  "border border-solid rounded-sm font-mono text-[0.68rem] font-semibold " +
  "tracking-[0.04em] cursor-pointer transition-all duration-150 ease-[ease] " +
  // Hover only applies in the default state (the active/open states keep their
  // own border + text); bg is untouched on hover, so only border + text change.
  "data-[state=default]:hover:border-cyan data-[state=default]:hover:text-text-primary";

type TriggerState = "open" | "active" | "default";

const TRIGGER_STATE: Record<TriggerState, string> = {
  open: "border-cyan bg-bg-hover text-text-primary",
  // The active state intentionally uses a softer green (--cc-devgreen-*),
  // distinct from the --green token (#00e676).
  active:
    "text-green border-[var(--cc-devgreen-a50)] bg-[var(--cc-devgreen-a06)]",
  default: "border-border-default bg-transparent text-text-secondary",
};

export interface DevServersButtonProps {
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

function DevServersIcon({ size = 13 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 14 14"
      fill="none"
      aria-hidden="true"
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

export default function DevServersButton({
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
}: DevServersButtonProps): React.JSX.Element {
  const triggerRef = useRef<HTMLButtonElement>(null);

  const running = servers.filter(
    (s) => s.status === "running" || s.status === "starting",
  ).length;
  const total = servers.length;
  const anyActive = running > 0;

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const state: TriggerState = open ? "open" : anyActive ? "active" : "default";

  const title = anyActive
    ? `${running} of ${total} dev servers running`
    : total === 0
      ? "No dev servers configured"
      : "Dev servers";

  return (
    <div className="relative">
      <button
        ref={triggerRef}
        type="button"
        data-state={state}
        className={cn(TRIGGER_BASE, TRIGGER_STATE[state])}
        onClick={onToggle}
        title={title}
        aria-expanded={open}
        aria-label="Dev servers"
      >
        <DevServersIcon />
        <span className="tabular-nums">
          {running}
          <span className="ml-[1px] text-text-tertiary">/{total}</span>
        </span>
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
