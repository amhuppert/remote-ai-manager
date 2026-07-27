"use client";

import { useState, useCallback, useMemo, useRef, useEffect } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { cn } from "@/lib/ui/cn";
import { Button } from "@/components/ui/Button";
import { IconButton } from "@/components/ui/IconButton";
import { WithTooltip } from "@/components/ui/WithTooltip";
import {
  EmptyState,
  EmptyStateTitle,
  EmptyStateDesc,
} from "@/components/ui/EmptyState";
import type { ConversationState } from "@/lib/conversations/schemas";
import { CloseIcon } from "@/components/icons";
import {
  deriveSessionStatus,
  deriveSessionPromptCount,
} from "@/lib/sessions/derived";
import { buildSessionContext } from "@/lib/conversations/copy-context";
import { conversationsPageHref } from "@/lib/conversations/hrefs";
import { formatRelativeTime } from "@/lib/shared/format-relative-time";
import { useConversationsQuery } from "@/lib/conversations/queries";
import { useSessionQuery } from "@/lib/sessions/queries";
import { useGraphWorkflowExecutionQuery } from "@/lib/workflows/queries";
import { useAppHotkey } from "@/hooks/useAppHotkey";
import {
  useCreateConversationMutation,
  useArchiveConversationMutation,
  useRenameConversationMutation,
} from "@/lib/conversations/mutations";
import { useDeleteSessionMutation } from "@/lib/sessions/mutations";
import {
  useShowArchivedConversations,
  useToggleArchivedConversations,
} from "@/stores/conversations.store";
import Topbar from "@/components/Topbar";
import WorkRailMain from "@/components/WorkRailMain";
import ConfirmDialog from "@/components/ConfirmDialog";
import CopyableId from "@/components/CopyableId";
import SessionTicketIndicator from "@/components/SessionTicketIndicator";
import ScopedAgentCapabilitiesConfig from "@/components/agent-capabilities/ScopedAgentCapabilitiesConfig";
import GraphWorkflowCard from "@/features/session/conversation/GraphWorkflowCard";

interface Props {
  projectName: string;
  sessionName: string;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// Status-dot recipe. Reproduces the merged `.session-status` cascade (session.css
// base + conversation.css overrides, the latter winning on conflicts) so this
// usage no longer depends on the `.session-status` rule. That rule survives only
// as the now-consumerless conversation.css copy, awaiting deletion by the
// conversation/right-pane context.
const STATUS_DOT: Record<string, string> = {
  running:
    "bg-cyan shadow-[0_0_6px_var(--cyan)] animate-[pulse-dot_1.5s_ease-in-out_infinite]",
  idle: "bg-text-tertiary",
  new: "bg-blue shadow-[0_0_6px_var(--blue)]",
  ready: "bg-green shadow-[0_0_6px_var(--green)]",
  awaiting: "bg-green shadow-[0_0_6px_var(--green)]",
  waiting_for_input:
    "bg-amber shadow-[0_0_6px_var(--amber)] animate-[pulse-dot_1.5s_ease-in-out_infinite]",
};

const STATUS_LABEL: Record<string, string> = {
  running: "text-cyan",
  idle: "text-text-tertiary",
  new: "text-blue",
  ready: "text-green",
  awaiting: "text-green",
  waiting_for_input: "text-amber",
};

function ConversationStatusDot({ status }: { status: string }) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-[6px] font-mono text-[0.72rem] leading-none font-medium tracking-[0.05em] uppercase",
        STATUS_LABEL[status] ?? "text-text-secondary",
      )}
    >
      <span
        className={cn(
          "h-[6px] w-[6px] shrink-0 rounded-full",
          STATUS_DOT[status] ?? "bg-text-tertiary",
        )}
      />
      {status}
    </span>
  );
}

