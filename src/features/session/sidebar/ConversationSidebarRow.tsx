"use client";

import type { ActiveConversation } from "@/lib/active-conversations/schemas";

interface Props {
  conversation: ActiveConversation;
  isActive?: boolean;
  isFirstInSession?: boolean;
  isLastInSession?: boolean;
  onClick?: () => void;
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

export default function ConversationSidebarRow({
  conversation,
  isActive,
  isFirstInSession,
  isLastInSession,
  onClick,
}: Props): React.JSX.Element {
  const {
    name,
    summary,
    lastActivitySummary,
    status,
    sessionName,
    agentBackend,
    forkedFrom,
    debugActive,
    role,
    pendingQuestion,
  } = conversation;

  const title = name ?? summary ?? "Unnamed conversation";
  const activityText = pendingQuestion ?? lastActivitySummary;
  const showActivity =
    activityText !== null &&
    activityText.trim() !== "" &&
    activityText.trim() !== title.trim();
  const timeLabel = formatSidebarTime(conversation.lastActivityAt);
  const statusPrefix =
    status === "waiting_for_input"
      ? "Asks"
      : status === "running"
        ? "Running"
        : null;

  const classNames = [
    "conversation-sidebar-row",
    isActive ? "is-active" : null,
    isFirstInSession ? "is-first-in-session" : null,
    isLastInSession ? "is-last-in-session" : null,
    pendingQuestion !== null ? "has-pending-question" : null,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <button
      type="button"
      className={classNames}
      data-status={status}
      onClick={onClick}
      aria-label={`${title} — ${STATUS_LABEL[status]}`}
      aria-current={isActive ? "true" : undefined}
    >
      <span className="conversation-sidebar-row__main">
        <span className="conversation-sidebar-row__title-line">
          <span
            className="conversation-sidebar-row__dot"
            data-status={status}
            aria-hidden="true"
          />
          <span className="conversation-sidebar-row__title">{title}</span>
          {timeLabel !== "" && (
            <span
              className="conversation-sidebar-row__time"
              title={new Date(conversation.lastActivityAt).toLocaleString()}
            >
              {timeLabel}
            </span>
          )}
        </span>

        <span className="conversation-sidebar-row__meta-line">
          <span className="conversation-sidebar-row__badges">
            <span
              className="cc-badge cc-badge--subtle conversation-sidebar-row__badge"
              data-type={agentBackend}
              data-backend={agentBackend}
              aria-label={`agent: ${agentBackend}`}
            >
              {agentBackend}
            </span>
            {forkedFrom !== null && (
              <span
                className="cc-badge cc-badge--subtle conversation-sidebar-row__badge"
                data-type="fork"
                data-tooltip={formatForkTooltip(forkedFrom)}
                aria-label={`forked (${forkedFrom.mode})`}
              >
                <ForkIcon />
                {forkedFrom.mode}
              </span>
            )}
            {debugActive && (
              <span
                className="cc-badge conversation-sidebar-row__badge"
                data-type="debug-active"
                data-tooltip="Debug mode active"
                aria-label="debug active"
              >
                debug
              </span>
            )}
            {role !== null && (
              <span
                className="cc-badge conversation-sidebar-row__badge"
                data-type="role"
                data-role={role}
                aria-label={`role: ${role}`}
              >
                {ROLE_LABEL[role]}
              </span>
            )}
          </span>

          <span className="conversation-sidebar-row__breadcrumb">
            <span className="conversation-sidebar-row__crumb">
              {sessionName}
            </span>
          </span>
        </span>

        {showActivity && (
          <span className="conversation-sidebar-row__activity">
            {statusPrefix !== null && (
              <span className="conversation-sidebar-row__activity-prefix">
                {statusPrefix} &rsaquo;
              </span>
            )}
            {activityText}
          </span>
        )}
      </span>
    </button>
  );
}
