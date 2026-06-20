"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/ui/cn";
import {
  useUnifiedPanelOpen,
  useToggleUnifiedPanel,
} from "@/stores/unified-panel.store";
import { useNotificationsQuery } from "@/lib/notifications/queries";
import { useActiveJobs } from "@/stores/notification.store";
import { useActiveConversationsQuery } from "@/lib/active-conversations/queries";
import {
  activeConversationHref,
  activeConversationNeedsAttention,
} from "@/lib/active-conversations/row-helpers";

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
  const { data: activeConvosData } = useActiveConversationsQuery();
  // Badge shows unread notification count + running jobs
  const unreadCount = notificationsData?.unreadCount ?? 0;
  const badgeCount = unreadCount + activeJobs.length;
  const pinnedConversations = (activeConvosData?.conversations ?? []).filter(
    activeConversationNeedsAttention,
  );
  const needsCount = pinnedConversations.length;
  const approvalsCount = pinnedConversations.filter(
    (row) => row.pendingApproval !== null,
  ).length;
  const firstPinned = pinnedConversations[0] ?? null;
  const needsHref =
    firstPinned !== null ? activeConversationHref(firstPinned) : null;
  const workflowsActive = pathname?.startsWith("/workflows") ?? false;
  const configActive = pathname === "/config";

  return (
    <header className="sticky top-0 z-nav flex h-[var(--topbar-height)] items-center justify-between border-x-0 border-t-0 border-b border-solid border-b-border-subtle bg-[var(--cc-topbar-bg)] px-lg [backdrop-filter:blur(16px)_saturate(140%)] max-768:px-md">
      <div className="flex items-center gap-md max-768:min-w-0 max-768:flex-1 max-768:gap-sm">
        <Link
          href="/projects"
          className="font-display text-[1.1rem] font-extrabold tracking-[-0.02em] text-cyan [text-shadow:0_0_20px_var(--cyan-glow-text)] max-768:text-[0.95rem]"
        >
          CC
        </Link>
        <div className="h-[20px] w-px bg-border-default max-768:h-[16px]" />
        <nav className="flex items-center gap-sm font-mono text-[0.8rem] font-normal text-text-secondary max-768:min-w-0 max-768:overflow-hidden">
          {breadcrumbs.length > 0 && (
            <Link
              href={
                breadcrumbs.length > 1
                  ? (breadcrumbs[breadcrumbs.length - 2]!.href ?? "/projects")
                  : "/projects"
              }
              className="hidden max-768:flex max-768:shrink-0 max-768:items-center max-768:px-0 max-768:py-[4px] max-768:text-[1.4rem] max-768:leading-none max-768:text-text-tertiary! max-768:hover:text-text-primary!"
              aria-label="Go back"
            >
              &#8249;
            </Link>
          )}
          {breadcrumbs.map((seg, i) => {
            const isLast = i === breadcrumbs.length - 1;
            const appearance = cn(
              seg.isSession && "font-semibold text-text-primary!",
              isLast &&
                "max-768:min-w-0 max-768:overflow-hidden max-768:text-ellipsis max-768:whitespace-nowrap",
            );
            return (
              <span key={seg.href ?? seg.label} style={{ display: "contents" }}>
                {i > 0 && (
                  <span className="text-text-tertiary max-768:hidden">/</span>
                )}
                {seg.href ? (
                  <Link
                    href={seg.href}
                    className={cn(
                      "hover:text-text-primary!",
                      appearance,
                      !isLast && "max-768:hidden",
                    )}
                  >
                    {seg.label}
                  </Link>
                ) : (
                  <span className={appearance || undefined}>{seg.label}</span>
                )}
              </span>
            );
          })}
        </nav>
      </div>
      <div className="flex items-center gap-md">
        {needsCount > 0 && needsHref !== null && (
          <Link
            href={needsHref}
            className="inline-flex h-[28px] cursor-pointer items-center gap-[7px] rounded-full border border-solid border-amber-dim bg-amber-glow pr-[11px] pl-[9px] font-mono text-[0.7rem] font-bold tracking-[0.07em] text-amber uppercase no-underline transition-colors duration-[140ms] ease-[ease] hover:border-amber hover:bg-[var(--cc-topbar-needs-hover-bg)]"
            title={`${needsCount} conversation${needsCount === 1 ? "" : "s"} need your attention`}
            aria-label={`${needsCount} conversations need your attention`}
          >
            <span
              className="h-[7px] w-[7px] [animation:pulse-dot_1.6s_ease-in-out_infinite] rounded-full bg-amber [box-shadow:0_0_7px_var(--amber)]"
              aria-hidden="true"
            />
            <span className="tabular-nums">{needsCount}</span>
            <span className="font-semibold text-amber-dim max-768:hidden">
              {needsCount === 1 ? "needs you" : "need you"}
            </span>
            {approvalsCount > 0 && (
              <span className="font-semibold whitespace-nowrap text-amber">
                · {approvalsCount} approval{approvalsCount === 1 ? "" : "s"}
              </span>
            )}
          </Link>
        )}
        <Link
          href="/workflows"
          className={cn(
            "inline-flex h-[28px] items-center gap-[6px] rounded-sm border border-solid bg-transparent px-[10px] font-mono text-[0.7rem] font-medium tracking-[0.06em] uppercase no-underline [transition:all_0.15s_ease] hover:border-cyan hover:bg-bg-hover hover:text-text-primary! max-768:h-[44px] max-768:px-sm",
            workflowsActive
              ? "border-cyan text-text-primary!"
              : "border-border-default text-text-secondary!",
          )}
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
          <span className="leading-none max-768:hidden">Workflows</span>
        </Link>
        <Link
          href="/config"
          className={cn(
            "flex h-[30px] w-[30px] items-center justify-center rounded-sm no-underline [transition:all_0.15s_ease] hover:bg-bg-hover max-768:h-[44px] max-768:w-[44px]",
            configActive
              ? "text-cyan"
              : "text-text-secondary! hover:text-text-primary!",
          )}
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
        <div className="h-[24px] w-px shrink-0 bg-border-default" />
        <button
          className={cn(
            "flex shrink-0 cursor-pointer items-center gap-[4px] rounded-sm border border-solid border-border-subtle bg-transparent px-[8px] py-[4px] text-[0.8rem] text-text-secondary transition-[background,border-color,color] duration-150 ease-[ease]",
            panelOpen
              ? "border-cyan bg-[var(--cc-cyan-a08)] text-cyan"
              : "hover:bg-bg-elevated hover:text-text-primary",
          )}
          onClick={togglePanel}
          title="Activity & Notifications"
          type="button"
        >
          <span className="text-[0.85rem] leading-none">&#9776;</span>
          {badgeCount > 0 && (
            <span className="inline-flex h-[16px] min-w-[16px] items-center justify-center rounded-[8px] bg-cyan px-[4px] font-mono text-[0.7rem] leading-none font-bold text-[var(--bg-base)]">
              {badgeCount}
            </span>
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
