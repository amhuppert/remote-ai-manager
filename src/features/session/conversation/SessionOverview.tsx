"use client";

import { useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
import type { PublicSessionState } from "@/lib/sessions/schemas";
import type { PublicConversationState } from "@/lib/conversations/schemas";
import {
  deriveSessionStatus,
  deriveSessionPromptCount,
} from "@/lib/sessions/derived";
import { cn } from "@/lib/ui/cn";
import { createClientLogger } from "@/lib/logging/client-logger";
import { Button } from "@/components/ui/Button";
import { WithTooltip } from "@/components/ui/WithTooltip";
import { IconButton } from "@/components/ui/IconButton";
import { StatusChip } from "@/components/ui/StatusChip";
import { FormInput } from "@/components/ui/FormField";
import {
  SegmentedControl,
  SegmentedControlItem,
} from "@/components/ui/SegmentedControl";
import {
  ArchiveIcon,
  ArrowUpRightIcon,
  BranchIcon,
  CheckIcon,
  CopyIcon,
  SearchIcon,
} from "@/components/icons";
import SessionConversationRow, {
  SessionStatus,
} from "./SessionConversationRow";
import {
  formatSessionDate,
  selectSessionConversations,
  type ConversationFilter,
} from "./session-overview-model";

const log = createClientLogger("session-overview");
const linkClass =
  "inline-flex items-center gap-sm rounded-md border border-solid border-border-default bg-bg-surface px-md py-sm text-[0.78rem] font-medium text-text-primary no-underline transition-colors hover:border-border-strong hover:bg-bg-raised focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:outline-offset-2 max-768:min-h-[44px]";

export function SessionCopyField({
  label,
  value,
}: {
  label: string;
  value: string;
}) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setFailed(false);
      log.debug("session_overview.field_copied", { field: label });
    } catch {
      setFailed(true);
      log.warn("session_overview.copy_failed", { field: label });
    }
  }
  return (
    <div className="min-w-0">
      <dt className="mb-xs text-[0.7rem] tracking-[0.08em] text-text-secondary uppercase">
        {label}
      </dt>
      <dd className="flex items-start gap-sm">
        <code className="min-w-0 flex-1 py-xs font-mono text-[0.72rem] leading-relaxed [overflow-wrap:anywhere] text-text-primary">
          {value}
        </code>
        <WithTooltip label={copied ? "Copied" : `Copy ${label.toLowerCase()}`}>
          <IconButton
            aria-label={`Copy ${label.toLowerCase()}`}
            onClick={() => void copy()}
          >
            {copied ? <CheckIcon size={16} /> : <CopyIcon size={16} />}
          </IconButton>
        </WithTooltip>
      </dd>
      {copied && (
        <span role="status" className="sr-only">
          {label} copied
        </span>
      )}
      {failed && (
        <p role="alert" className="text-[0.72rem] text-red-text">
          Could not copy {label.toLowerCase()}.
        </p>
      )}
    </div>
  );
}

interface SessionOverviewProps {
  projectName: string;
  session: PublicSessionState;
  conversations: PublicConversationState[];
  showArchived: boolean;
  onToggleArchived(): void;
  onArchive(id: string, archived: boolean): void;
  onRename(id: string, name: string): Promise<unknown>;
  archivePendingId?: string;
  conversationError?: string | null;
  conversationsLoading?: boolean;
  onRetryConversations?(): void;
  createAction: ReactNode;
  sessionActions: ReactNode;
  workflow: ReactNode;
  workspaceTools: ReactNode;
  ticket?: ReactNode;
  finishedNotice?: ReactNode;
}

