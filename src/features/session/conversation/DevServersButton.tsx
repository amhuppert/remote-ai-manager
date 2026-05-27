"use client";

import { useEffect, useRef } from "react";
import { DevServerPanel } from "@/components/DevServerDrawer";
import type { DevServerRuntimeState } from "@/lib/dev-server/schemas";

export interface DevServersButtonProps {
  open: boolean;
  servers: DevServerRuntimeState[];
  onClose: () => void;
  onToggle: () => void;
  onStart: (name: string) => void;
  onStop: (name: string) => void;
  onStartAll: () => void;
  onStopAll: () => void;
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

  const triggerClass = [
    "dev-servers-trigger",
    open && "open",
    anyActive && "active",
  ]
    .filter(Boolean)
    .join(" ");

  const title = anyActive
    ? `${running} of ${total} dev servers running`
    : total === 0
      ? "No dev servers configured"
      : "Dev servers";

  return (
    <div className="dev-servers">
      <button
        ref={triggerRef}
        type="button"
        className={triggerClass}
        onClick={onToggle}
        title={title}
        aria-expanded={open}
        aria-label="Dev servers"
      >
        <DevServersIcon />
        <span className="dev-servers-count">
          {running}
          <span className="dev-servers-total">/{total}</span>
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
      />
    </div>
  );
}
