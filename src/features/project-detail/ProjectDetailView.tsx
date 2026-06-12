"use client";

import "./styles/project-detail.css";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useSessionsQuery } from "@/lib/sessions/queries";
import { useProjectsQuery } from "@/lib/projects/queries";
import { useDeleteSessionMutation } from "@/lib/sessions/mutations";
import {
  useShowCreateModal,
  useDeleteTarget,
  useOpenCreateModal,
  useCloseCreateModal,
  useCancelDeleteSession,
} from "@/stores/sessions.store";
import { useAppHotkey } from "@/hooks/useAppHotkey";
import { PlusIcon } from "@/components/icons";
import ScopedAgentCapabilitiesConfig from "@/components/agent-capabilities/ScopedAgentCapabilitiesConfig";
import CreateSessionModal from "./components/CreateSessionModal";
import ConfirmDialog from "@/components/ConfirmDialog";
import Topbar from "@/components/Topbar";
import ConversationSidebar from "@/features/session/sidebar/ConversationSidebar";
import { PROJECT_CONVERSATION_SESSION_SENTINEL } from "@/lib/conversations/project-conversation-scope";
import type { AgentBackendId } from "@/lib/shared/schemas";
import {
  useProjectConversationsQuery,
  useRefetchProjectConversationsOnFocus,
} from "@/lib/project-conversations-client/queries";
import { useReopenProjectConversation } from "@/lib/project-conversations-client/mutations";
import { useSessionFilters } from "./hooks/use-session-filters";
import ProjectCockpit from "./cockpit/ProjectCockpit";
import {
  useActiveTabId,
  useSetActiveTab,
  useFocusTab,
} from "./cockpit/use-cockpit-view-state";

interface ProjectDetailViewProps {
  projectName: string;
}

function WorkflowGlyph(): React.JSX.Element {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <circle
        cx="3.5"
        cy="3.5"
        r="2.1"
        stroke="currentColor"
        strokeWidth="1.2"
      />
      <circle
        cx="12.5"
        cy="3.5"
        r="2.1"
        stroke="currentColor"
        strokeWidth="1.2"
      />
      <circle
        cx="8"
        cy="12.5"
        r="2.1"
        stroke="currentColor"
        strokeWidth="1.2"
      />
      <path
        d="M5 4.5 L11 4.5 M4.5 5.2 L7.4 11 M11.5 5.2 L8.6 11"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
    </svg>
  );
}