export default function SessionOverview({
  projectName,
  session,
  conversations,
  showArchived,
  onToggleArchived,
  onArchive,
  onRename,
  archivePendingId,
  conversationError,
  conversationsLoading,
  onRetryConversations,
  createAction,
  sessionActions,
  workflow,
  workspaceTools,
  ticket,
  finishedNotice,
}: SessionOverviewProps) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<ConversationFilter>("all");
  const visible = useMemo(
    () =>
      selectSessionConversations(conversations, {
        query,
        filter,
        showArchived,
      }),
    [conversations, query, filter, showArchived],
  );
  const ordinary = conversations.filter(
    (conversation) => conversation.role === null,
  );
  const active = ordinary.filter((conversation) => !conversation.archived);
  const attention = active.filter(
    (conversation) => conversation.status === "waiting_for_input",
  ).length;
  const running = active.filter(
    (conversation) => conversation.status === "running",
  ).length;
  const archived = ordinary.length - active.length;
  const baseHref = `/projects/${encodeURIComponent(projectName)}/${encodeURIComponent(session.sessionName)}`;
  const stats = [
    { label: "Conversations", value: active.length, accent: "none" },
    {
      label: "Needs input",
      value: attention,
      accent: attention ? "amber" : "none",
    },
    { label: "Running", value: running, accent: running ? "cyan" : "none" },
    {
      label: "Total prompts",
      value: deriveSessionPromptCount(session),
      accent: "none",
    },
  ];

  return (
    <div
      data-testid="session-overview"
      className="mx-auto w-full max-w-[1440px] px-2xl py-2xl font-mono max-768:px-lg max-768:py-xl max-1180:px-xl"
    >
      <header className="mb-2xl">
        <div className="mb-md flex flex-wrap items-center gap-sm text-[0.7rem] tracking-[0.1em] text-text-secondary uppercase">
          <span>Session overview</span>
          <span aria-hidden="true">/</span>
          <span>{projectName}</span>
          <SessionStatus
            status={session.finished ? "merged" : deriveSessionStatus(session)}
          />
          {session.archived && <StatusChip>Archived</StatusChip>}
        </div>
        <div className="flex items-start justify-between gap-xl max-960:flex-col max-960:gap-lg">
          <div className="min-w-0">
            <h1 className="font-display text-[2rem] leading-[1.15] font-extrabold tracking-[-0.035em] [overflow-wrap:anywhere] text-text-primary max-768:text-[1.6rem]">
              {session.sessionName}
            </h1>
            <div className="mt-md flex flex-wrap items-center gap-x-lg gap-y-sm text-[0.72rem] text-text-secondary">
              <span className="inline-flex min-w-0 items-center gap-sm">
                <BranchIcon size={16} />
                <span className="[overflow-wrap:anywhere]">
                  {session.branchName}
                </span>
              </span>
              <span>
                Created{" "}
                <time dateTime={session.createdAt}>
                  {formatSessionDate(session.createdAt)}
                </time>
              </span>
              {ticket}
            </div>
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-sm">
            {createAction}
            {sessionActions}
          </div>
        </div>
      </header>

      {session.finished && (
        <div className="mb-xl flex flex-wrap items-center gap-sm rounded-md border border-solid border-green-glow bg-green-glow p-md text-[0.78rem] leading-relaxed text-green">
          <CheckIcon size={18} />
          <span>
            Marked as merged into <strong>{session.targetBranch}</strong>. You
            can continue working in this session.
          </span>
          {finishedNotice}
        </div>
      )}

      <dl className="mb-2xl grid grid-cols-4 gap-lg border-x-0 border-y border-solid border-border-subtle py-xl max-768:grid-cols-2">
        {stats.map(({ label, value, accent }) => (
          <div key={label} data-accent={accent} className="group min-w-0">
            <dd className="mb-sm text-[1.65rem] leading-none font-medium text-text-primary tabular-nums group-data-[accent=amber]:text-amber group-data-[accent=cyan]:text-cyan">
              {conversationsLoading || conversationError ? "—" : value}
            </dd>
            <dt className="text-[0.7rem] tracking-[0.08em] text-text-secondary uppercase">
              {label}
            </dt>
          </div>
        ))}
      </dl>

      <div className="grid grid-cols-[minmax(0,1fr)_300px] items-start gap-2xl max-1180:grid-cols-1 max-1180:gap-xl">
        <section
          aria-labelledby="session-conversations-title"
          className="min-w-0"
        >
          <div className="mb-lg flex items-center justify-between gap-md">
            <div>
              <h2
                id="session-conversations-title"
                className="font-display text-[1.2rem] font-semibold tracking-[-0.02em] text-text-primary"
              >
                Conversations
              </h2>
              <p className="mt-xs text-[0.72rem] leading-relaxed text-text-secondary">
                {attention > 0
                  ? "Decisions first. Running work next."
                  : "Pick up a conversation or start a new one."}
              </p>
            </div>
            {(archived > 0 || showArchived) && (
              <Button
                size="sm"
                touch
                aria-pressed={showArchived}
                onClick={onToggleArchived}
              >
                <ArchiveIcon size={14} />
                <span className="whitespace-nowrap">
                  {showArchived ? "Hide archived" : "Archived"} {archived}
                </span>
              </Button>
            )}
          </div>
          <div className="mb-lg flex flex-col gap-md">
            <div className="relative">
              <FormInput
                aria-label="Search session conversations"
                placeholder="Search conversations…"
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
              {!query && (
                <span
                  aria-hidden="true"
                  className="pointer-events-none absolute top-1/2 right-md -translate-y-1/2 text-text-secondary"
                >
                  <SearchIcon size={16} />
                </span>
              )}
            </div>
            <div className="overflow-x-auto pb-xs">
              <SegmentedControl
                aria-label="Filter session conversations"
                value={filter}
                onValueChange={(value) => {
                  if (
                    value === "all" ||
                    value === "attention" ||
                    value === "running" ||
                    value === "unread"
                  )
                    setFilter(value);
                }}
              >
                <SegmentedControlItem value="all">All</SegmentedControlItem>
                <SegmentedControlItem value="attention">
                  Needs input
                </SegmentedControlItem>
                <SegmentedControlItem value="running">
                  Running
                </SegmentedControlItem>
                <SegmentedControlItem value="unread">
                  Unread
                </SegmentedControlItem>
              </SegmentedControl>
            </div>
          </div>
          {conversationError ? (
            <div
              role="alert"
              className="rounded-lg border border-solid border-red-glow bg-bg-base p-xl"
            >
              <h3 className="mb-sm text-[0.85rem] text-text-primary">
                Could not load conversations
              </h3>
              <p className="mb-lg text-[0.78rem] leading-relaxed text-text-secondary">
                {conversationError}
              </p>
              <Button size="sm" onClick={onRetryConversations}>
                Try again
              </Button>
            </div>
          ) : conversationsLoading ? (
            <p
              role="status"
              className="py-2xl text-[0.82rem] text-text-secondary"
            >
              Loading conversations…
            </p>
          ) : visible.length > 0 ? (
            <ul
              data-testid="conversation-list"
              className="m-0 flex list-none flex-col gap-sm p-0"
            >
              {visible.map((conversation) => (
                <SessionConversationRow
                  key={conversation.id}
                  conversation={conversation}
                  archivePending={archivePendingId === conversation.id}
                  onArchive={onArchive}
                  onRename={onRename}
                />
              ))}
            </ul>
          ) : (
            <div className="rounded-lg border border-dashed border-border-default bg-bg-base px-xl py-3xl text-center">
              <h3 className="font-display text-[1.1rem] font-semibold text-text-primary">
                {query || filter !== "all"
                  ? "No matching conversations"
                  : archived > 0
                    ? "No active conversations"
                    : "No conversations yet"}
              </h3>
              <p className="mx-auto mt-sm max-w-[320px] text-[0.78rem] leading-relaxed text-text-secondary">
                {query || filter !== "all"
                  ? "Try another search or clear the filters."
                  : archived > 0
                    ? "Show archived conversations to revisit earlier work."
                    : "Start a conversation to work with an agent in this session."}
              </p>
              {(query || filter !== "all") && (
                <Button
                  size="sm"
                  layoutClassName="mt-lg"
                  onClick={() => {
                    setQuery("");
                    setFilter("all");
                  }}
                >
                  Clear filters
                </Button>
              )}
            </div>
          )}
          <p role="status" className="mt-md text-[0.7rem] text-text-secondary">
            {!conversationError &&
              !conversationsLoading &&
              `${visible.length} shown${archived > 0 && !showArchived ? ` · ${archived} archived` : ""}`}
          </p>
        </section>

        <aside
          aria-label="Session workspace"
          className="flex min-w-0 flex-col gap-xl"
        >
          <section aria-label="Workflow" className="min-w-0">
            {workflow}
          </section>
          <section
            aria-labelledby="session-workspace-title"
            className="min-w-0 rounded-lg border border-solid border-border-subtle bg-bg-base p-lg"
          >
            <div className="mb-lg flex items-center gap-sm">
              <BranchIcon size={18} />
              <h2
                id="session-workspace-title"
                className="text-[0.82rem] font-semibold text-text-primary"
              >
                Workspace
              </h2>
            </div>
            <dl className="flex flex-col gap-md">
              <SessionCopyField label="Branch" value={session.branchName} />
              <div>
                <dt className="mb-xs text-[0.7rem] tracking-[0.08em] text-text-secondary uppercase">
                  Target branch
                </dt>
                <dd className="text-[0.78rem] text-text-primary">
                  {session.targetBranch}
                </dd>
              </div>
              <SessionCopyField label="Worktree" value={session.worktreePath} />
            </dl>
            <Link
              href={`${baseHref}/diff`}
              className={cn(linkClass, "mt-lg w-full justify-between")}
            >
              Review changes
              <ArrowUpRightIcon size={16} />
            </Link>
            <div className="mt-lg border-x-0 border-t border-b-0 border-solid border-border-subtle pt-lg">
              {workspaceTools}
            </div>
          </section>
        </aside>
      </div>
    </div>
  );
}

export function SessionOverviewPending({
  sessionName,
  error,
  onRetry,
}: {
  sessionName: string;
  error?: string | null;
  onRetry(): void;
}) {
  return (
    <div className="mx-auto w-full max-w-[1440px] p-2xl max-768:p-lg">
      <p className="mb-md font-mono text-[0.72rem] tracking-[0.08em] text-text-secondary uppercase">
        Session overview
      </p>
      <h1 className="mb-xl font-display text-[2rem] [overflow-wrap:anywhere] text-text-primary">
        {sessionName}
      </h1>
      {error ? (
        <div role="alert">
          <p className="mb-lg text-text-secondary">{error}</p>
          <Button onClick={onRetry}>Try again</Button>
        </div>
      ) : (
        <div
          role="status"
          className="rounded-lg border border-solid border-border-subtle bg-bg-base p-xl font-mono text-[0.82rem] text-text-secondary"
        >
          Loading session…
        </div>
      )}
    </div>
  );
}
