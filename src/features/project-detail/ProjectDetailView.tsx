"use client";

import "./styles/project-detail.css";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useSessionsQuery } from "@/lib/sessions/queries";
import { usePresetsQuery } from "@/lib/dev-server/queries";
import { useInstallPresetMutation } from "@/lib/dev-server/mutations";
import {
  useBulkSessionsMutation,
  useDeleteSessionMutation,
} from "@/lib/sessions/mutations";
import {
  useShowCreateModal,
  useDeleteTarget,
  useOpenCreateModal,
  useCloseCreateModal,
  useCancelDeleteSession,
} from "@/stores/sessions.store";
import { pushToast } from "@/stores/toast.store";
import { useAppHotkey } from "@/hooks/useAppHotkey";
import { PlusIcon } from "@/components/icons";
import ScopedAgentCapabilitiesConfig from "@/components/agent-capabilities/ScopedAgentCapabilitiesConfig";
import CreateSessionModal from "./components/CreateSessionModal";
import PresetInstallDialog from "./components/PresetInstallDialog";
import SessionRows, { type SortState } from "./components/SessionRows";
import SectionHeader from "./components/SectionHeader";
import BulkConfirmModal, {
  type BulkConfirmKind,
} from "./components/BulkConfirmModal";
import CommandConsole from "./components/CommandConsole";
import ConfirmDialog from "@/components/ConfirmDialog";
import Topbar from "@/components/Topbar";
import { useSessionFilters } from "./hooks/use-session-filters";
import { applyFilters } from "./components/apply-filters";
import {
  computeSuggestions,
  type Suggestion,
} from "./components/command-suggestions";
import {
  selectedBulkActionKind,
  pruneMissingSelections,
} from "./components/bulk-selection";

interface ProjectDetailViewProps {
  projectName: string;
}

