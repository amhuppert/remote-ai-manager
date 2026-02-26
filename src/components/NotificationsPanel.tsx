"use client";

import Link from "next/link";
import { useCallback } from "react";

// ── Types ──────────────────────────────────────────────────────

interface BaseNotification {
  id: string;
  timestamp: string;
  projectName: string;
  sessionName: string;
}

export interface ConversationNotification extends BaseNotification {
  type: "conversation";
  name: string | null;
  status: "running" | "awaiting" | "waiting_for_input";
}

interface ServerNotificationBase extends BaseNotification {
  branchName: string;
  read?: boolean;
}

export interface MergeNotification extends ServerNotificationBase {
  type: "merge";
  status: "running" | "success" | "conflicts" | "error";
  mergeHash?: string;
  conflictCount?: number;
  errorMessage?: string;
}

export interface CommitNotification extends ServerNotificationBase {
  type: "commit";
  status: "running" | "success" | "error";
  commitHash?: string;
  errorMessage?: string;
}

export interface ResolveConflictsNotification extends ServerNotificationBase {
  type: "resolve-conflicts";
  status: "running" | "success" | "error";
  mergeHash?: string;
  errorMessage?: string;
}

export interface WorkflowNotification extends BaseNotification {
  type: "workflow";
  status: "running" | "paused" | "completed" | "halted" | "aborted";
  iterationCount: number;
  maxIterations: number;
  read?: boolean;
}

export type ServerNotificationItem =
  | MergeNotification
  | CommitNotification
  | ResolveConflictsNotification;

export type NotificationItem =
  | ConversationNotification
  | MergeNotification
  | CommitNotification
  | ResolveConflictsNotification
  | WorkflowNotification;

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
  const base = `/projects/${encodeURIComponent(item.projectName)}/${encodeURIComponent(item.sessionName)}`;
  switch (item.type) {
    case "conversation":
      return `${base}/${item.id}`;
    case "merge":
      if (item.status === "conflicts") return `${base}/conflicts`;
      return base;
    case "commit":
      return base;
    case "resolve-conflicts":
      return base;
    case "workflow":
      return base;
  }
}

function getItemLabel(item: NotificationItem): string {
  switch (item.type) {
    case "conversation":
      return item.status === "running"
        ? "Running"
        : item.status === "awaiting"
          ? "Awaiting"
          : "Needs input";
    case "merge":
      return item.status === "running"
        ? "Merging..."
        : item.status === "success"
          ? "Merged"
          : item.status === "conflicts"
            ? `${item.conflictCount ?? 0} conflict${(item.conflictCount ?? 0) !== 1 ? "s" : ""}`
            : "Merge failed";
    case "commit":
      return item.status === "running"
        ? "Committing..."
        : item.status === "success"
          ? "Committed"
          : "Commit failed";
    case "resolve-conflicts":
      return item.status === "running"
        ? "Resolving..."
        : item.status === "success"
          ? "Resolved"
          : "Resolution failed";
    case "workflow": {
      const labels: Record<string, string> = {
        running: `${item.iterationCount}/${item.maxIterations}`,
        paused: "Paused",
        completed: "Complete",
        halted: "Halted",
        aborted: "Aborted",
      };
      return labels[item.status] ?? item.status;
    }
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
    case "workflow":
      return "Ralph Loop";
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
    case "workflow":
      return "workflow";
  }
}

function getItemStatusClass(item: NotificationItem): string {
  switch (item.type) {
    case "conversation":
      return item.status;
    case "merge":
      return item.status === "success"
        ? "success"
        : item.status === "conflicts"
          ? "warning"
          : item.status === "error"
            ? "error"
            : "running";
    case "commit":
    case "resolve-conflicts":
      return item.status === "success"
        ? "success"
        : item.status === "error"
          ? "error"
          : "running";
    case "workflow":
      return item.status === "completed"
        ? "success"
        : item.status === "halted"
          ? "warning"
          : item.status === "aborted"
            ? "error"
            : item.status; // "running" | "paused"
  }
}

function isUnread(item: NotificationItem): boolean {
  if (item.type === "conversation") return false;
  return item.read === false;
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
    case "workflow":
      return <WorkflowIcon />;
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
            {item.projectName} / {item.sessionName}
          </div>
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
          >
            &#10005;
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
