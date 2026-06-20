"use client";

import Link from "next/link";
import { useCallback } from "react";
import { assertNever } from "@/lib/shared/assert-never";
import { conversationsPageHref } from "@/lib/conversations/hrefs";
import { getItemLabel } from "./notification-helpers";
import { CloseIcon } from "@/components/icons";
import { Badge } from "@/components/ui/Badge";
import { cn } from "@/lib/ui/cn";
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
  | "waiting_for_input"
  | "failed";

interface ConversationNotificationBase extends BaseNotification {
  type: "conversation";
  name: string | null;
  status: ConversationNotificationStatus;
  backend?: AgentBackendId;
  read?: boolean;
  persisted?: true;
}

export interface SessionConversationNotification extends ConversationNotificationBase {
  scope: "session";
  sessionName: string;
}

export interface ProjectConversationNotification extends ConversationNotificationBase {
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
          return conversationsPageHref({ conversationId: item.id });
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
      return item.status === "failed" ? "error" : item.status;
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

// ── Class recipes (migrated from the legacy .np-* rules) ───────

const ITEM_BASE =
  "group flex items-start gap-sm px-md py-sm no-underline text-text-primary " +
  "border-y-0 border-r-0 border-l-2 border-solid border-l-transparent " +
  "transition-[background,border-color] duration-100 ease-[ease] " +
  "hover:bg-bg-elevated hover:border-l-border-default";
// Accent-blue family lives in tokens.css (--cc-accent-blue and its alpha tints).
const ITEM_UNREAD =
  "bg-[var(--cc-accent-blue-bg-subtle)] border-l-[var(--cc-accent-blue)]";

const ICON_BASE =
  "flex items-center justify-center size-[24px] rounded-sm shrink-0 mt-[1px]";
const ICON_CATEGORY: Record<string, string> = {
  conversation: "text-cyan-dim bg-cyan-glow",
  merge: "text-green-dim bg-green-glow",
  commit: "text-amber-dim bg-amber-glow",
  resolve: "text-text-secondary",
};

const STATUS_BASE =
  "font-mono text-[0.7rem] font-semibold px-[6px] py-[1px] rounded-[8px] " +
  "whitespace-nowrap uppercase tracking-[0.03em]";
const STATUS_TONE: Record<string, string> = {
  new: "text-blue bg-blue-glow",
  running: "text-cyan bg-cyan-glow",
  awaiting: "text-green bg-green-glow",
  waiting_for_input: "text-amber bg-amber-glow",
  success: "text-green bg-green-glow",
  warning: "text-amber bg-amber-glow",
  error: "text-red bg-red-glow",
};

const DISMISS_BTN =
  "flex items-center justify-center bg-transparent border-0 cursor-pointer " +
  "text-text-tertiary text-[0.7rem] px-[4px] py-[2px] rounded-sm ml-xs shrink-0 " +
  "opacity-50 transition-opacity duration-100 ease-[ease] " +
  "group-hover:opacity-100 hover:text-text-primary";

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
  const persistedConversation =
    item.type === "conversation" && item.persisted === true;
  const canUseNotificationActions =
    item.type !== "conversation" || persistedConversation;

