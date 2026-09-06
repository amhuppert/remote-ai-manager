"use client";

import { useCallback, useRef } from "react";
import { cn } from "@/lib/ui/cn";
import { Badge } from "@/components/ui/Badge";
import { IconButton } from "@/components/ui/IconButton";
import { StatusDot } from "@/components/ui/StatusDot";
import { WithTooltip } from "@/components/ui/WithTooltip";
import type { ActiveConversation } from "@/lib/active-conversations/schemas";

interface Props {
  conversation: ActiveConversation;
  href?: string;
  isActive?: boolean;
  isFirstInSession?: boolean;
  isLastInSession?: boolean;
  currentConversationId?: string | null;
  isClosed?: boolean;
  showContext?: boolean;
  onPeek?: (anchorEl: HTMLElement, conversationId: string) => void;
  onOpenMenu?: (point: { x: number; y: number }) => void;
  onClick?: () => void;
  onAcknowledge?: () => void;
}

const STATUS_LABEL: Record<ActiveConversation["status"], string> = {
  new: "new",
  running: "running",
  awaiting: "awaiting",
  waiting_for_input: "waiting for input",
};

const ROLE_LABEL: Record<NonNullable<ActiveConversation["role"]>, string> = {
  initialization: "init",
  iteration: "iter",
  validator: "validator",
  planner: "planner",
};

function formatGateStatusLine(
  pendingApproval: NonNullable<ActiveConversation["pendingApproval"]>,
): string {
  const segments = ["approval required"];
  if (
    pendingApproval.tasksCompleted !== null &&
    pendingApproval.tasksTotal !== null
  ) {
    segments.push(
      `${pendingApproval.tasksCompleted}/${pendingApproval.tasksTotal} tasks`,
    );
  }
  // The gate only parks after all validators pass, so a pending gate implies
  // a green validator outcome.
  segments.push("validators ✓");
  return segments.join(" · ");
}

function formatSidebarTime(isoDate: string): string {
  const timestamp = new Date(isoDate).getTime();
  if (!Number.isFinite(timestamp)) return "";
  const diffMs = Math.max(0, Date.now() - timestamp);
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

function formatForkTooltip(
  forkedFrom: NonNullable<ActiveConversation["forkedFrom"]>,
): string {
  const turn = Math.floor(forkedFrom.messageIndex / 2) + 1;
  return `Forked from ${forkedFrom.conversationId.slice(0, 8)} · message #${forkedFrom.messageIndex} (turn ${turn}) · ${forkedFrom.mode}`;
}

function ForkIcon(): React.JSX.Element {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 12 12"
      fill="none"
      aria-hidden="true"
    >
      <circle cx="3" cy="2.5" r="1.5" stroke="currentColor" strokeWidth="1.2" />
      <circle cx="3" cy="9.5" r="1.5" stroke="currentColor" strokeWidth="1.2" />
      <circle cx="9" cy="4.5" r="1.5" stroke="currentColor" strokeWidth="1.2" />
      <path
        d="M3 4V8M3 5.5C3 5.5 3 4.5 5.5 4.5H7.5"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
    </svg>
  );
}

