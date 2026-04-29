"use client";

import { useState, useCallback, useMemo, useRef, useEffect } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { ConversationState } from "@/types";
import {
  deriveSessionStatus,
  deriveSessionPromptCount,
} from "@/lib/session-derived";
import { buildSessionContext } from "@/lib/copy-context";
import {
  useSessionQuery,
  useConversationsQuery,
  useSessionDiffQuery,
  useCommitsQuery,
} from "@/lib/queries";
import {
  useDeleteSessionMutation,
  useCreateConversationMutation,
  useArchiveConversationMutation,
  useRenameConversationMutation,
} from "@/lib/mutations";
import {
  useShowArchivedConversations,
  useToggleArchivedConversations,
} from "@/stores/conversations.store";
import Topbar from "@/components/Topbar";
import ConfirmDialog from "@/components/ConfirmDialog";
import CopyableId from "@/components/CopyableId";
import SessionMcpChip from "@/components/mcp/SessionMcpChip";
import SessionMcpModal from "@/components/mcp/SessionMcpModal";
import GraphWorkflowCard from "./GraphWorkflowCard";
import SessionGitPanel from "./SessionGitPanel";
import CommitDialog from "./CommitDialog";
import SmartMergeDialog from "./SmartMergeDialog";

interface Props {
  projectName: string;
  sessionName: string;
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

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function ConversationStatusDot({ status }: { status: string }) {
  return (
    <span className={`session-status ${status}`}>
      <span className="dot" />
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
  const diffQuery = useSessionDiffQuery(projectName, sessionName);
  const commitsQuery = useCommitsQuery(projectName, sessionName);

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
  const [showCommitDialog, setShowCommitDialog] = useState(false);
  const [showMergeDialog, setShowMergeDialog] = useState(false);
  const [contextCopied, setContextCopied] = useState(false);
  const [sessionMcpModalOpen, setSessionMcpModalOpen] = useState(false);

  // --- Derived data ---
  const session = sessionQuery.data;
  const conversations = useMemo(
    () => conversationsQuery.data ?? [],
    [conversationsQuery.data],
  );
  const diff = diffQuery.data ?? {
    files: [],
    totalAdditions: 0,
    totalDeletions: 0,
  };
  const commits = commitsQuery.data ?? [];
  const decodedProjectName = decodeURIComponent(projectName);
  const isFinished = session?.finished ?? false;
  const targetBranch = session?.targetBranch ?? "main";
  const sessionStatus = session ? deriveSessionStatus(session) : "idle";
  const isBusy =
    sessionStatus === "running" || sessionStatus === "waiting_for_input";

  const commitDisabled = isFinished || diff.files.length === 0;
  const mergeDisabled = isFinished;

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
      const text = buildSessionContext({ projectName, sessionName, session });
      void navigator.clipboard.writeText(text).then(() => {
        setContextCopied(true);
        setTimeout(() => setContextCopied(false), 1500);
      });
    },
    [session, projectName, sessionName],
  );

