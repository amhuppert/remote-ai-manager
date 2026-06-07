"use client";

import Link from "next/link";
import { useCallback } from "react";
import { assertNever } from "@/lib/shared/assert-never";
import { getItemLabel } from "./notification-helpers";
import { CloseIcon } from "@/components/icons";
import LandPreparedMergeButton from "./LandPreparedMergeButton";
import type { BackgroundJob } from "@/lib/jobs/schemas";
import type { AgentBackendId } from "@/lib/shared/schemas";

// ── Types ──────────────────────────────────────────────────────

interface BaseNotification {
  id: string;
  timestamp: string;
  projectName: string;
}

type ConversationNotificationStatus =
  | "new"
  | "running"
  | "awaiting"
  | "waiting_for_input";

interface ConversationNotificationBase extends BaseNotification {
  type: "conversation";
  name: string | null;
  status: ConversationNotificationStatus;
  backend?: AgentBackendId;
  read?: boolean;
}

export interface SessionConversationNotification
  extends ConversationNotificationBase {
  scope: "session";
  sessionName: string;
}

export interface ProjectConversationNotification
  extends ConversationNotificationBase {
  scope: "project";
  contextLabel: "main";
  href: string;
  sessionName?: never;
}

export type ConversationNotification =
  | SessionConversationNotification
  | ProjectConversationNotification;

interface ServerNotificationBase extends BaseNotification {
  sessionName: string;
  branchName: string;
  read?: boolean;
}

export interface MergeNotification extends ServerNotificationBase {
  type: "merge";
  status:
    | "running"
    | "success"
    | "conflicts"
    | "error"
    | "ready-to-land"
    | "discarded";
  mergeHash?: string;
  conflictCount?: number;
  errorMessage?: string;
  phase?: string;
  preparedSha?: string;
  parkedRef?: string;
}

export interface CommitNotification extends ServerNotificationBase {
  type: "commit";
  status: "running" | "success" | "error";
  commitHash?: string;
  errorMessage?: string;
  phase?: string;
}

export interface ResolveConflictsNotification extends ServerNotificationBase {
  type: "resolve-conflicts";
  status: "running" | "success" | "error";
  mergeHash?: string;
  errorMessage?: string;
}

export interface GraphWorkflowNotification extends BaseNotification {
  type: "graph-workflow";
  sessionName: string;
  status: string;
  activeContextTitles: string[];
  completedContexts: number;
  totalContexts: number;
}

export type NotificationItem =
  | ConversationNotification
  | MergeNotification
  | CommitNotification
  | ResolveConflictsNotification
  | GraphWorkflowNotification;

interface NotificationsPanelProps {
  open: boolean;
  items: NotificationItem[];
  loading?: boolean;
  unreadCount?: number;
  onClose: () => void;
  onNavigate?: (href: string) => void;
  onMarkAsRead?: (id: string) => void;
  onMarkAllAsRead?: () => void;
  onDismiss?: (id: string) => void;
}

// ── Helpers ─────────────────────────────────────────────────────