export default function ConversationList({
  projectName,
  sessionName,
}: Props): React.JSX.Element {
  const router = useRouter();

  // --- TanStack Query ---
  const sessionQuery = useSessionQuery(projectName, sessionName);
  const conversationsQuery = useConversationsQuery(projectName, sessionName);
  const graphWorkflowExecutionQuery = useGraphWorkflowExecutionQuery(
    projectName,
    sessionName,
  );

  // --- Zustand ---
  const showArchived = useShowArchivedConversations();
  const toggleArchived = useToggleArchivedConversations();

  // --- Mutations ---
  const deleteMutation = useDeleteSessionMutation(projectName);
  const createConvoMutation = useCreateConversationMutation(
    projectName,
    sessionName,
  );
  const archiveConvoMutation = useArchiveConversationMutation(
    projectName,
    sessionName,
  );
  const renameConvoMutation = useRenameConversationMutation(
    projectName,
    sessionName,
  );

  // --- Local UI state ---
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [contextCopied, setContextCopied] = useState(false);

  // --- Derived data ---
  const session = sessionQuery.data;
  const conversations = useMemo(
    () => conversationsQuery.data ?? [],
    [conversationsQuery.data],
  );
  const isFinished = session?.finished ?? false;
  const targetBranch = session?.targetBranch ?? "main";
  const sessionStatus = session ? deriveSessionStatus(session) : "idle";

  // Workflow conversations (role !== null) are surfaced on the workflow page
  // instead of the session overview to reduce noise.
  const nonWorkflowConversations = useMemo(
    () => conversations.filter((c) => c.role === null),
    [conversations],
  );

  const archivedCount = useMemo(
    () => nonWorkflowConversations.filter((c) => c.archived).length,
    [nonWorkflowConversations],
  );

  const filteredConversations = useMemo(() => {
    if (showArchived) return nonWorkflowConversations;
    return nonWorkflowConversations.filter((c) => !c.archived);
  }, [nonWorkflowConversations, showArchived]);

  const activeCount = nonWorkflowConversations.length - archivedCount;

  // --- Copy session context for debugging ---
  const handleCopyContext = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      if (!session) return;
      const text = buildSessionContext({
        projectName,
        sessionName,
        session,
        graphWorkflowExecution: graphWorkflowExecutionQuery.data ?? null,
      });
      void navigator.clipboard.writeText(text).then(() => {
        setContextCopied(true);
        setTimeout(() => setContextCopied(false), 1500);
      });
    },
    [session, projectName, sessionName, graphWorkflowExecutionQuery.data],
  );

  const handleNewConversation = useCallback(() => {
    if (createConvoMutation.isPending || isFinished) return;
    createConvoMutation.mutate(undefined, {
      onSuccess: (convo) => {
        router.push(conversationsPageHref({ conversationId: convo.id }));
      },
    });
  }, [createConvoMutation, isFinished, projectName, sessionName, router]);
  useAppHotkey("newConversation", handleNewConversation, {
    enabled: !createConvoMutation.isPending && !isFinished,
  });

  const handleDelete = useCallback(() => {
    setShowDeleteConfirm(false);
    deleteMutation.mutate(sessionName, {
      onSuccess: () => {
        router.push(`/projects/${encodeURIComponent(projectName)}`);
      },
    });
  }, [deleteMutation, sessionName, projectName, router]);

  const handleArchive = useCallback(
    (conversationId: string, archived: boolean) => {
      archiveConvoMutation.mutate({ conversationId, archived });
    },
    [archiveConvoMutation],
  );

  // --- Rename conversation ---
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const editInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editingId && editInputRef.current) {
      editInputRef.current.focus();
      editInputRef.current.select();
    }
  }, [editingId]);

  const handleRenameStart = useCallback((convo: ConversationState) => {
    setEditingId(convo.id);
    setEditValue(convo.name ?? convo.summary ?? "");
  }, []);

  const handleRenameSubmit = useCallback(
    (conversationId: string) => {
      const trimmed = editValue.trim();
      if (!trimmed) {
        setEditingId(null);
        return;
      }
      renameConvoMutation.mutate(
        { conversationId, name: trimmed },
        { onSettled: () => setEditingId(null) },
      );
    },
    [editValue, renameConvoMutation],
  );

  const displayStatus = isFinished ? "merged" : sessionStatus;
  const statusDotClass =
    displayStatus === "running"
      ? "cyan"
      : displayStatus === "merged"
        ? "green"
        : "";

  const mostRecentId = filteredConversations[0]?.id;

  const isLoading = sessionQuery.isPending || conversationsQuery.isPending;

  return (
    <div className="app" data-page="conversations">
      <Topbar
        page="detail"
        breadcrumbs={[
          { label: "projects", href: "/projects" },
          {
            label: projectName,
            href: `/projects/${encodeURIComponent(projectName)}`,
            isProject: true,
          },
          {
            label: sessionName,
            href: `/projects/${encodeURIComponent(projectName)}/${encodeURIComponent(sessionName)}`,
            isSession: true,
          },
        ]}
        sessionControls={
          <>
            <div className="status-indicator">
              <div className={`status-dot ${statusDotClass}`} />
              {displayStatus}
            </div>
            <div className="topbar-sep" />
            <WithTooltip label="Delete session">
              <IconButton
                variant="square"
                tone="danger"
                layoutClassName="max-768:hidden"
                aria-label="Delete session"
                onClick={() => setShowDeleteConfirm(true)}
              >
                <CloseIcon />
              </IconButton>
            </WithTooltip>
          </>
        }
      />

      <WorkRailMain projectName={projectName} sessionName={sessionName}>
        {isLoading ? (
          <EmptyState>
            <EmptyStateTitle>Loading conversations...</EmptyStateTitle>
          </EmptyState>
        ) : (
          <div className="stagger-in mx-auto flex w-full max-w-[960px] flex-col gap-md p-lg">
            {/* Session info strip */}
            {session && (
              <div className="flex flex-wrap items-center justify-between gap-md">
                <div className="convo-list-meta flex flex-wrap items-center gap-sm">
                  <CopyableId
                    label="Branch"
                    value={session.branchName}
                    truncateAt={999}
                  />
                  <div className="inline-block h-[12px] w-px shrink-0 bg-border-subtle" />
                  <CopyableId
                    label="Worktree"
                    value={session.worktreePath}
                    truncateAt={999}
                  />
                  <SessionTicketIndicator
                    projectName={projectName}
                    sessionName={sessionName}
                  />
                  <div className="inline-block h-[12px] w-px shrink-0 bg-border-subtle" />
                  <div className="flex items-center gap-[4px] text-[0.72rem]">
                    <span className="font-mono text-[0.7rem] tracking-[0.04em] text-text-tertiary uppercase">
                      Created
                    </span>
                    <span className="font-mono text-text-primary">
                      {formatDate(session.createdAt)}
                    </span>
                  </div>
                  <div className="inline-block h-[12px] w-px shrink-0 bg-border-subtle" />
                  <div className="flex items-center gap-[4px] text-[0.72rem]">
                    <span className="font-mono text-[0.7rem] tracking-[0.04em] text-text-tertiary uppercase">
                      Conversations
                    </span>
                    <span className="font-mono text-text-primary">
                      {activeCount}
                    </span>
                  </div>
                  <div className="inline-block h-[12px] w-px shrink-0 bg-border-subtle" />
                  <div className="flex items-center gap-[4px] text-[0.72rem]">
                    <span className="font-mono text-[0.7rem] tracking-[0.04em] text-text-tertiary uppercase">
                      Total Prompts
                    </span>
                    <span className="font-mono text-text-primary">
                      {deriveSessionPromptCount(session)}
                    </span>
                  </div>
                  <div className="inline-block h-[12px] w-px shrink-0 bg-border-subtle" />
                  <WithTooltip
                    label={
                      contextCopied ? "Copied ✓" : "Copy context to clipboard"
                    }
                  >
                    <button
                      className="relative cursor-pointer rounded-sm border border-solid border-border-subtle bg-transparent px-[6px] py-px font-mono text-[0.7rem] font-semibold tracking-[0.06em] text-text-tertiary uppercase transition-colors duration-150 hover:border-border-default hover:text-text-secondary"
                      onClick={handleCopyContext}
                    >
                      {contextCopied ? "\u2713" : "\u2398"} Context
                    </button>
                  </WithTooltip>
                  <div className="inline-block h-[12px] w-px shrink-0 bg-border-subtle" />
                  <ScopedAgentCapabilitiesConfig
                    level="session"
                    projectName={projectName}
                    sessionName={sessionName}
                    className="cap-trigger relative cursor-pointer rounded-sm border border-solid border-border-subtle bg-transparent px-[6px] py-px font-mono text-[0.7rem] font-semibold tracking-[0.06em] text-text-tertiary uppercase transition-colors duration-150 hover:border-border-default hover:text-text-secondary"
                  />
                </div>
                <div
                  style={{
                    display: "flex",
                    gap: "var(--space-sm)",
                    alignItems: "center",
                  }}
                >
                  {archivedCount > 0 && (
                    <button
                      data-active={showArchived}
                      onClick={toggleArchived}
                      type="button"
                      className={cn(
                        "inline-flex items-center gap-sm rounded-md border border-solid px-[12px] py-[6px] font-mono text-[0.72rem] font-medium transition-all duration-150 ease-[ease] max-768:min-h-[44px] max-768:px-[16px]",
                        "data-[active=false]:border-border-default data-[active=false]:bg-transparent data-[active=false]:text-text-secondary data-[active=false]:hover:border-border-strong data-[active=false]:hover:bg-bg-hover data-[active=false]:hover:text-text-primary",
                        "data-[active=true]:border-cyan-glow-strong data-[active=true]:bg-cyan-glow data-[active=true]:text-cyan data-[active=true]:hover:bg-cyan-glow-strong",
                      )}
                    >
                      Archived ({archivedCount})
                    </button>
                  )}
                  <Button
                    variant="primary"
                    size="sm"
                    touch
                    onClick={handleNewConversation}
                    disabled={createConvoMutation.isPending || isFinished}
                  >
                    <span className="text-[1em]">+</span>
                    {createConvoMutation.isPending
                      ? "Creating..."
                      : "New Conversation"}
                  </Button>
                </div>
              </div>
            )}

            {session && (
              <GraphWorkflowCard
                projectName={projectName}
                sessionName={sessionName}
                execution={graphWorkflowExecutionQuery.data ?? null}
                isFinished={isFinished}
              />
            )}

            {/* Finished banner */}
            {isFinished && (
              <div className="finished-banner">
                This session has been merged into {targetBranch} and is
                read-only.
              </div>
            )}

            {/* Conversation cards */}
            {filteredConversations.length > 0 ? (
              <div
                className="grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-md"
                data-testid="conversation-list"
              >
                {filteredConversations.map((convo) => (
                  <Link
                    key={convo.id}
                    href={conversationsPageHref({ conversationId: convo.id })}
                    data-testid="conversation-row"
                    data-recent={convo.id === mostRecentId}
                    data-archived={convo.archived}
                    className="flex flex-col gap-sm rounded-md border border-solid border-border-subtle bg-bg-surface p-md text-inherit no-underline [contain-intrinsic-size:0_96px] [content-visibility:auto] [transition:border-color_0.15s_ease,background_0.15s_ease] hover:bg-bg-elevated data-[archived=true]:border-dashed data-[archived=true]:opacity-55 data-[archived=true]:hover:opacity-75 data-[recent=false]:hover:border-border-strong data-[recent=true]:border-[var(--cc-cyan-a35)] data-[archived=true]:data-[recent=true]:border-border-subtle"
                  >
                    <div className="flex items-center gap-xs">
                      <ConversationStatusDot status={convo.status} />
                      {convo.archived && (
                        <span className="rounded-sm border border-dashed border-border-default bg-[color-mix(in_srgb,var(--text-secondary)_10%,transparent)] px-[6px] py-[1px] font-mono text-[0.7rem] tracking-[0.04em] text-text-tertiary uppercase">
                          archived
                        </span>
                      )}
                      {convo.source === "imported" && (
                        <span className="rounded-sm bg-[var(--cc-cyan-a10)] px-[6px] py-[1px] font-mono text-[0.7rem] tracking-[0.04em] text-cyan uppercase">
                          imported
                        </span>
                      )}
                    </div>
                    <div className="flex-1">
                      {editingId === convo.id ? (
                        <input
                          ref={editInputRef}
                          className="w-full rounded-[4px] border-0 bg-transparent px-[6px] py-[2px] [font-family:inherit] text-[0.78rem] leading-[1.5] text-text-primary outline-none"
                          value={editValue}
                          onChange={(e) => setEditValue(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") {
                              e.preventDefault();
                              void handleRenameSubmit(convo.id);
                            } else if (e.key === "Escape") {
                              e.stopPropagation();
                              setEditingId(null);
                            }
                          }}
                          onBlur={() => void handleRenameSubmit(convo.id)}
                          onClick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                          }}
                          maxLength={200}
                        />
                      ) : (
                        <div className="line-clamp-3 text-[0.78rem] leading-[1.5] text-text-secondary">
                          {convo.name ?? convo.summary ?? "New conversation"}
                        </div>
                      )}
                    </div>
                    <div className="flex items-center justify-between border-x-0 border-t border-b-0 border-solid border-border-subtle pt-xs">
                      <span className="font-mono text-[0.72rem] text-text-tertiary">
                        {convo.promptCount} prompt
                        {convo.promptCount !== 1 ? "s" : ""}
                      </span>
                      <span className="font-mono text-[0.72rem] text-text-tertiary">
                        {formatRelativeTime(convo.lastActivityAt)}
                      </span>
                      <span
                        className="font-mono text-[0.72rem] text-text-tertiary opacity-70 hover:cursor-pointer hover:text-cyan hover:opacity-100"
                        title={convo.id}
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          void navigator.clipboard.writeText(convo.id);
                        }}
                      >
                        {convo.id.slice(0, 8)}
                      </span>
                      <WithTooltip label="Rename">
                        <IconButton
                          variant="square"
                          layoutClassName="ml-auto"
                          aria-label="Rename"
                          onClick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            handleRenameStart(convo);
                          }}
                        >
                          &#9998;
                        </IconButton>
                      </WithTooltip>
                      <WithTooltip
                        label={convo.archived ? "Unarchive" : "Archive"}
                      >
                        <IconButton
                          variant="square"
                          layoutClassName="ml-auto"
                          aria-label={convo.archived ? "Unarchive" : "Archive"}
                          onClick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            handleArchive(convo.id, !convo.archived);
                          }}
                        >
                          {convo.archived ? "\u21A9" : "\u2913"}
                        </IconButton>
                      </WithTooltip>
                    </div>
                  </Link>
                ))}
              </div>
            ) : (
              <EmptyState>
                <EmptyStateTitle>No conversations yet</EmptyStateTitle>
                <EmptyStateDesc>
                  Create a new conversation to start working with Claude.
                </EmptyStateDesc>
              </EmptyState>
            )}
          </div>
        )}
      </WorkRailMain>

      <ConfirmDialog
        open={showDeleteConfirm}
        title="Delete session?"
        message={`This will remove the worktree and session state for "${sessionName}". The git branch and transcripts will be preserved. This action cannot be undone.`}
        confirmLabel="Delete"
        danger
        onConfirm={handleDelete}
        onCancel={() => setShowDeleteConfirm(false)}
      />
    </div>
  );
}
