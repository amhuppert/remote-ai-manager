"use client";

import { useState, useCallback, useMemo } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { SessionState, ConversationState } from "@/types";
import { deriveSessionStatus, deriveSessionPromptCount } from "@/lib/session-derived";
import Topbar from "@/components/Topbar";
import ConfirmDialog from "@/components/ConfirmDialog";
import { tracedFetch } from "@/lib/traced-fetch";

interface Props {
  projectName: string;
  session: SessionState;
  conversations: ConversationState[];
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
  const cls =
    status === "running"
      ? "running"
      : status === "ready"
        ? "ready"
        : "idle";
  return (
    <span className={`session-status ${cls}`}>
      <span className="dot" />
      {status}
    </span>
  );
}

export default function ConversationList({
  projectName,
  session,
  conversations,
}: Props): React.JSX.Element {
  const router = useRouter();
  const [creating, setCreating] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [showArchived, setShowArchived] = useState(false);

  const sessionStatus = deriveSessionStatus(session);
  const decodedProjectName = decodeURIComponent(projectName);
  const isFinished = session.finished;

  const archivedCount = useMemo(
    () => conversations.filter((c) => c.archived).length,
    [conversations],
  );

  const filteredConversations = useMemo(() => {
    if (showArchived) return conversations;
    return conversations.filter((c) => !c.archived);
  }, [conversations, showArchived]);

  const activeCount = conversations.length - archivedCount;

  const handleNewConversation = useCallback(async () => {
    if (creating || isFinished) return;
    setCreating(true);
    try {
      const res = await tracedFetch(
        `/api/projects/${encodeURIComponent(projectName)}/sessions/${encodeURIComponent(session.sessionName)}/conversations`,
        "create-conversation",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
        },
      );
      if (res.ok) {
        const convo = (await res.json()) as ConversationState;
        router.push(
          `/projects/${encodeURIComponent(projectName)}/${encodeURIComponent(session.sessionName)}/${convo.id}`,
        );
      }
    } catch {
      // Silently fail
    } finally {
      setCreating(false);
    }
  }, [creating, isFinished, projectName, session.sessionName, router]);

  const handleDelete = useCallback(async () => {
    try {
      const res = await tracedFetch(
        `/api/projects/${encodeURIComponent(projectName)}/sessions?sessionName=${encodeURIComponent(session.sessionName)}`,
        "delete-session",
        { method: "DELETE" },
      );
      if (res.ok) {
        router.push(`/projects/${encodeURIComponent(projectName)}`);
      }
    } catch {
      // Silently fail
    }
  }, [projectName, session.sessionName, router]);

  const handleArchive = useCallback(
    async (conversationId: string, archived: boolean) => {
      try {
        const res = await tracedFetch(
          `/api/projects/${encodeURIComponent(projectName)}/sessions/${encodeURIComponent(session.sessionName)}/conversations/${encodeURIComponent(conversationId)}/archive`,
          "archive-conversation",
          {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ archived }),
          },
        );
        if (res.ok) {
          router.refresh();
        }
      } catch {
        // Silently fail
      }
    },
    [projectName, session.sessionName, router],
  );

  const displayStatus = isFinished ? "merged" : sessionStatus;
  const statusDotClass =
    displayStatus === "running"
      ? "cyan"
      : displayStatus === "merged"
        ? "green"
        : "";

  // Most recently active conversation is first (already sorted by API)
  const mostRecentId = filteredConversations[0]?.id;

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
            label: session.sessionName,
            href: `/projects/${encodeURIComponent(projectName)}/${encodeURIComponent(session.sessionName)}`,
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
            <button
              className="btn-icon-only"
              data-tooltip="Refresh"
              onClick={() => router.refresh()}
            >
              &#8635;
            </button>
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
        <div className="convo-list-layout stagger-in">
          {/* Session info strip */}
          <div className="convo-list-header">
            <div className="convo-list-meta">
              <div className="si-item">
                <span className="si-label">Branch</span>
                <span className="si-val">{session.branchName}</span>
              </div>
              <div className="si-sep" />
              <div className="si-item">
                <span className="si-label">Created</span>
                <span className="si-val">{formatDate(session.createdAt)}</span>
              </div>
              <div className="si-sep" />
              <div className="si-item">
                <span className="si-label">Conversations</span>
                <span className="si-val">{activeCount}</span>
              </div>
              <div className="si-sep" />
              <div className="si-item">
                <span className="si-label">Total Prompts</span>
                <span className="si-val">{deriveSessionPromptCount(session)}</span>
              </div>
            </div>
            <div style={{ display: "flex", gap: "var(--space-sm)", alignItems: "center" }}>
              {archivedCount > 0 && (
                <button
                  className={`archive-toggle${showArchived ? " active" : ""}`}
                  onClick={() => setShowArchived((v) => !v)}
                  type="button"
                >
                  Archived ({archivedCount})
                </button>
              )}
              <button
                className="btn btn-primary btn-sm"
                onClick={() => void handleNewConversation()}
                disabled={creating || isFinished}
              >
                <span className="btn-icon">+</span>
                {creating ? "Creating..." : "New Conversation"}
              </button>
            </div>
          </div>

          {/* Finished banner */}
          {isFinished && (
            <div className="finished-banner">
              This session has been merged into main and is read-only.
            </div>
          )}

          {/* Conversation cards */}
          {filteredConversations.length > 0 ? (
            <div className="convo-card-grid">
              {filteredConversations.map((convo) => (
                <Link
                  key={convo.id}
                  href={`/projects/${encodeURIComponent(projectName)}/${encodeURIComponent(session.sessionName)}/${convo.id}`}
                  className={`convo-card${convo.id === mostRecentId ? " most-recent" : ""}${convo.archived ? " archived" : ""}`}
                >
                  <div className="convo-card-header">
                    <ConversationStatusDot status={convo.status} />
                    {convo.archived && (
                      <span className="convo-badge archived-badge">archived</span>
                    )}
                    {convo.source === "imported" && (
                      <span className="convo-badge imported">imported</span>
                    )}
                  </div>
                  <div className="convo-card-body">
                    <div className="convo-card-summary">
                      {convo.summary ?? "New conversation"}
                    </div>
                  </div>
                  <div className="convo-card-footer">
                    <span className="convo-card-meta">
                      {convo.promptCount} prompt{convo.promptCount !== 1 ? "s" : ""}
                    </span>
                    <span className="convo-card-meta">
                      {formatRelativeTime(convo.lastActivityAt)}
                    </span>
                    <button
                      className="btn-icon-only convo-card-archive-btn"
                      data-tooltip={convo.archived ? "Unarchive" : "Archive"}
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        void handleArchive(convo.id, !convo.archived);
                      }}
                    >
                      {convo.archived ? "\u21A9" : "\u2912"}
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
      </main>

      <ConfirmDialog
        open={showDeleteConfirm}
        title="Delete Session"
        message={`This will remove the worktree and session state for "${session.sessionName}". The git branch and transcripts will be preserved. This action cannot be undone.`}
        confirmLabel="Delete"
        danger
        onConfirm={() => {
          setShowDeleteConfirm(false);
          void handleDelete();
        }}
        onCancel={() => setShowDeleteConfirm(false)}
      />
    </div>
  );
}
