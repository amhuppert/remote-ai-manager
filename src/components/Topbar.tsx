"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  useUnifiedPanelOpen,
  useToggleUnifiedPanel,
} from "@/stores/unified-panel.store";
import { useNotificationsQuery } from "@/lib/notifications/queries";
import { useActiveJobs } from "@/stores/notification.store";

interface BreadcrumbSegment {
  label: string;
  href?: string;
  isSession?: boolean;
}

interface TopbarProps {
  breadcrumbs: BreadcrumbSegment[];
  /** Controls which right-side content to show */
  page: "projects" | "sessions" | "detail" | "workflows";
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
  const pathname = usePathname();
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
                  ? (breadcrumbs[breadcrumbs.length - 2]!.href ?? "/projects")
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
              <span key={seg.href ?? seg.label} style={{ display: "contents" }}>
                {i > 0 && <span className="bc-sep">/</span>}
                {seg.href ? (
                  <Link href={seg.href} className={cls || undefined}>
                    {seg.label}
                  </Link>
                ) : (
                  <span className={cls || undefined}>{seg.label}</span>
                )}
              </span>
            );
          })}
        </nav>
      </div>
      <div className="topbar-status">
        <Link
          href="/workflows"
          className={`topbar-nav-link${pathname?.startsWith("/workflows") ? " active" : ""}`}
          title="Workflow Atlas"
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 16 16"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
          >
            <circle
              cx="3.5"
              cy="3.5"
              r="2.1"
              stroke="currentColor"
              strokeWidth="1.2"
            />
            <circle
              cx="12.5"
              cy="3.5"
              r="2.1"
              stroke="currentColor"
              strokeWidth="1.2"
            />
            <circle
              cx="8"
              cy="12.5"
              r="2.1"
              stroke="currentColor"
              strokeWidth="1.2"
            />
            <path
              d="M5 4.5 L11 4.5 M4.5 5.2 L7.4 11 M11.5 5.2 L8.6 11"
              stroke="currentColor"
              strokeWidth="1.2"
              strokeLinecap="round"
            />
          </svg>
          <span className="topbar-nav-link-label">Workflows</span>
        </Link>
        <Link
          href="/config"
          className={`topbar-config-link${pathname === "/config" ? " active" : ""}`}
          title="System Configuration"
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 16 16"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
          >
            <path
              d="M6.92 2.91 L6.54 1.15 L9.46 1.15 L9.08 2.91 A5.2 5.2 0 0 1 10.83 3.64 L11.81 2.13 L13.87 4.19 L12.36 5.17 A5.2 5.2 0 0 1 13.09 6.92 L14.85 6.54 L14.85 9.46 L13.09 9.08 A5.2 5.2 0 0 1 12.36 10.83 L13.87 11.81 L11.81 13.87 L10.83 12.36 A5.2 5.2 0 0 1 9.08 13.09 L9.46 14.85 L6.54 14.85 L6.92 13.09 A5.2 5.2 0 0 1 5.17 12.36 L4.19 13.87 L2.13 11.81 L3.64 10.83 A5.2 5.2 0 0 1 2.91 9.08 L1.15 9.46 L1.15 6.54 L2.91 6.92 A5.2 5.2 0 0 1 3.64 5.17 L2.13 4.19 L4.19 2.13 L5.17 3.64 A5.2 5.2 0 0 1 6.92 2.91 Z"
              stroke="currentColor"
              strokeWidth="1.2"
              strokeLinejoin="round"
            />
            <circle
              cx="8"
              cy="8"
              r="2.5"
              stroke="currentColor"
              strokeWidth="1.2"
            />
          </svg>
        </Link>
        <div className="topbar-sep" />
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
