"use client";

import { useRef, useState } from "react";
import { DevServerPanel } from "@/components/DevServerDrawer";
import { ServerStackIcon } from "@/components/icons";
import { useProjectDevServers } from "@/hooks/use-dev-servers";
import { cn } from "@/lib/ui/cn";
import { CC_IBTN_LINK_CLASS } from "./header-action-class";

/**
 * Project-root dev servers: they run in the project's own checkout, so they
 * can be started without creating a session. Hidden when the project
 * configures no dev servers.
 */
export default function ProjectDevServersButton({
  projectName,
}: {
  projectName: string;
}): React.JSX.Element | null {
  const dev = useProjectDevServers(projectName);
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

  if (dev.servers.length === 0) return null;

  const running = dev.servers.filter(
    (server) => server.status === "running" || server.status === "starting",
  ).length;
  const total = dev.servers.length;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        data-open={open}
        aria-expanded={open}
        aria-label={`Project dev servers: ${running} of ${total} running`}
        title="Dev servers in the project root, without a session"
        onClick={() => setOpen((current) => !current)}
        className={cn(
          CC_IBTN_LINK_CLASS,
          "cursor-pointer whitespace-nowrap focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:outline-offset-2",
          "data-[open=true]:border-border-strong data-[open=true]:bg-bg-hover data-[open=true]:text-text-primary",
        )}
      >
        <ServerStackIcon size={14} />
        Dev servers
        <span
          className={cn(
            "inline-flex min-w-[16px] justify-center rounded-full px-[5px] py-px font-mono text-[0.7rem] leading-[1.2] font-semibold tabular-nums",
            running > 0
              ? "bg-[var(--cc-devgreen-a06)] text-green"
              : "bg-bg-raised text-text-secondary",
          )}
        >
          {running}/{total}
        </span>
      </button>
      <DevServerPanel
        open={open}
        servers={dev.servers}
        scopeLabel="Project root"
        onClose={() => setOpen(false)}
        onStart={dev.startServer}
        onStop={dev.stopServer}
        onStartAll={dev.startAll}
        onStopAll={dev.stopAll}
        anchorRef={triggerRef}
        unmanagedConflict={dev.unmanagedConflict}
        onDismissUnmanagedConflict={dev.dismissUnmanagedConflict}
        onStopUnmanagedAndRetry={dev.stopUnmanagedAndRetry}
        isStoppingUnmanaged={dev.isStoppingUnmanaged}
      />
    </>
  );
}
