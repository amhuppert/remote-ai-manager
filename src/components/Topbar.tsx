"use client";

import Link from "next/link";
import {
  useUnifiedPanelOpen,
  useToggleUnifiedPanel,
} from "@/stores/unified-panel.store";
import { useNotificationsQuery } from "@/lib/queries";
import { useActiveJobs } from "@/stores/notification.store";

export interface BreadcrumbSegment {
  label: string;
  href: string;
  isSession?: boolean;
}

interface TopbarProps {
  breadcrumbs: BreadcrumbSegment[];
  /** Controls which right-side content to show */
  page: "projects" | "sessions" | "detail";
  /** Session detail controls — only rendered when page === "detail" */
  sessionControls?: React.ReactNode;
  /** Global status indicators — rendered when page !== "detail" */
  globalStatus?: React.ReactNode;
}

export default function Topbar({
  breadcrumbs,
  page,
  sessionControls,
  globalStatus,
}: TopbarProps): React.JSX.Element {
  const panelOpen = useUnifiedPanelOpen();
  const togglePanel = useToggleUnifiedPanel();
  const { data: notificationsData } = useNotificationsQuery();
  const activeJobs = useActiveJobs();
  // Badge shows unread notification count + running jobs
  const unreadCount = notificationsData?.unreadCount ?? 0;
  const badgeCount = unreadCount + activeJobs.length;

  return (
    <header className="topbar">
      <div className="topbar-brand">
        <Link href="/projects" className="topbar-logo">
          CC
        </Link>
        <div className="topbar-divider" />
        <nav className="topbar-breadcrumb">
          {breadcrumbs.length > 0 && (
            <Link
              href={
                breadcrumbs.length > 1
                  ? breadcrumbs[breadcrumbs.length - 2]!.href
                  : "/projects"
              }
              className="topbar-mobile-back"
              aria-label="Go back"
            >
              &#8249;
            </Link>
          )}
          {breadcrumbs.map((seg, i) => {
            const isLast = i === breadcrumbs.length - 1;
            const cls = [
              seg.isSession ? "bc-session" : null,
              isLast ? "bc-last" : null,
            ]
              .filter(Boolean)
              .join(" ");
            return (
              <span key={seg.href} style={{ display: "contents" }}>
                {i > 0 && <span className="bc-sep">/</span>}
                <Link href={seg.href} className={cls || undefined}>
                  {seg.label}
                </Link>
              </span>
            );
          })}
        </nav>
      </div>
      <div className="topbar-status">
        <button
          className={`unified-panel-toggle${panelOpen ? " active" : ""}`}
          onClick={togglePanel}
          title="Activity & Notifications"
          type="button"
        >
          <span className="unified-panel-toggle-icon">&#9776;</span>
          {badgeCount > 0 && (
            <span className="unified-panel-toggle-badge">{badgeCount}</span>
          )}
        </button>
        {page !== "detail" && (
          <div className="topbar-status-default">{globalStatus}</div>
        )}
        {page === "detail" && (
          <div className="topbar-status-session">{sessionControls}</div>
        )}
      </div>
    </header>
  );
}