export default function ProjectDetailView({
  projectName,
}: ProjectDetailViewProps): React.JSX.Element {
  const sessionsQuery = useSessionsQuery(projectName);
  const projectsQuery = useProjectsQuery();
  const conversationsQuery = useProjectConversationsQuery(projectName);
  useRefetchProjectConversationsOnFocus(projectName);

  const modalOpen = useShowCreateModal();
  const deleteTarget = useDeleteTarget();
  const openCreateModal = useOpenCreateModal();
  const closeCreateModal = useCloseCreateModal();
  const cancelDelete = useCancelDeleteSession();
  const deleteMutation = useDeleteSessionMutation(projectName);

  const [capabilitiesOpen, setCapabilitiesOpen] = useState(false);
  const [selectedBackend, setSelectedBackend] =
    useState<AgentBackendId>("claude");

  const router = useRouter();
  const searchParams = useSearchParams();
  const { tokens, setTokens } = useSessionFilters();

  const activeTabId = useActiveTabId();
  const setActiveTab = useSetActiveTab();
  const focusTab = useFocusTab();
  const { mutate: reopenConversation } =
    useReopenProjectConversation(projectName);
  const [unavailableFocusId, setUnavailableFocusId] = useState<string | null>(
    null,
  );

  const sessions = useMemo(
    () => sessionsQuery.data ?? [],
    [sessionsQuery.data],
  );
  const archivedCount = useMemo(
    () => sessions.filter((s) => s.archived).length,
    [sessions],
  );
  const openConversations = useMemo(
    () => conversationsQuery.data ?? [],
    [conversationsQuery.data],
  );
  const projectPath = useMemo(
    () => projectsQuery.data?.find((p) => p.name === projectName)?.path,
    [projectsQuery.data, projectName],
  );

  const handleDeleteConfirm = useCallback(() => {
    if (deleteTarget) deleteMutation.mutate(deleteTarget.sessionName);
    cancelDelete();
  }, [deleteTarget, deleteMutation, cancelDelete]);

  const handleRunCommand = useCallback(
    (id: "new" | "capabilities" | "workflow-builder") => {
      switch (id) {
        case "new":
          openCreateModal();
          break;
        case "capabilities":
          setCapabilitiesOpen(true);
          break;
        case "workflow-builder":
          router.push(`/projects/${encodeURIComponent(projectName)}/workflows`);
          break;
      }
    },
    [openCreateModal, router, projectName],
  );

  const handleBranch = useCallback(
    (sessionName: string) => openCreateModal(sessionName),
    [openCreateModal],
  );

  // Active Conversations surfaces signal PLC focus through the `focus` route
  // param; the project page reconciles it into an open, focused cockpit tab.
  const focusId = searchParams.get("focus");
  const visibleUnavailableFocusId =
    focusId !== null && unavailableFocusId === focusId
      ? unavailableFocusId
      : null;
  const handledFocusRef = useRef<string | null>(null);
  useEffect(() => {
    if (!focusId) {
      handledFocusRef.current = null;
      return;
    }
    if (conversationsQuery.isPending) return;
    if (handledFocusRef.current === focusId) return;
    handledFocusRef.current = focusId;
    const isOpen = openConversations.some((c) => c.id === focusId);
    if (isOpen) {
      setActiveTab(focusId);
    } else {
      reopenConversation(focusId, {
        onSuccess: () => {
          setUnavailableFocusId(null);
          focusTab(focusId);
        },
        onError: () => {
          setUnavailableFocusId(focusId);
        },
      });
    }
  }, [
    conversationsQuery.isPending,
    focusId,
    openConversations,
    setActiveTab,
    focusTab,
    reopenConversation,
  ]);

  useAppHotkey("newSession", () => openCreateModal());

  const runningCount = sessions.filter(
    (s) => s.derivedStatus === "running",
  ).length;

  const isLoading = sessionsQuery.isPending;

  return (
    <div
      className="app"
      data-page="sessions"
      data-page-variant="project-detail"
      data-density="regular"
    >
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
            <div className="stagger-in project-detail-shell">
              <div className="cc-page-header cc-page-header--compact">
                <div
                  className="cc-page-summaryrow"
                  aria-label="Project summary"
                >
                  <div className="cc-page-title">
                    {projectName} <span className="accent">·</span>
                  </div>
                  <span className="cc-page-meta cc-page-path">
                    {projectPath ?? projectName}
                  </span>
                  {runningCount > 0 && (
                    <span className="pill">
                      <span className="live-dot" />
                      {runningCount} running
                    </span>
                  )}
                  <span className="cc-page-meta">
                    {sessions.length} session
                    {sessions.length === 1 ? "" : "s"}
                  </span>
                  <span className="cc-page-meta">{archivedCount} archived</span>
                </div>
                <div className="cc-page-actions">
                  <Link
                    href={`/projects/${encodeURIComponent(projectName)}/workflows`}
                    className="cc-ibtn"
                    title="Open the Workflow Builder"
                  >
                    <WorkflowGlyph />
                    Workflows
                  </Link>
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
              </div>

              <ProjectCockpit
                projectName={projectName}
                openConversations={openConversations}
                sessions={sessions}
                archivedCount={archivedCount}
                tokens={tokens}
                onTokensChange={setTokens}
                onRunCommand={handleRunCommand}
                selectedBackend={selectedBackend}
                onSelectedBackendChange={setSelectedBackend}
                onBranch={handleBranch}
                rail={
                  <ConversationSidebar
                    projectName={projectName}
                    sessionName={PROJECT_CONVERSATION_SESSION_SENTINEL}
                    activeConversationId={activeTabId ?? ""}
                    showNewConversationButton={false}
                    showCollapseControl={false}
                    enableSearchHotkey={false}
                  />
                }
              />
              {visibleUnavailableFocusId !== null && (
                <div className="empty-state" role="status" aria-live="polite">
                  <div className="empty-state-title">
                    Project conversation unavailable
                  </div>
                  <div className="empty-state-desc">
                    Could not open project conversation{" "}
                    <code>{visibleUnavailableFocusId}</code>.
                  </div>
                </div>
              )}
            </div>

            <CreateSessionModal
              projectName={projectName}
              open={modalOpen}
              onClose={closeCreateModal}
            />

            <ScopedAgentCapabilitiesConfig
              level="conversation"
              conversationScope="project"
              projectName={projectName}
              conversationId={activeTabId ?? undefined}
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
          </>
        )}
      </main>
    </div>
  );
}
