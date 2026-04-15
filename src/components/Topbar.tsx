"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  useUnifiedPanelOpen,
  useToggleUnifiedPanel,
} from "@/stores/unified-panel.store";
import { useNotificationsQuery } from "@/lib/queries";
import { useActiveJobs } from "@/stores/notification.store";

export interface BreadcrumbSegment {
  label: string;
  href?: string;
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
              d="M6.5 1.5h3l.4 1.9.9.4 1.7-.8 2.1 2.1-.8 1.7.4.9 1.9.4v3l-1.9.4-.4.9.8 1.7-2.1 2.1-1.7-.8-.9.4-.4 1.9h-3l-.4-1.9-.9-.4-1.7.8-2.1-2.1.8-1.7-.4-.9-1.9-.4v-3l1.9-.4.4-.9-.8-1.7 2.1-2.1 1.7.8.9-.4z"
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
