"use client";

import { useState, useCallback, useMemo } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { SessionState } from "@/types";
import {
  deriveSessionStatus,
  deriveSessionPromptCount,
} from "@/lib/session-derived";
import CreateSessionModal from "./CreateSessionModal";
import ConfirmDialog from "@/components/ConfirmDialog";
import { tracedFetch } from "@/lib/traced-fetch";

interface SessionsListProps {
  projectName: string;
  initialSessions: SessionState[];
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

function StatusBadge({ session }: { session: SessionState }) {
  if (session.finished) {
    return (
      <span className="session-status merged">
        <span className="dot" />
        merged
      </span>
    );
  }
  const status = deriveSessionStatus(session);
  return (
    <span className={`session-status ${status}`}>
      <span className="dot" />
      {status}
    </span>
  );
}

export default function SessionsList({
  projectName,
  initialSessions,
}: SessionsListProps): React.JSX.Element {
  const router = useRouter();
  const [modalOpen, setModalOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const sessions = initialSessions;

  const archivedCount = useMemo(
    () => sessions.filter((s) => s.archived).length,
    [sessions],
  );

  const filteredSessions = useMemo(() => {
    if (showArchived) return sessions;
    return sessions.filter((s) => !s.archived);
  }, [sessions, showArchived]);

  const handleCreated = useCallback(() => {
    router.refresh();
  }, [router]);

  const handleDelete = useCallback(
    async (sessionName: string) => {
      try {
        const res = await tracedFetch(
          `/api/projects/${encodeURIComponent(projectName)}/sessions?sessionName=${encodeURIComponent(sessionName)}`,
          "delete-session",
          { method: "DELETE" },
        );
        if (res.ok) {
          router.refresh();
        }
      } catch {
        // Silently fail
      }
    },
    [projectName, router],
  );

  const handleArchive = useCallback(
    async (sessionName: string, archived: boolean) => {
      try {
        const res = await tracedFetch(
          `/api/projects/${encodeURIComponent(projectName)}/sessions/${encodeURIComponent(sessionName)}/archive`,
          "archive-session",
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
    [projectName, router],
  );

  return (
    <>
      <div className="stagger-in">
        <div className="session-actions-bar">
          <div
            style={{
              display: "flex",
              gap: "var(--space-sm)",
              alignItems: "center",
            }}
          >
            <button
              className="btn btn-sm"
              style={{ color: "var(--text-secondary)" }}
              onClick={() => router.refresh()}
            >
              <span className="btn-icon">&#8635;</span> Refresh
            </button>
            {archivedCount > 0 && (
              <button
                className={`archive-toggle${showArchived ? " active" : ""}`}
                onClick={() => setShowArchived((v) => !v)}
                type="button"
              >
                Archived ({archivedCount})
              </button>
            )}
          </div>
          <button
            className="btn btn-primary btn-sm"
            onClick={() => setModalOpen(true)}
          >
            <span className="btn-icon">+</span> New Session
          </button>
        </div>

        {filteredSessions.length > 0 ? (
          <table className="sessions-table">
            <thead>
              <tr>
                <th>Session</th>
                <th>Branch</th>
                <th>Status</th>
                <th>Last Activity</th>
                <th>Prompts</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {filteredSessions.map((session) => (
                <tr
                  key={session.sessionName}
                  className={session.archived ? "archived" : ""}
                >
                  <td>
                    <Link
                      href={`/projects/${encodeURIComponent(projectName)}/${encodeURIComponent(session.sessionName)}`}
                      className="session-name-cell"
                    >
                      <span className="session-name">
                        {session.sessionName}
                      </span>
                      {session.finished && (
                        <span className="session-badge merged">merged</span>
                      )}
                    </Link>
                  </td>
                  <td>
                    <span className="session-branch">{session.branchName}</span>
                  </td>
                  <td>
                    <StatusBadge session={session} />
                  </td>
                  <td>
                    <span className="session-time">
                      {formatRelativeTime(session.lastActivityAt)}
                    </span>
                  </td>
                  <td>
                    <span className="session-time">
                      {deriveSessionPromptCount(session)}
                    </span>
                  </td>
                  <td>
                    <div style={{ display: "flex", gap: "var(--space-xs)" }}>
                      <button
                        className="btn btn-sm"
                        onClick={(e) => {
                          e.stopPropagation();
                          void handleArchive(
                            session.sessionName,
                            !session.archived,
                          );
                        }}
                      >
                        {session.archived ? "Unarchive" : "Archive"}
                      </button>
                      <button
                        className="btn btn-danger btn-sm"
                        onClick={(e) => {
                          e.stopPropagation();
                          setDeleteTarget(session.sessionName);
                        }}
                      >
                        Delete
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="empty-state">
            <div className="empty-state-icon">&#128640;</div>
            <div className="empty-state-title">No sessions yet</div>
            <div className="empty-state-desc">
              Create a session to start working with Claude in this project.
            </div>
          </div>
        )}
      </div>

      <CreateSessionModal
        projectName={projectName}
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        onCreated={handleCreated}
      />

      <ConfirmDialog
        open={deleteTarget !== null}
        title="Delete Session"
        message={`This will remove the worktree and session state for "${deleteTarget ?? ""}". The git branch and transcripts will be preserved. This action cannot be undone.`}
        confirmLabel="Delete"
        danger
        onConfirm={() => {
          if (deleteTarget) {
            void handleDelete(deleteTarget);
          }
          setDeleteTarget(null);
        }}
        onCancel={() => setDeleteTarget(null)}
      />
    </>
  );
}