function ReopenIcon(): React.JSX.Element {
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 12 12"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M9.5 5.5A3.5 3.5 0 1 1 8 2.6"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
      <path
        d="M8.2 1.4H10v1.8"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export default function ConversationSidebarRow({
  conversation,
  href,
  isActive,
  currentConversationId,
  isClosed = false,
  showContext = true,
  onPeek,
  onOpenMenu,
  onClick,
  onAcknowledge,
}: Props): React.JSX.Element {
  const rowRef = useRef<HTMLAnchorElement>(null);
  const {
    name,
    summary,
    lastActivitySummary,
    status,
    agentBackend,
    forkedFrom,
    debugActive,
    role,
    pendingQuestion,
    unread,
    pendingApproval,
    backgroundActivity,
  } = conversation;

  const contextLabel =
    conversation.scope === "session" ? conversation.sessionName : "main";
  const breadcrumbLabels =
    conversation.scope === "project"
      ? [conversation.projectName, contextLabel]
      : [contextLabel];
  const title = name ?? summary ?? "Unnamed conversation";
  const gateStatusLine =
    pendingApproval !== null ? formatGateStatusLine(pendingApproval) : null;
  const activityText = gateStatusLine ?? pendingQuestion ?? lastActivitySummary;
  const showActivity =
    !conversation.archived &&
    (status === "running" ||
      status === "waiting_for_input" ||
      (unread && status === "awaiting") ||
      pendingApproval !== null) &&
    activityText !== null &&
    activityText.trim() !== "" &&
    activityText.trim() !== title.trim();
  const timeLabel = formatSidebarTime(conversation.lastActivityAt);
  const isUnreadFinished =
    !isClosed && !conversation.archived && unread && status === "awaiting";
  // A pending approval gate owns the row's resolution: dismissing (mark-read)
  // is suppressed until the gate is decided.
  const showAck =
    isUnreadFinished && pendingApproval === null && onAcknowledge !== undefined;

  // A settled turn with harness background work still running: the row would
  // otherwise read as finished-and-idle. Only meaningful for `awaiting` — a
  // running row already advertises activity, and a gated/unread row's amber
  // standing takes precedence over an ambient background signal.
  const hasBackgroundActivity =
    !isClosed && backgroundActivity !== null && status === "awaiting";

  const gated = !isClosed && pendingApproval !== null;
  const rowClassName = cn(
    "group relative flex w-full cursor-pointer flex-col gap-sm rounded-md border border-solid pl-sm py-sm text-left no-underline transition-colors focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:outline-offset-[-2px]",
    showAck ? "pr-3xl" : "pr-sm",
    isActive
      ? "border-border-default bg-bg-raised hover:bg-bg-elevated shadow-[inset_2px_0_0_var(--color-cyan)]"
      : "border-transparent bg-bg-base hover:bg-bg-surface",
    (gated || status === "waiting_for_input") &&
      !isActive &&
      "shadow-[inset_2px_0_0_var(--color-amber)]",
  );

  const activityColor = isClosed
    ? "text-text-tertiary"
    : status === "waiting_for_input"
      ? "text-amber"
      : gateStatusLine !== null
        ? "text-amber"
        : isUnreadFinished
          ? "text-green-dim"
          : "text-text-secondary";

  const isCurrentConversation =
    currentConversationId !== null &&
    currentConversationId !== undefined &&
    conversation.id === currentConversationId;

  const handleClick = useCallback(
    (event: React.MouseEvent<HTMLAnchorElement>) => {
      // Let modifier/non-primary clicks fall through to the native anchor so
      // cmd/ctrl/middle-click still open the conversation in a new tab.
      if (
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      ) {
        return;
      }

      if (isCurrentConversation) {
        event.preventDefault();
        return;
      }

      if (conversation.scope === "session" && onPeek !== undefined) {
        event.preventDefault();
        onPeek(rowRef.current ?? event.currentTarget, conversation.id);
        return;
      }

      // Plain click: intercept the anchor's full-page navigation and let the
      // parent route client-side (router.push), so only the transcript pane
      // re-renders rather than the whole page reloading.
      event.preventDefault();
      onClick?.();
    },
    [
      conversation.id,
      conversation.scope,
      isCurrentConversation,
      onClick,
      onPeek,
    ],
  );

  const handleContextMenu = useCallback(
    (event: React.MouseEvent<HTMLAnchorElement>) => {
      if (onOpenMenu === undefined) return;
      event.preventDefault();
      onOpenMenu({ x: event.clientX, y: event.clientY });
    },
    [onOpenMenu],
  );

  return (
    <div className="relative">
      <a
        ref={rowRef}
        href={href ?? "#"}
        className={rowClassName}
        data-status={status}
        data-archived={conversation.archived === true}
        onClick={handleClick}
        onContextMenu={handleContextMenu}
        aria-label={`${title} — ${conversation.archived ? "archived" : isClosed ? "closed, click to reopen" : STATUS_LABEL[status]}${hasBackgroundActivity ? " — background activity" : ""}`}
        aria-current={isActive ? "page" : undefined}
      >
        <span className="flex min-w-0 items-start gap-sm">
          <span className="mt-xs flex shrink-0 items-center" aria-hidden="true">
            {conversation.archived ||
            isClosed ||
            status === "new" ||
            (status === "awaiting" && !unread && !hasBackgroundActivity) ? (
              <span className="size-[7px] rounded-full border border-solid border-text-tertiary" />
            ) : (
              <StatusDot
                tone={
                  gated || status === "waiting_for_input"
                    ? "amber"
                    : status === "running" || hasBackgroundActivity
                      ? "cyan"
                      : "green"
                }
              />
            )}
          </span>
          <span
            title={title}
            className="min-w-0 flex-1 truncate font-mono text-[0.82rem] leading-[1.4] font-medium text-text-primary"
          >
            {title}
          </span>
          {timeLabel !== "" && (
            <span
              className="mt-2xs shrink-0 font-mono text-[0.7rem] leading-[1.4] text-text-secondary"
              title={new Date(conversation.lastActivityAt).toLocaleString()}
            >
              {timeLabel}
            </span>
          )}
        </span>
        <span className="flex min-w-0 flex-wrap items-center gap-xs pl-lg">
          <Badge backend={agentBackend} aria-label={`agent: ${agentBackend}`}>
            {agentBackend}
          </Badge>
          {conversation.archived ? (
            <Badge tier="count">Archived</Badge>
          ) : isClosed ? (
            <WithTooltip label="Click to reopen">
              <span
                className="inline-flex items-center gap-xs font-mono text-[0.7rem] text-text-secondary"
                aria-label="reopens when selected"
              >
                <ReopenIcon />
                Closed
              </span>
            </WithTooltip>
          ) : (
            <span
              className={cn(
                "font-mono text-[0.7rem]",
                gated || status === "waiting_for_input"
                  ? "text-amber"
                  : status === "running" || hasBackgroundActivity
                    ? "text-cyan"
                    : isUnreadFinished
                      ? "text-green"
                      : "text-text-secondary",
              )}
              aria-label={
                gated
                  ? "approval required"
                  : isUnreadFinished
                    ? "unread"
                    : undefined
              }
            >
              {gated
                ? "Approval"
                : status === "waiting_for_input"
                  ? "Needs input"
                  : status === "running"
                    ? "Running"
                    : hasBackgroundActivity
                      ? "Background"
                      : isUnreadFinished
                        ? "Unread"
                        : status === "new"
                          ? "New"
                          : "Ready"}
            </span>
          )}
          {forkedFrom !== null && (
            <WithTooltip label={formatForkTooltip(forkedFrom)}>
              <span
                className="inline-flex text-text-secondary"
                aria-label={`forked (${forkedFrom.mode})`}
              >
                <ForkIcon />
              </span>
            </WithTooltip>
          )}
          {debugActive && (
            <Badge tier="count" aria-label="debug active">
              debug
            </Badge>
          )}
          {role !== null && (
            <Badge tier="count" aria-label={`role: ${role}`}>
              {ROLE_LABEL[role]}
            </Badge>
          )}
          {showContext && (
            <span className="min-w-0 truncate font-mono text-[0.7rem] text-text-secondary">
              {breadcrumbLabels.join(" / ")}
            </span>
          )}
        </span>
        {showActivity && (
          <span
            className={cn(
              "pl-lg font-mono text-[0.72rem] leading-[1.5]",
              status === "waiting_for_input" || gated
                ? "line-clamp-2"
                : "line-clamp-1",
              activityColor,
            )}
          >
            {!isClosed && !gated && status === "waiting_for_input" && (
              <span>Asks › </span>
            )}
            {activityText}
          </span>
        )}
      </a>
      {showAck && (
        <div className="absolute right-xs top-1/2 -translate-y-1/2">
          <WithTooltip label="Mark as read">
            <IconButton
              aria-label={`Mark "${title}" as read`}
              onClick={(event) => {
                event.stopPropagation();
                onAcknowledge?.();
              }}
            >
              <svg
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                aria-hidden="true"
              >
                <path d="m3 8 3 3 7-7" />
              </svg>
            </IconButton>
          </WithTooltip>
        </div>
      )}
    </div>
  );
}
