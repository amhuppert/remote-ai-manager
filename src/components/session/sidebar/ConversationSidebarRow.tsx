"use client";

import { useCallback, useRef } from "react";
import { cn } from "@/lib/ui/cn";
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

// Status dot color (legacy `.conversation-sidebar-row__dot[data-status]`). An
// unread-finished or gated row recolors the dot amber, overriding status (the
// legacy unread/gated rules are sourced after the status rules).
const DOT_STATUS: Record<ActiveConversation["status"], string> = {
  new: "bg-blue shadow-[0_0_6px_var(--color-blue-glow)]",
  running: "bg-cyan shadow-[0_0_6px_var(--color-cyan-glow-strong)]",
  waiting_for_input: "bg-amber shadow-[0_0_6px_var(--color-amber-glow)]",
  awaiting: "bg-green shadow-[0_0_6px_var(--color-green-glow)]",
};
const DOT_AMBER = "bg-amber shadow-[0_0_6px_var(--color-amber)]";

// Row badge recipe (legacy `.cc-badge` base merged with the row's
// `.conversation-sidebar-row__badge` size override: 0.7rem / 1px 6px / gap 3px).
const BADGE_BASE =
  "inline-flex items-center justify-center gap-[3px] px-[6px] py-[1px] rounded-full font-mono text-[0.7rem] font-semibold leading-[1.2] whitespace-nowrap";

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
  isFirstInSession,
  isLastInSession,
  currentConversationId,
  isClosed = false,
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
    activityText !== null &&
    activityText.trim() !== "" &&
    activityText.trim() !== title.trim();
  const timeLabel = formatSidebarTime(conversation.lastActivityAt);
  const isUnreadFinished =
    !isClosed && unread && status !== "waiting_for_input";
  const statusPrefix = isClosed
    ? null
    : gateStatusLine !== null
      ? null
      : status === "waiting_for_input"
        ? "Asks"
        : isUnreadFinished
          ? "Done"
          : status === "running"
            ? "Running"
            : null;
  // A pending approval gate owns the row's resolution: dismissing (mark-read)
  // is suppressed until the gate is decided.
  const showAck =
    isUnreadFinished && pendingApproval === null && onAcknowledge !== undefined;

  const gated = !isClosed && pendingApproval !== null;
  const hasOverlay =
    (!isClosed && pendingQuestion !== null) || gated || isUnreadFinished;

  const rowClassName = cn(
    "relative flex w-full cursor-pointer flex-col items-start gap-[5px] overflow-hidden rounded-md border px-[12px] py-[8px] text-left text-inherit no-underline transition-[background-color,border-color] duration-[120ms] ease-[ease] hover:bg-bg-surface",
    isClosed ? "border-dashed" : "border-solid",
    isActive ? "bg-bg-surface" : "bg-transparent",
    // Border color per side: active rows are border-strong, but a row that is
    // first/last in its session keeps border-dim on that edge (legacy
    // `.is-first/last-in-session` is sourced after `.is-active`).
    isActive ? "border-x-border-strong" : "border-x-border-dim",
    isActive && !isFirstInSession
      ? "border-t-border-strong"
      : "border-t-border-dim",
    isActive && !isLastInSession
      ? "border-b-border-strong"
      : "border-b-border-dim",
    isActive &&
      "before:absolute before:top-[8px] before:bottom-[8px] before:left-[-1px] before:w-[2px] before:rounded-[1px] before:bg-cyan before:shadow-[0_0_6px_var(--color-cyan)] before:content-['']",
    isClosed && "opacity-[0.72] hover:opacity-[0.92]",
    isUnreadFinished &&
      !isActive &&
      "shadow-[inset_2px_0_0_var(--color-amber)]",
    hasOverlay &&
      "after:pointer-events-none after:absolute after:inset-0 after:rounded-[inherit] after:[background-image:linear-gradient(90deg,var(--amber-glow),transparent_60%)] after:opacity-[0.65] after:content-['']",
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
    <a
      ref={rowRef}
      href={href ?? "#"}
      className={rowClassName}
      data-status={status}
      onClick={handleClick}
      onContextMenu={handleContextMenu}
      aria-label={`${title} — ${isClosed ? "closed, click to reopen" : STATUS_LABEL[status]}`}
      aria-current={isActive ? "page" : undefined}
    >
      <span className="relative z-[1] flex w-full min-w-0 flex-1 flex-col gap-[5px]">
        <span className="relative z-[1] flex w-full min-w-0 items-center gap-[6px] pr-[28px]">
          <span
            className={cn(
              "mt-0 size-[7px] shrink-0 rounded-full",
              isUnreadFinished || gated ? DOT_AMBER : DOT_STATUS[status],
            )}
            aria-hidden="true"
          />
          <span className="min-w-0 flex-1 overflow-hidden font-mono text-[0.86rem] leading-[1.25] font-bold text-ellipsis whitespace-nowrap text-text-primary">
            {title}
          </span>
          {!isClosed && pendingApproval !== null && (
            <span
              className="inline-flex h-[16px] shrink-0 items-center rounded-full border border-solid border-[var(--cc-amber-a35)] bg-amber-glow px-[6px] font-mono text-[0.58rem] font-semibold tracking-[0.06em] text-amber uppercase"
              aria-label="approval required"
            >
              approval
            </span>
          )}
          {isClosed && (
            <WithTooltip label="Click to reopen">
              <span
                className="inline-flex shrink-0 items-center justify-center text-text-tertiary"
                aria-label="reopens when selected"
              >
                <ReopenIcon />
              </span>
            </WithTooltip>
          )}
          {isUnreadFinished && (
            <span
              className="ml-[2px] size-[6px] shrink-0 rounded-full bg-amber shadow-[0_0_6px_var(--color-amber)]"
              aria-label="unread"
            />
          )}
          {timeLabel !== "" && (
            <span
              className="absolute top-[2px] right-0 min-w-[24px] shrink-0 text-right font-mono text-[0.7rem] leading-none text-text-tertiary"
              title={new Date(conversation.lastActivityAt).toLocaleString()}
            >
              {timeLabel}
            </span>
          )}
        </span>

        <span className="relative z-[1] flex min-w-0 items-center gap-[6px]">
          <span className="inline-flex shrink-0 items-center gap-xs">
            <span
              className={cn(
                BADGE_BASE,
                "opacity-50",
                agentBackend === "codex"
                  ? "bg-violet-glow text-violet"
                  : "bg-cyan-glow text-cyan",
              )}
              aria-label={`agent: ${agentBackend}`}
            >
              {agentBackend}
            </span>
            {forkedFrom !== null && (
              <WithTooltip label={formatForkTooltip(forkedFrom)}>
                <span
                  className={cn(
                    BADGE_BASE,
                    "bg-bg-raised text-text-secondary opacity-50",
                  )}
                  aria-label={`forked (${forkedFrom.mode})`}
                >
                  <ForkIcon />
                  {forkedFrom.mode}
                </span>
              </WithTooltip>
            )}
            {debugActive && (
              <WithTooltip label="Debug mode active">
                <span
                  className={cn(
                    BADGE_BASE,
                    "bg-violet-glow text-violet shadow-[0_0_6px_var(--color-violet-glow)]",
                  )}
                  aria-label="debug active"
                >
                  debug
                </span>
              </WithTooltip>
            )}
            {role !== null && (
              <span
                className={cn(
                  BADGE_BASE,
                  "bg-bg-raised tracking-[0.06em] text-text-secondary uppercase",
                )}
                aria-label={`role: ${role}`}
              >
                {ROLE_LABEL[role]}
              </span>
            )}
          </span>

          <span className="flex min-w-0 flex-1 items-center gap-xs overflow-hidden font-mono text-[0.7rem] text-text-tertiary">
            {breadcrumbLabels.map((label, index) => (
              <span key={`${index}-${label}`}>
                {index > 0 && (
                  <span className="shrink-0 text-border-strong">/</span>
                )}
                <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">
                  {label}
                </span>
              </span>
            ))}
          </span>
        </span>

        {showActivity && (
          <span
            className={cn(
              "relative z-[1] line-clamp-2 font-mono text-[0.72rem] leading-[1.35]",
              activityColor,
            )}
          >
            {statusPrefix !== null && (
              <span
                className={cn(
                  "mr-[4px]",
                  statusPrefix === "Asks"
                    ? "text-amber"
                    : statusPrefix === "Done"
                      ? "text-green"
                      : "text-text-tertiary",
                )}
              >
                {statusPrefix} &rsaquo;
              </span>
            )}
            {activityText}
          </span>
        )}

        {showAck && (
          <span className="relative z-[1] mt-[2px] flex justify-end">
            <button
              type="button"
              className="inline-flex h-[22px] cursor-pointer items-center gap-[5px] rounded-sm border border-solid border-amber-dim bg-amber-glow py-0 pr-[9px] pl-[7px] font-mono text-[0.62rem] font-bold tracking-[0.08em] text-amber uppercase transition-[background-color,border-color,transform] duration-[140ms] ease-[ease] hover:border-amber hover:bg-[var(--cc-amber-a22)] active:translate-y-[1px]"
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                onAcknowledge?.();
              }}
              aria-label={`Mark "${title}" as read`}
            >
              &#10003; OK
            </button>
          </span>
        )}
      </span>
    </a>
  );
}
