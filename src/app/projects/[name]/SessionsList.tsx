"use client";

import { useMemo, useCallback, useState } from "react";
import Link from "next/link";
import type { SessionState } from "@/types";
import {
  deriveSessionStatus,
  deriveSessionPromptCount,
} from "@/lib/session-derived";
import { useSessionsQuery, usePresetsQuery } from "@/lib/queries";
import {
  useDeleteSessionMutation,
  useArchiveSessionMutation,
  useInstallPresetMutation,
} from "@/lib/mutations";
import {
  useShowCreateModal,
  useDeleteTarget,
  useShowArchivedSessions,
  useOpenCreateModal,
  useCloseCreateModal,
  useConfirmDeleteSession,
  useCancelDeleteSession,
  useToggleArchivedSessions,
} from "@/stores/sessions.store";
import CreateSessionModal from "./CreateSessionModal";
import OptimisticDialog from "./OptimisticDialog";
import PresetInstallDialog from "./PresetInstallDialog";
import ProjectActionsBar from "./ProjectActionsBar";
import RoadmapItemsPanel from "./RoadmapItemsPanel";
import ConfirmDialog from "@/components/ConfirmDialog";
import TddToggle from "@/components/TddToggle";
import Topbar from "@/components/Topbar";
import { useTddToggleMutation } from "@/lib/mutations";

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

function SessionTddToggle({
  projectName,
  session,
}: {
  projectName: string;
  session: SessionState;
}) {
  const tddMutation = useTddToggleMutation(projectName, session.sessionName);

  return (
    <TddToggle
      enabled={session.tddEnabled}
      onChange={(val) => tddMutation.mutate(val)}
      disabled={tddMutation.isPending}
      compact
    />
  );
}

function ArchiveButton({
  projectName,
  session,
}: {
  projectName: string;
  session: SessionState;
}) {
  const archiveMutation = useArchiveSessionMutation(
    projectName,
    session.sessionName,
  );

  return (
    <button
      className="btn btn-sm"
      onClick={(e) => {
        e.stopPropagation();
        archiveMutation.mutate(!session.archived);
      }}
      disabled={archiveMutation.isPending}
    >
      {session.archived ? "Unarchive" : "Archive"}
    </button>
  );
}

interface SessionsListProps {
  projectName: string;
}

