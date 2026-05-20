"use client";

import { useMemo, useCallback, useState } from "react";
import { useSessionsQuery, usePresetsQuery } from "@/lib/queries";
import {
  useDeleteSessionMutation,
  useInstallPresetMutation,
} from "@/lib/mutations";
import {
  useShowCreateModal,
  useDeleteTarget,
  useShowArchivedSessions,
  useOpenCreateModal,
  useCloseCreateModal,
  useCancelDeleteSession,
  useToggleArchivedSessions,
} from "@/stores/sessions.store";
import CreateSessionModal from "./CreateSessionModal";
import OptimisticDialog from "./OptimisticDialog";
import PresetInstallDialog from "./PresetInstallDialog";
import ProjectActionsBar from "./ProjectActionsBar";
import SessionsTable from "./SessionsTable";
import ConfirmDialog from "@/components/ConfirmDialog";
import Topbar from "@/components/Topbar";

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
  const cancelDelete = useCancelDeleteSession();
  const toggleArchived = useToggleArchivedSessions();

  // --- Mutations ---
  const deleteMutation = useDeleteSessionMutation(projectName);
  const installPresetMutation = useInstallPresetMutation(projectName);

  // --- Local state ---
  const [optimisticDialogOpen, setOptimisticDialogOpen] = useState(false);
  const [presetDialogOpen, setPresetDialogOpen] = useState(false);
  const [nameFilter, setNameFilter] = useState("");

  // --- Presets ---
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
    (s) => s.derivedStatus === "running",
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
              <ProjectActionsBar
                projectName={projectName}
                archivedCount={archivedCount}
                showArchived={showArchived}
                onToggleArchived={toggleArchived}
                onInstallPreset={() => setPresetDialogOpen(true)}
                onQuickTask={() => setOptimisticDialogOpen(true)}
                onNewSession={openCreateModal}
              />

              {filteredSessions.length > 0 ? (
                <SessionsTable
                  sessions={filteredSessions}
                  projectName={projectName}
                  nameFilter={nameFilter}
                  onNameFilterChange={setNameFilter}
                  onBranch={openCreateModal}
                />
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
              title="Delete session?"
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
