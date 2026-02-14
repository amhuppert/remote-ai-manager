"use client";

import Link from "next/link";

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
  return (
    <header className="topbar">
      <div className="topbar-brand">
        <Link href="/projects" className="topbar-logo">
          CSM
        </Link>
        <div className="topbar-divider" />
        <nav className="topbar-breadcrumb">
          {breadcrumbs.map((seg, i) => (
            <span key={seg.href} style={{ display: "contents" }}>
              {i > 0 && <span className="bc-sep">/</span>}
              <Link
                href={seg.href}
                className={seg.isSession ? "bc-session" : undefined}
              >
                {seg.label}
              </Link>
            </span>
          ))}
        </nav>
      </div>
      <div className="topbar-status">
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
