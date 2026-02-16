"use client";

import { useState, useCallback } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { SessionState } from "@/types";
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

function StatusBadge({ status }: { status: SessionState["status"] }) {
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
  const sessions = initialSessions;

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
        // Silently fail — could add error toast later
      }
    },
    [projectName, router],
  );

  return (
    <>
      <div className="stagger-in">
        <div className="session-actions-bar">
          <div style={{ display: "flex", gap: "var(--space-sm)" }}>
            <button
              className="btn btn-sm"
              style={{ color: "var(--text-tertiary)" }}
              onClick={() => router.refresh()}
            >
              <span className="btn-icon">&#8635;</span> Refresh
            </button>
          </div>
          <button
            className="btn btn-primary btn-sm"
            onClick={() => setModalOpen(true)}
          >
            <span className="btn-icon">+</span> New Session
          </button>
        </div>

        {sessions.length > 0 ? (
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
              {sessions.map((session) => (
                <tr key={session.sessionName}>
                  <td>
                    <Link
                      href={`/projects/${encodeURIComponent(projectName)}/${encodeURIComponent(session.sessionName)}`}
                      className="session-name-cell"
                    >
                      <span className="session-name">
                        {session.sessionName}
                      </span>
                    </Link>
                  </td>
                  <td>
                    <span className="session-branch">{session.branchName}</span>
                  </td>
                  <td>
                    <StatusBadge status={session.status} />
                  </td>
                  <td>
                    <span className="session-time">
                      {formatRelativeTime(session.lastActivityAt)}
                    </span>
                  </td>
                  <td>
                    <span className="session-time">{session.promptCount}</span>
                  </td>
                  <td>
                    <button
                      className="btn btn-danger btn-sm"
                      onClick={(e) => {
                        e.stopPropagation();
                        setDeleteTarget(session.sessionName);
                      }}
                    >
                      Delete
                    </button>
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
