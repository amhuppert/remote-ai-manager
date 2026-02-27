"use client";

import { useMemo } from "react";
import { usePathname } from "next/navigation";
import DevServerDrawer from "./DevServerDrawer";
import { useDevServers } from "@/hooks/use-dev-servers";
import {
  useDevServerDrawerOpen,
  useToggleDevServerDrawer,
  useCloseDevServerDrawer,
} from "@/stores/dev-server-drawer.store";

// ── Helpers ────────────────────────────────────────────────────

/**
 * Extract project + session names from the current URL path.
 * Returns null when the URL is not a session-level page.
 */
function parseSessionContext(
  pathname: string,
): { projectName: string; sessionName: string } | null {
  const match = pathname.match(/^\/projects\/([^/]+)\/([^/]+)/);
  if (!match || !match[1] || !match[2]) return null;
  return {
    projectName: decodeURIComponent(match[1]),
    sessionName: decodeURIComponent(match[2]),
  };
}

// ── Inner component with data fetching ─────────────────────────

function DrawerWithData({
  projectName,
  sessionName,
}: {
  projectName: string;
  sessionName: string;
}) {
  const isOpen = useDevServerDrawerOpen();
  const toggle = useToggleDevServerDrawer();
  const close = useCloseDevServerDrawer();
  const { servers, startServer, stopServer, startAll, stopAll } = useDevServers(
    projectName,
    sessionName,
  );

  return (
    <DevServerDrawer
      open={isOpen}
      servers={servers}
      onClose={close}
      onToggle={toggle}
      onStart={startServer}
      onStop={stopServer}
      onStartAll={startAll}
      onStopAll={stopAll}
    />
  );
}

// ── Container ──────────────────────────────────────────────────

export default function DevServerDrawerContainer() {
  const pathname = usePathname();
  const context = useMemo(() => parseSessionContext(pathname), [pathname]);

  if (!context) return null;

  return (
    <DrawerWithData
      projectName={context.projectName}
      sessionName={context.sessionName}
    />
  );
}