export default function SessionsList({
  projectName,
}: SessionsListProps): React.JSX.Element {
  // --- TanStack Query ---
  const sessionsQuery = useSessionsQuery(projectName);

  // --- Zustand ---
  const modalOpen = useShowCreateModal();
  const deleteTarget = useDeleteTarget();
  const showArchived = useShowArchivedSessions();
  const openCreateModal = useOpenCreateModal();
  const closeCreateModal = useCloseCreateModal();
  const confirmDelete = useConfirmDeleteSession();
  const cancelDelete = useCancelDeleteSession();
  const toggleArchived = useToggleArchivedSessions();

  // --- Mutations ---
  const deleteMutation = useDeleteSessionMutation(projectName);
  const installPresetMutation = useInstallPresetMutation(projectName);

  // --- Optimistic dialog ---
  const [optimisticDialogOpen, setOptimisticDialogOpen] = useState(false);

  // --- Preset install dialog ---
  const [presetDialogOpen, setPresetDialogOpen] = useState(false);
  const presetsQuery = usePresetsQuery(projectName);
  const installedPresets = useMemo(
    () => presetsQuery.data?.filter((p) => p.installed).map((p) => p.id) ?? [],
    [presetsQuery.data],
  );

  // --- Derived data ---
  const sessions = useMemo(
    () => sessionsQuery.data ?? [],
    [sessionsQuery.data],
  );
  const archivedCount = useMemo(
    () => sessions.filter((s) => s.archived).length,
    [sessions],
  );

  const filteredSessions = useMemo(() => {
    if (showArchived) return sessions;
    return sessions.filter((s) => !s.archived);
  }, [sessions, showArchived]);

  const handleDeleteConfirm = useCallback(() => {
    if (deleteTarget) {
      deleteMutation.mutate(deleteTarget.sessionName);
    }
    cancelDelete();
  }, [deleteTarget, deleteMutation, cancelDelete]);

  const runningCount = sessions.filter(
    (s) => deriveSessionStatus(s) === "running",
  ).length;

  const isLoading = sessionsQuery.isPending;

  return (
    <div className="app" data-page="sessions">
      <Topbar
        page="sessions"
        breadcrumbs={[
          { label: "projects", href: "/projects" },
          {
            label: projectName,
            href: `/projects/${encodeURIComponent(projectName)}`,
          },
        ]}
        globalStatus={
          runningCount > 0 ? (
            <div className="status-indicator">
              <div className="status-dot warning" />
              {runningCount} session{runningCount !== 1 ? "s" : ""} running
            </div>
          ) : undefined
        }
      />
      <main className="main">
        {isLoading ? (
          <div className="empty-state">
            <div className="empty-state-title">Loading sessions...</div>
          </div>
        ) : (
          <>
            <div className="stagger-in">
              <RoadmapItemsPanel projectName={projectName} />

              <ProjectActionsBar
                archivedCount={archivedCount}
                showArchived={showArchived}
                onToggleArchived={toggleArchived}
                onInstallPreset={() => setPresetDialogOpen(true)}
                onQuickTask={() => setOptimisticDialogOpen(true)}
                onNewSession={openCreateModal}
              />

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
                              <span className="session-badge merged">
                                merged
                              </span>
                            )}
                            {session.creationMode === "focus" && (
                              <span className="session-badge focus">focus</span>
                            )}
                            {session.creationMode === "optimistic" && (
                              <span className="session-badge optimistic">
                                optimistic
                              </span>
                            )}
                            {session.creationMode === "fast" && (
                              <span className="session-badge fast">fast</span>
                            )}
                          </Link>
                        </td>
                        <td>
                          <span className="session-branch">
                            {session.branchName}
                          </span>
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
                          <div
                            style={{
                              display: "flex",
                              gap: "var(--space-xs)",
                              alignItems: "center",
                            }}
                          >
                            <SessionTddToggle
                              projectName={projectName}
                              session={session}
                            />
                            <ArchiveButton
                              projectName={projectName}
                              session={session}
                            />
                            <button
                              className="btn btn-danger btn-sm"
                              onClick={(e) => {
                                e.stopPropagation();
                                confirmDelete({
                                  sessionName: session.sessionName,
                                  projectName,
                                });
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
                    Create a session to start working with Claude in this
                    project.
                  </div>
                </div>
              )}
            </div>

            <OptimisticDialog
              projectName={projectName}
              open={optimisticDialogOpen}
              onClose={() => setOptimisticDialogOpen(false)}
            />

            <CreateSessionModal
              projectName={projectName}
              open={modalOpen}
              onClose={closeCreateModal}
            />

            <PresetInstallDialog
              open={presetDialogOpen}
              projectName={projectName}
              installedPresets={installedPresets}
              isInstalling={installPresetMutation.isPending}
              onInstall={(presetId, subdir) => {
                installPresetMutation.mutate(
                  { presetId, subdir },
                  { onSuccess: () => setPresetDialogOpen(false) },
                );
              }}
              onClose={() => {
                if (!installPresetMutation.isPending) {
                  setPresetDialogOpen(false);
                }
              }}
            />

            <ConfirmDialog
              open={deleteTarget !== null}
              title="Delete Session"
              message={`This will remove the worktree and session state for "${deleteTarget?.sessionName ?? ""}". The git branch and transcripts will be preserved. This action cannot be undone.`}
              confirmLabel="Delete"
              danger
              onConfirm={handleDeleteConfirm}
              onCancel={cancelDelete}
            />
          </>
        )}
      </main>
    </div>
  );
}