  const handleNewConversation = useCallback(() => {
    if (createConvoMutation.isPending || isFinished) return;
    createConvoMutation.mutate(undefined, {
      onSuccess: (convo) => {
        router.push(
          `/projects/${encodeURIComponent(projectName)}/${encodeURIComponent(sessionName)}/${convo.id}`,
        );
      },
    });
  }, [createConvoMutation, isFinished, projectName, sessionName, router]);

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
            label: decodedProjectName,
            href: `/projects/${encodeURIComponent(projectName)}`,
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
            {!isFinished && (
              <>
                <button
                  className="btn btn-sm"
                  data-tooltip="Commit changes"
                  disabled={commitDisabled}
                  onClick={() => setShowCommitDialog(true)}
                >
                  Commit
                </button>
                <button
                  className="btn btn-sm btn-primary"
                  data-tooltip={`Merge into ${targetBranch}`}
                  disabled={mergeDisabled}
                  onClick={() => setShowMergeDialog(true)}
                >
                  Merge
                </button>
                <div className="topbar-sep" />
              </>
            )}
            <button
              className="btn-icon-only danger"
              data-tooltip="Delete session"
              onClick={() => setShowDeleteConfirm(true)}
            >
              &#10005;
            </button>
          </>
        }
      />

      <main className="main">
        {isLoading ? (
          <div className="empty-state">
            <div className="empty-state-title">Loading conversations...</div>
          </div>
        ) : (
          <div className="convo-list-layout stagger-in">
            {/* Session info strip */}
            {session && (
              <div className="convo-list-header">
                <div className="convo-list-meta">
                  <CopyableId
                    label="Branch"
                    value={session.branchName}
                    truncateAt={999}
                  />
                  <div className="si-sep" />
                  <CopyableId
                    label="Worktree"
                    value={session.worktreePath}
                    truncateAt={999}
                  />
                  <div className="si-sep" />
                  <div className="si-item">
                    <span className="si-label">Created</span>
                    <span className="si-val">
                      {formatDate(session.createdAt)}
                    </span>
                  </div>
                  <div className="si-sep" />
                  <div className="si-item">
                    <span className="si-label">Conversations</span>
                    <span className="si-val">{activeCount}</span>
                  </div>
                  <div className="si-sep" />
                  <div className="si-item">
                    <span className="si-label">Total Prompts</span>
                    <span className="si-val">
                      {deriveSessionPromptCount(session)}
                    </span>
                  </div>
                  <div className="si-sep" />
                  <button
                    className="si-copy-context-btn"
                    onClick={handleCopyContext}
                    data-tooltip={
                      contextCopied ? "Copied!" : "Copy context to clipboard"
                    }
                  >
                    {contextCopied ? "\u2713" : "\u2398"} Context
                  </button>
                  <div className="si-sep" />
                  <SessionMcpChip
                    projectName={projectName}
                    sessionName={sessionName}
                    onClick={() => setSessionMcpModalOpen(true)}
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
                      className={`btn btn-sm btn-toggle${showArchived ? " active" : ""}`}
                      onClick={toggleArchived}
                      type="button"
                    >
                      Archived ({archivedCount})
                    </button>
                  )}
                  <button
                    className="btn btn-primary btn-sm"
                    onClick={handleNewConversation}
                    disabled={createConvoMutation.isPending || isFinished}
                  >
                    <span className="btn-icon">+</span>
                    {createConvoMutation.isPending
                      ? "Creating..."
                      : "New Conversation"}
                  </button>
                </div>
              </div>
            )}

            {session && (
              <GraphWorkflowCard
                projectName={projectName}
                sessionName={sessionName}
                execution={session.graphWorkflowExecution ?? null}
                isFinished={isFinished}
              />
            )}

            {session && (
              <a
                className="gw-card-link"
                href={`/projects/${encodeURIComponent(projectName)}/${encodeURIComponent(sessionName)}/collaboration`}
              >
                Collaboration mode →
              </a>
            )}

            {/* Finished banner */}
            {isFinished && (
              <div className="finished-banner">
                This session has been merged into {targetBranch} and is
                read-only.
              </div>
            )}

            {/* Git Panel */}
            <SessionGitPanel
              diff={diff}
              commits={commits}
              projectName={projectName}
              sessionName={sessionName}
              isFinished={isFinished}
              commitDisabled={commitDisabled || isBusy}
              mergeDisabled={mergeDisabled || isBusy}
              onCommit={() => setShowCommitDialog(true)}
              onMerge={() => setShowMergeDialog(true)}
            />

            {/* Conversation cards */}
            {filteredConversations.length > 0 ? (
              <div className="convo-card-grid">
                {filteredConversations.map((convo) => (
                  <Link
                    key={convo.id}
                    href={`/projects/${encodeURIComponent(projectName)}/${encodeURIComponent(sessionName)}/${convo.id}`}
                    className={`convo-card${convo.id === mostRecentId ? " most-recent" : ""}${convo.archived ? " archived" : ""}`}
                  >
                    <div className="convo-card-header">
                      <ConversationStatusDot status={convo.status} />
                      {convo.archived && (
                        <span className="convo-badge archived-badge">
                          archived
                        </span>
                      )}
                      {convo.source === "imported" && (
                        <span className="convo-badge imported">imported</span>
                      )}
                    </div>
                    <div className="convo-card-body">
                      {editingId === convo.id ? (
                        <input
                          ref={editInputRef}
                          className="convo-rename-input"
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
                        <div className="convo-card-summary">
                          {convo.name ?? convo.summary ?? "New conversation"}
                        </div>
                      )}
                    </div>
                    <div className="convo-card-footer">
                      <span className="convo-card-meta">
                        {convo.promptCount} prompt
                        {convo.promptCount !== 1 ? "s" : ""}
                      </span>
                      <span className="convo-card-meta">
                        {formatRelativeTime(convo.lastActivityAt)}
                      </span>
                      <span
                        className="convo-card-meta convo-card-id"
                        title={convo.id}
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          void navigator.clipboard.writeText(convo.id);
                        }}
                      >
                        {convo.id.slice(0, 8)}
                      </span>
                      <button
                        className="btn-icon-only convo-card-archive-btn"
                        data-tooltip="Rename"
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          handleRenameStart(convo);
                        }}
                      >
                        &#9998;
                      </button>
                      <button
                        className="btn-icon-only convo-card-archive-btn"
                        data-tooltip={convo.archived ? "Unarchive" : "Archive"}
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          handleArchive(convo.id, !convo.archived);
                        }}
                      >
                        {convo.archived ? "\u21A9" : "\u2913"}
                      </button>
                    </div>
                  </Link>
                ))}
              </div>
            ) : (
              <div className="empty-state">
                <div className="empty-state-title">No conversations yet</div>
                <div className="empty-state-desc">
                  Create a new conversation to start working with Claude.
                </div>
              </div>
            )}
          </div>
        )}
      </main>

      <ConfirmDialog
        open={showDeleteConfirm}
        title="Delete Session"
        message={`This will remove the worktree and session state for "${sessionName}". The git branch and transcripts will be preserved. This action cannot be undone.`}
        confirmLabel="Delete"
        danger
        onConfirm={handleDelete}
        onCancel={() => setShowDeleteConfirm(false)}
      />

      <CommitDialog
        open={showCommitDialog}
        onClose={() => setShowCommitDialog(false)}
        onSuccess={() => setShowCommitDialog(false)}
        projectName={projectName}
        sessionName={sessionName}
      />

      {session && (
        <SmartMergeDialog
          open={showMergeDialog}
          onClose={() => setShowMergeDialog(false)}
          projectName={projectName}
          sessionName={sessionName}
          branchName={session.branchName}
          targetBranch={targetBranch}
          commitCount={commits.length}
          hasUncommittedChanges={diff.files.length > 0}
        />
      )}

      <SessionMcpModal
        projectName={projectName}
        sessionName={sessionName}
        open={sessionMcpModalOpen}
        onClose={() => setSessionMcpModalOpen(false)}
      />
    </div>
  );
}