export default function ProjectDetailView({
  projectName,
}: ProjectDetailViewProps): React.JSX.Element {
  const sessionsQuery = useSessionsQuery(projectName);

  const modalOpen = useShowCreateModal();
  const deleteTarget = useDeleteTarget();
  const openCreateModal = useOpenCreateModal();
  const closeCreateModal = useCloseCreateModal();
  const cancelDelete = useCancelDeleteSession();

  const deleteMutation = useDeleteSessionMutation(projectName);
  const installPresetMutation = useInstallPresetMutation(projectName);
  const bulkMutation = useBulkSessionsMutation(projectName);

  const [presetDialogOpen, setPresetDialogOpen] = useState(false);
  const [capabilitiesOpen, setCapabilitiesOpen] = useState(false);
  const [consoleFocused, setConsoleFocused] = useState(false);
  const consoleInputRef = useRef<HTMLInputElement | null>(null);

  const [sort, setSort] = useState<SortState>({
    id: "lastActivityAt",
    desc: true,
  });
  const [rawSelected, setSelected] = useState<Set<string>>(() => new Set());
  const [confirmKind, setConfirmKind] = useState<BulkConfirmKind | null>(null);

  const router = useRouter();
  const { tokens, draft, setDraft, addToken, removeToken, clear } =
    useSessionFilters();

  const presetsQuery = usePresetsQuery(projectName);
  const installedPresets = useMemo(
    () => presetsQuery.data?.filter((p) => p.installed).map((p) => p.id) ?? [],
    [presetsQuery.data],
  );

  const sessions = useMemo(
    () => sessionsQuery.data ?? [],
    [sessionsQuery.data],
  );
  const archivedCount = useMemo(
    () => sessions.filter((s) => s.archived).length,
    [sessions],
  );

  const filteredSessions = useMemo(
    () => applyFilters(sessions, tokens, draft),
    [sessions, tokens, draft],
  );

  const selected = useMemo(
    () => pruneMissingSelections(rawSelected, sessions),
    [rawSelected, sessions],
  );

  const suggestions = useMemo<Suggestion[]>(
    () =>
      computeSuggestions({
        draft,
        tokens,
        sessions,
        archivedCount,
      }),
    [archivedCount, draft, sessions, tokens],
  );

  const handleDeleteConfirm = useCallback(() => {
    if (deleteTarget) {
      deleteMutation.mutate(deleteTarget.sessionName);
    }
    cancelDelete();
  }, [deleteTarget, deleteMutation, cancelDelete]);

  const handleApplySuggestion = useCallback(
    (s: Suggestion) => {
      if (s.kind === "action") {
        setDraft("");
        switch (s.id) {
          case "new":
            openCreateModal();
            break;
          case "install-preset":
            setPresetDialogOpen(true);
            break;
          case "capabilities":
            setCapabilitiesOpen(true);
            break;
          case "workflow-builder":
            router.push(
              `/projects/${encodeURIComponent(projectName)}/workflows`,
            );
            break;
        }
        return;
      }
      addToken({
        cat: s.cat,
        key: s.key,
        value: s.value,
        ...(s.exclusive !== undefined ? { exclusive: s.exclusive } : {}),
      });
      setDraft("");
    },
    [addToken, openCreateModal, projectName, router, setDraft],
  );

  const handleRowSelect = useCallback((sessionName: string, next: boolean) => {
    setSelected((prev) => {
      const out = new Set(prev);
      if (next) out.add(sessionName);
      else out.delete(sessionName);
      return out;
    });
  }, []);

  const visibleNames = useMemo(
    () => filteredSessions.map((s) => s.sessionName),
    [filteredSessions],
  );
  const visibleSelectedCount = useMemo(
    () => visibleNames.filter((n) => selected.has(n)).length,
    [visibleNames, selected],
  );
  const allVisibleSelected =
    visibleNames.length > 0 && visibleSelectedCount === visibleNames.length;
  const someVisibleSelected = visibleSelectedCount > 0 && !allVisibleSelected;

  const handleToggleAll = useCallback(
    (next: boolean) => {
      setSelected((prev) => {
        const out = new Set(prev);
        if (next || someVisibleSelected) {
          for (const n of visibleNames) out.add(n);
        } else {
          for (const n of visibleNames) out.delete(n);
        }
        return out;
      });
    },
    [someVisibleSelected, visibleNames],
  );

  const clearSelection = useCallback(() => setSelected(new Set()), []);

  const bulkKind = selectedBulkActionKind(selected, sessions);
  const selectedCount = selected.size;

  const handleConfirmBulk = useCallback(() => {
    if (!confirmKind) return;
    const sessionNames = [...selected];
    const op = confirmKind;
    bulkMutation.mutate(
      { op, sessionNames },
      {
        onSuccess: (response) => {
          const successes = response.results.filter((r) => r.success).length;
          const failures = response.results.length - successes;
          const noun = successes === 1 ? "session" : "sessions";
          const verb =
            op === "delete"
              ? "Deleted"
              : op === "unarchive"
                ? "Unarchived"
                : "Archived";
          if (failures > 0) {
            pushToast(`${verb} ${successes} ${noun}, ${failures} failed`);
          } else {
            pushToast(`${verb} ${successes} ${noun}`);
          }
          setConfirmKind(null);
          setSelected(new Set());
        },
      },
    );
  }, [bulkMutation, confirmKind, selected]);

  useEffect(() => {
    if (confirmKind) return;
    if (deleteTarget) return;
    if (selectedCount === 0) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") clearSelection();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [clearSelection, confirmKind, deleteTarget, selectedCount]);

  useAppHotkey("newSession", () => openCreateModal());
  useAppHotkey("focusCommandConsole", () => {
    consoleInputRef.current?.focus();
  });

  const runningCount = sessions.filter(
    (s) => s.derivedStatus === "running",
  ).length;

  const isLoading = sessionsQuery.isPending;

  const emptyAfterFilter =
    !isLoading && sessions.length > 0 && filteredSessions.length === 0;
  const emptyNoSessions =
    !isLoading && sessions.length === 0 && tokens.length === 0 && !draft;

  return (
    <div className="app" data-page="sessions" data-density="regular">
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
              <div
                className="cc-page-header"
                style={{ paddingBottom: "var(--space-sm)" }}
              >
                <div className="cc-page-titleblock">
                  <div className="cc-page-title">
                    {projectName} <span className="accent">·</span>
                  </div>
                  <div className="cc-page-sub">
                    <span className="path">~/code/{projectName}</span>
                    {runningCount > 0 && (
                      <span className="pill">
                        <span className="live-dot" />
                        {runningCount} running
                      </span>
                    )}
                    <span style={{ color: "var(--text-tertiary)" }}>
                      · {sessions.length} session
                      {sessions.length === 1 ? "" : "s"}, {archivedCount}{" "}
                      archived
                    </span>
                  </div>
                </div>
                <button
                  type="button"
                  className="cc-primary"
                  onClick={() => openCreateModal()}
                >
                  <span className="plus">
                    <PlusIcon size={12} />
                  </span>
                  New session
                  <span className="cc-primary-kbd">⌘N</span>
                </button>
              </div>

              <CommandConsole
                tokens={tokens}
                draft={draft}
                suggestions={suggestions}
                focused={consoleFocused}
                onDraftChange={setDraft}
                onApply={handleApplySuggestion}
                onRemoveToken={removeToken}
                onFocus={() => setConsoleFocused(true)}
                onBlur={() => setConsoleFocused(false)}
                inputRef={consoleInputRef}
              />

              {emptyNoSessions ? (
                <div className="empty-state">
                  <div className="empty-state-icon">&#128640;</div>
                  <div className="empty-state-title">No sessions yet</div>
                  <div className="empty-state-desc">
                    Create a session to start working with Claude in this
                    project.
                  </div>
                </div>
              ) : emptyAfterFilter ? (
                <div className="empty-state">
                  <div className="empty-state-title">No sessions match</div>
                  <div className="empty-state-desc">
                    Try clearing filters or pressing ⌘N for a new session.
                  </div>
                </div>
              ) : (
                <>
                  <SectionHeader
                    filteredCount={filteredSessions.length}
                    tokenCount={tokens.length}
                    selectionSize={selectedCount}
                    bulkActionKind={bulkKind}
                    isBulkPending={bulkMutation.isPending}
                    onClearFilters={clear}
                    onDeselect={clearSelection}
                    onBulkArchive={() => setConfirmKind("archive")}
                    onBulkUnarchive={() => setConfirmKind("unarchive")}
                    onBulkDelete={() => setConfirmKind("delete")}
                  />
                  <SessionRows
                    sessions={filteredSessions}
                    projectName={projectName}
                    sort={sort}
                    onSortChange={setSort}
                    selection={selected}
                    onToggleSelect={handleRowSelect}
                    onToggleAll={(next) =>
                      handleToggleAll(next || someVisibleSelected)
                    }
                    onBranch={openCreateModal}
                  />
                </>
              )}
            </div>

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

            <ScopedAgentCapabilitiesConfig
              level="project"
              projectName={projectName}
              open={capabilitiesOpen}
              onOpenChange={setCapabilitiesOpen}
              renderTrigger={false}
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

            <BulkConfirmModal
              open={confirmKind !== null}
              kind={confirmKind ?? "archive"}
              count={selectedCount}
              isPending={bulkMutation.isPending}
              onConfirm={handleConfirmBulk}
              onClose={() => setConfirmKind(null)}
            />
          </>
        )}
      </main>
    </div>
  );
}