  const handleClick = useCallback(() => {
    if (unread && canUseNotificationActions && onMarkAsRead) {
      onMarkAsRead(item.id);
    }
    onClose();
  }, [canUseNotificationActions, item.id, unread, onMarkAsRead, onClose]);

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
    <li className="[contain-intrinsic-size:0_72px] [content-visibility:auto]">
      <Link
        href={href}
        className={cn(ITEM_BASE, unread && ITEM_UNREAD)}
        onClick={handleClick}
      >
        {unread && (
          <span className="absolute top-1/2 left-[6px] size-[6px] shrink-0 -translate-y-1/2 rounded-full bg-[var(--cc-accent-blue)]" />
        )}
        <span className={cn(ICON_BASE, ICON_CATEGORY[category])}>
          {getItemIcon(item)}
        </span>
        <div className="min-w-0 flex-1">
          <div
            className={cn(
              "overflow-hidden text-[0.78rem] text-ellipsis whitespace-nowrap text-text-primary",
              unread ? "font-semibold" : "font-medium",
            )}
          >
            {getItemTitle(item)}
          </div>
          <div className="mt-[1px] overflow-hidden font-mono text-[0.7rem] text-ellipsis whitespace-nowrap text-text-tertiary">
            {getItemContextLabel(item)}
            {item.type === "conversation" && item.backend && (
              <>
                {" "}
                <Badge
                  backend={item.backend}
                  subtle
                  aria-label={`agent: ${item.backend}`}
                >
                  {item.backend}
                </Badge>
              </>
            )}
          </div>
          {getErrorMessage(item) && (
            <div
              className="mt-[2px] overflow-hidden font-mono text-[0.7rem] text-ellipsis whitespace-nowrap text-red opacity-[0.85]"
              title={getErrorMessage(item)}
            >
              {summarizeError(getErrorMessage(item)!)}
            </div>
          )}
          {readyToLandJob && (
            <div onClick={(e) => e.stopPropagation()}>
              <LandPreparedMergeButton job={readyToLandJob} />
            </div>
          )}
        </div>
        <div className="flex shrink-0 flex-col items-end gap-[3px]">
          <span className={cn(STATUS_BASE, STATUS_TONE[statusClass])}>
            {getItemLabel(item)}
          </span>
          <span className="font-mono text-[0.7rem] whitespace-nowrap text-text-tertiary">
            {formatRelativeTime(item.timestamp)}
          </span>
        </div>
        {canUseNotificationActions && onDismiss && (
          <button
            className={DISMISS_BTN}
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
      <div
        className="fixed inset-0 top-[var(--topbar-height)] z-panel animate-[np-backdrop-in_0.2s_ease] bg-[var(--cc-notifications-backdrop)]"
        onClick={handleBackdropClick}
      />
      <aside className="fixed top-[var(--topbar-height)] right-0 bottom-0 z-[91] flex w-[380px] max-w-[100vw] animate-[np-slide-in_0.2s_ease] flex-col border-y-0 border-r-0 border-l border-solid border-l-border-subtle bg-bg-surface max-768:w-[100vw]">
        <div className="flex shrink-0 items-center justify-between border-x-0 border-t-0 border-b border-solid border-b-border-subtle px-md py-sm">
          <span className="font-[family-name:var(--font-anybody)] text-[0.8rem] font-semibold tracking-[0.02em] text-text-primary uppercase">
            Activity
          </span>
          {unreadCount > 0 && onMarkAllAsRead && (
            <button
              className="mr-sm ml-auto cursor-pointer rounded-sm border-0 bg-transparent px-[8px] py-[2px] font-mono text-[0.7rem] text-[var(--cc-accent-blue)] hover:bg-[var(--cc-accent-blue-bg-hover)]"
              onClick={onMarkAllAsRead}
              title="Mark all as read"
            >
              Mark all read
            </button>
          )}
          <button
            className="relative inline-flex size-[30px] items-center justify-center rounded-sm border border-solid border-border-default bg-transparent p-0 text-[0.7rem] text-text-tertiary transition-all duration-150 ease-[ease] hover:border-border-strong hover:bg-bg-hover hover:text-text-primary max-768:size-[44px] max-768:text-[1rem] [&>svg]:size-[18px]"
            onClick={onClose}
            title="Close panel"
            aria-label="Close panel"
          >
            <CloseIcon />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-0 py-xs">
          {loading ? (
            <div className="px-md py-xl text-center text-[0.78rem] leading-[1.6] text-text-tertiary">
              Loading...
            </div>
          ) : items.length === 0 ? (
            <div className="px-md py-xl text-center text-[0.78rem] leading-[1.6] text-text-tertiary">
              No activity right now.
              <br />
              <span className="text-[0.72rem] opacity-70">
                Active conversations, merge jobs, and commit results will appear
                here.
              </span>
            </div>
          ) : (
            <>
              {conversations.length > 0 && (
                <div className="pb-xs">
                  <div className="flex items-center gap-xs px-md py-xs">
                    <span className="font-mono text-[0.7rem] font-semibold tracking-[0.08em] text-text-tertiary uppercase">
                      Conversations
                    </span>
                    <span className="rounded-sm bg-bg-raised px-[5px] py-[1px] font-mono text-[0.7rem] text-text-tertiary">
                      {conversations.length}
                    </span>
                  </div>
                  <ul className="m-0 list-none p-0">
                    {conversations.map((item) => (
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
              {jobs.length > 0 && (
                <div
                  className={cn(
                    "pb-xs",
                    conversations.length > 0 &&
                      "border-x-0 border-t border-b-0 border-solid border-t-border-subtle pt-xs",
                  )}
                >
                  <div className="flex items-center gap-xs px-md py-xs">
                    <span className="font-mono text-[0.7rem] font-semibold tracking-[0.08em] text-text-tertiary uppercase">
                      Jobs
                    </span>
                    <span className="rounded-sm bg-bg-raised px-[5px] py-[1px] font-mono text-[0.7rem] text-text-tertiary">
                      {jobs.length}
                    </span>
                  </div>
                  <ul className="m-0 list-none p-0">
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