/** Extract a concise one-line summary from a raw validation error message. */
function summarizeError(errorMessage: string): string {
  const lines = errorMessage
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  // ESLint summary: "N problems (N errors, N warnings)"
  const eslintSummary = lines.find((l) => /\d+ problems?\s*\(/.test(l));
  if (eslintSummary) return eslintSummary;

  // TypeScript error count: "Found N errors"
  const tsErrors = lines.find((l) => /Found \d+ errors?/.test(l));
  if (tsErrors) return tsErrors;

  // TypeScript specific error: "error TS1234: ..."
  const tsError = lines.find((l) => /error TS\d+/.test(l));
  if (tsError)
    return tsError.length > 120 ? tsError.slice(0, 117) + "..." : tsError;

  // Test failures: "Tests: N failed" or "FAIL"
  const testFail = lines.find((l) => /Tests?:.*failed|FAIL\s/.test(l));
  if (testFail)
    return testFail.length > 120 ? testFail.slice(0, 117) + "..." : testFail;

  // Fallback: first meaningful line (skip "Pre-merge validation failed")
  const meaningful =
    lines.find((l) => l !== "Pre-merge validation failed") ??
    lines[0] ??
    errorMessage;
  return meaningful.length > 100 ? meaningful.slice(0, 97) + "..." : meaningful;
}

/** Check if a notification item has an error message to display. */
function getErrorMessage(item: NotificationItem): string | undefined {
  if (item.type === "conversation" || item.type === "graph-workflow")
    return undefined;
  if (item.status !== "error") return undefined;
  return item.errorMessage;
}

function formatRelativeTime(isoDate: string): string {
  const diff = Date.now() - new Date(isoDate).getTime();
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function getItemHref(item: NotificationItem): string {
  switch (item.type) {
    case "conversation": {
      switch (item.scope) {
        case "session":
          return `/projects/${encodeURIComponent(item.projectName)}/${encodeURIComponent(item.sessionName)}/${encodeURIComponent(item.id)}`;
        case "project":
          return item.href;
        default:
          return assertNever(item);
      }
    }
    case "merge": {
      const base = `/projects/${encodeURIComponent(item.projectName)}/${encodeURIComponent(item.sessionName)}`;
      if (item.status === "conflicts") return `${base}/conflicts`;
      return base;
    }
    case "commit": {
      const base = `/projects/${encodeURIComponent(item.projectName)}/${encodeURIComponent(item.sessionName)}`;
      return base;
    }
    case "resolve-conflicts": {
      const base = `/projects/${encodeURIComponent(item.projectName)}/${encodeURIComponent(item.sessionName)}`;
      return base;
    }
    case "graph-workflow": {
      const base = `/projects/${encodeURIComponent(item.projectName)}/${encodeURIComponent(item.sessionName)}`;
      return `${base}/workflow`;
    }
    default:
      return assertNever(item);
  }
}

function getItemTitle(item: NotificationItem): string {
  switch (item.type) {
    case "conversation":
      return item.name ?? "Unnamed conversation";
    case "merge":
      return `Merge ${item.branchName}`;
    case "commit":
      return `Commit on ${item.branchName}`;
    case "resolve-conflicts":
      return `Resolve conflicts on ${item.branchName}`;
    case "graph-workflow":
      return item.activeContextTitles.length > 0
        ? item.activeContextTitles.join(" + ")
        : "Graph Workflow";
    default:
      return assertNever(item);
  }
}

function getItemCategory(item: NotificationItem): string {
  switch (item.type) {
    case "conversation":
      return "conversation";
    case "merge":
      return "merge";
    case "commit":
      return "commit";
    case "resolve-conflicts":
      return "resolve";
    case "graph-workflow":
      return "workflow";
    default:
      return assertNever(item);
  }
}

function getItemStatusClass(item: NotificationItem): string {
  switch (item.type) {
    case "conversation":
      return item.status;
    case "merge": {
      const status = item.status;
      switch (status) {
        case "success":
          return "success";
        case "conflicts":
          return "warning";
        case "error":
          return "error";
        case "running":
          return "running";
        case "ready-to-land":
          return "success-pending-action";
        case "discarded":
          return "discarded";
        default:
          return assertNever(status);
      }
    }
    case "commit":
    case "resolve-conflicts": {
      const status = item.status;
      switch (status) {
        case "success":
          return "success";
        case "error":
          return "error";
        case "running":
          return "running";
        default:
          return assertNever(status);
      }
    }
    case "graph-workflow":
      return item.status === "running" ? "running" : "paused";
    default:
      return assertNever(item);
  }
}

function isUnread(item: NotificationItem): boolean {
  if (item.type === "conversation") return item.read === false;
  if (item.type === "graph-workflow") return false;
  return item.read === false;
}

function getItemContextLabel(item: NotificationItem): string {
  if (item.type === "conversation") {
    switch (item.scope) {
      case "session":
        return `${item.projectName} / ${item.sessionName}`;
      case "project":
        return `${item.projectName} / ${item.contextLabel}`;
      default:
        return assertNever(item);
    }
  }
  return `${item.projectName} / ${item.sessionName}`;
}

// ── Icons ──────────────────────────────────────────────────────

function ConversationIcon() {
  return (
    <svg width={14} height={14} viewBox="0 0 14 14" fill="none">
      <rect
        x="1"
        y="2"
        width="12"
        height="8"
        rx="2"
        stroke="currentColor"
        strokeWidth="1.2"
      />
      <path
        d="M4 12L7 10H13"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function MergeIcon() {
  return (
    <svg width={14} height={14} viewBox="0 0 14 14" fill="none">
      <circle cx="3" cy="3" r="1.5" stroke="currentColor" strokeWidth="1.2" />
      <circle cx="11" cy="3" r="1.5" stroke="currentColor" strokeWidth="1.2" />
      <circle cx="3" cy="11" r="1.5" stroke="currentColor" strokeWidth="1.2" />
      <path
        d="M3 4.5V9.5M9.5 3C8 3 5 4 5 8"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
    </svg>
  );
}

function CommitIcon() {
  return (
    <svg width={14} height={14} viewBox="0 0 14 14" fill="none">
      <circle cx="7" cy="7" r="3" stroke="currentColor" strokeWidth="1.2" />
      <line
        x1="7"
        y1="1"
        x2="7"
        y2="4"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
      <line
        x1="7"
        y1="10"
        x2="7"
        y2="13"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
    </svg>
  );
}

function ResolveIcon() {
  return (
    <svg width={14} height={14} viewBox="0 0 14 14" fill="none">
      <circle cx="7" cy="7" r="6" stroke="currentColor" strokeWidth="1.2" />
      <path
        d="M4.5 7.5L6.5 9.5L9.5 5.5"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function WorkflowIcon() {
  return (
    <svg width={14} height={14} viewBox="0 0 14 14" fill="none">
      <path
        d="M7 1L7 5M7 9L7 13"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
      <circle cx="7" cy="7" r="2" stroke="currentColor" strokeWidth="1.2" />
      <path
        d="M3 3L5.5 5.5M8.5 8.5L11 11"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
    </svg>
  );
}

function getItemIcon(item: NotificationItem) {
  switch (item.type) {
    case "conversation":
      return <ConversationIcon />;
    case "merge":
      return <MergeIcon />;
    case "commit":
      return <CommitIcon />;
    case "resolve-conflicts":
      return <ResolveIcon />;
    case "graph-workflow":
      return <WorkflowIcon />;
    default:
      return assertNever(item);
  }
}

// ── Component ──────────────────────────────────────────────────

function NotificationRow({
  item,
  onClose,
  onMarkAsRead,
  onDismiss,
}: {
  item: NotificationItem;
  onClose: () => void;
  onMarkAsRead?: (id: string) => void;
  onDismiss?: (id: string) => void;
}) {
  const href = getItemHref(item);
  const statusClass = getItemStatusClass(item);
  const category = getItemCategory(item);
  const unread = isUnread(item);

  const handleClick = useCallback(() => {
    if (unread && onMarkAsRead) {
      onMarkAsRead(item.id);
    }
    onClose();
  }, [item.id, unread, onMarkAsRead, onClose]);

  const handleDismiss = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      onDismiss?.(item.id);
    },
    [item.id, onDismiss],
  );

  const readyToLandJob =
    item.type === "merge" && item.status === "ready-to-land"
      ? buildReadyToLandJob(item)
      : null;

  return (
    <li>
      <Link
        href={href}
        className={`np-item${unread ? " np-item-unread" : ""}`}
        onClick={handleClick}
      >
        {unread && <span className="np-unread-dot" />}
        <span className={`np-item-icon np-icon-${category}`}>
          {getItemIcon(item)}
        </span>
        <div className="np-item-body">
          <div className="np-item-title">{getItemTitle(item)}</div>
          <div className="np-item-meta">
            {getItemContextLabel(item)}
            {item.type === "conversation" && item.backend && (
              <>
                {" "}
                <span
                  className="cc-badge cc-badge--subtle"
                  data-backend={item.backend}
                  aria-label={`agent: ${item.backend}`}
                >
                  {item.backend}
                </span>
              </>
            )}
          </div>
          {getErrorMessage(item) && (
            <div className="np-item-error" title={getErrorMessage(item)}>
              {summarizeError(getErrorMessage(item)!)}
            </div>
          )}
          {readyToLandJob && (
            <div
              className="np-item-actions"
              onClick={(e) => e.stopPropagation()}
            >
              <LandPreparedMergeButton job={readyToLandJob} />
            </div>
          )}
        </div>
        <div className="np-item-right">
          <span className={`np-item-status np-status-${statusClass}`}>
            {getItemLabel(item)}
          </span>
          <span className="np-item-time">
            {formatRelativeTime(item.timestamp)}
          </span>
        </div>
        {item.type !== "conversation" && onDismiss && (
          <button
            className="np-item-dismiss"
            onClick={handleDismiss}
            title="Dismiss"
          >
            &#10005;
          </button>
        )}
      </Link>
    </li>
  );
}

function buildReadyToLandJob(item: MergeNotification): BackgroundJob {
  return {
    jobId: item.id,
    jobType: "merge",
    status: "ready-to-land",
    projectName: item.projectName,
    sessionName: item.sessionName,
    branchName: item.branchName,
    startedAt: item.timestamp,
    preparedSha: item.preparedSha,
    parkedRef: item.parkedRef,
    phase: item.phase,
  };
}

export default function NotificationsPanel({
  open,
  items,
  loading,
  unreadCount = 0,
  onClose,
  onMarkAsRead,
  onMarkAllAsRead,
  onDismiss,
}: NotificationsPanelProps) {
  const handleBackdropClick = useCallback(() => {
    onClose();
  }, [onClose]);

  if (!open) return null;

  const conversations = items.filter((i) => i.type === "conversation");
  const jobs = items.filter((i) => i.type !== "conversation");

  return (
    <>
      <div className="np-backdrop" onClick={handleBackdropClick} />
      <aside className="np-panel">
        <div className="np-header">
          <span className="np-title">Activity</span>
          {unreadCount > 0 && onMarkAllAsRead && (
            <button
              className="np-mark-all-read"
              onClick={onMarkAllAsRead}
              title="Mark all as read"
            >
              Mark all read
            </button>
          )}
          <button
            className="btn-icon-only np-close"
            onClick={onClose}
            title="Close panel"
            aria-label="Close panel"
          >
            <CloseIcon />
          </button>
        </div>
        <div className="np-body">
          {loading ? (
            <div className="np-empty">Loading...</div>
          ) : items.length === 0 ? (
            <div className="np-empty">
              No activity right now.
              <br />
              <span className="np-empty-hint">
                Active conversations, merge jobs, and commit results will appear
                here.
              </span>
            </div>
          ) : (
            <>
              {conversations.length > 0 && (
                <div className="np-section">
                  <div className="np-section-header">
                    <span className="np-section-label">Conversations</span>
                    <span className="np-section-count">
                      {conversations.length}
                    </span>
                  </div>
                  <ul className="np-list">
                    {conversations.map((item) => (
                      <NotificationRow
                        key={item.id}
                        item={item}
                        onClose={onClose}
                      />
                    ))}
                  </ul>
                </div>
              )}
              {jobs.length > 0 && (
                <div className="np-section">
                  <div className="np-section-header">
                    <span className="np-section-label">Jobs</span>
                    <span className="np-section-count">{jobs.length}</span>
                  </div>
                  <ul className="np-list">
                    {jobs.map((item) => (
                      <NotificationRow
                        key={item.id}
                        item={item}
                        onClose={onClose}
                        onMarkAsRead={onMarkAsRead}
                        onDismiss={onDismiss}
                      />
                    ))}
                  </ul>
                </div>
              )}
            </>
          )}
        </div>
      </aside>
    </>
  );
}
