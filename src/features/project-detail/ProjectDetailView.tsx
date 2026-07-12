"use client";

import "./styles/project-detail.css";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useSessionsQuery } from "@/lib/sessions/queries";
import { useProjectsQuery } from "@/lib/projects/queries";
import { useTicketListQuery } from "@/lib/tickets/queries";
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
import {
  EmptyState,
  EmptyStateTitle,
  EmptyStateDesc,
} from "@/components/ui/EmptyState";
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

// Byte-for-byte reproduction of the `.cc-ibtn` leaf recipe (project-detail.css).
// The matching primitive is `IconButton variant="pill"`, but it renders a
// `<button>` while this control is a navigation `<Link>` (anchor) — swapping the
// element would drop native link behaviour (middle-click/open-in-new-tab/href),
// a functional regression. So the pill appearance is re-homed as inline utilities
// on the Link instead. This consumer is never toggled (`.active`), so only the
// base + hover state is transcribed. The `@media (max-width:768px)` 44px touch
// target the recipe carried is folded into the `max-768:` utilities.
const CC_IBTN_LINK_CLASS =
  "inline-flex h-[30px] items-center gap-[6px] rounded-md border border-solid " +
  "border-border-subtle bg-transparent px-[10px] py-0 font-mono text-[0.72rem] " +
  "font-medium text-text-secondary transition-all duration-150 ease-[ease] " +
  "[&_svg]:text-text-tertiary [&_svg]:transition-colors [&_svg]:duration-150 [&_svg]:ease-[ease] " +
  "hover:border-border-strong hover:bg-bg-hover hover:text-text-primary hover:[&_svg]:text-cyan " +
  "max-768:h-[44px] max-768:min-h-[44px] max-768:flex-1 max-768:justify-center";

// Byte-for-byte reproduction of the `.cc-primary` leaf recipe (project-detail.css).
// NOT swapped to `Button variant="primary"`: that primitive is the global
// `.btn-primary` recipe (px-18/py-10, 0.78rem, hover `0 0 20px cyan-glow`), which
// is NOT byte-identical to this compact page-redesign button (h-30/px-14, 0.74rem,
// hover `0 0 18px cyan-glow-strong`). Reproducing it as utilities preserves
// zero-visual-change (the charter invariant outranks the literal AC mapping). The
// `@media (max-width:768px)` 44px touch target is folded into `max-768:` utilities.
const CC_PRIMARY_CLASS =
  "inline-flex h-[30px] shrink-0 items-center gap-[6px] whitespace-nowrap rounded-md " +
  "border border-solid border-cyan bg-cyan px-[14px] py-0 font-mono text-[0.74rem] " +
  "font-semibold text-text-inverse transition-all duration-150 ease-[ease] " +
  "hover:border-cyan-dim hover:bg-cyan-dim hover:shadow-[0_0_18px_var(--color-cyan-glow-strong)] " +
  "max-768:h-[44px] max-768:min-h-[44px] max-768:flex-1 max-768:self-center max-768:px-md";

function TicketGlyph(): React.JSX.Element {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <rect
        x="2"
        y="3.5"
        width="12"
        height="9.5"
        rx="1.4"
        stroke="currentColor"
        strokeWidth="1.2"
      />
      <path
        d="M4.5 6.5 H11.5 M4.5 9 H8.5"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
    </svg>
  );
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

  const ticketsQuery = useTicketListQuery({ projectName });
  const openTicketCount =
    ticketsQuery.data?.filter(
      (ticket) => ticket.status !== "done" && ticket.status !== "closed",
    ).length ?? null;

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
              {/* ESCAPE HATCH (charter): the topbar status dot stays on the legacy
                  `.status-dot` leaf class rather than `<StatusDot>`. The mobile rule
                  `.topbar-status-default .status-indicator .status-dot { width:8px;
                  height:8px }` (globals.css @media ≤768px) enlarges it to 8px;
                  StatusDot is fixed at 7px and cannot re-home 8px via layoutClassName
                  (height/size are not layout-allowlisted), and the `.topbar-status-*`
                  ancestor is topbar-owned. Same resolution as the ConversationList
                  topbar dot — see .cc/graph-workflow-docs/swap-session-conversation-notes.md. */}
              <div className="status-dot warning" />
              {runningCount} session{runningCount !== 1 ? "s" : ""} running
            </div>
          ) : undefined
        }
      />
      <main className="main">
        {isLoading ? (
          <EmptyState>
            <EmptyStateTitle>Loading sessions...</EmptyStateTitle>
          </EmptyState>
        ) : (
          <>
            <div className="stagger-in project-detail-shell">
              <div className="flex min-h-[44px] items-center justify-between gap-md border-x-0 border-t-0 border-b border-solid border-border-dim px-xl py-sm max-768:flex-col max-768:items-stretch max-768:gap-sm max-768:px-md">
                <div
                  className="flex min-w-0 flex-1 items-center gap-sm max-768:flex-wrap max-768:gap-y-xs"
                  aria-label="Project summary"
                >
                  <div className="font-display text-[1.05rem] leading-[1.05] font-extrabold tracking-[0] whitespace-nowrap text-text-primary max-768:text-[1rem] max-768:[overflow-wrap:anywhere] max-768:whitespace-normal">
                    {projectName}{" "}
                    <span className="text-cyan [text-shadow:0_0_24px_var(--color-cyan-glow-text)]">
                      ·
                    </span>
                  </div>
                  <span className="inline-flex max-w-[min(48vw,58ch)] min-w-0 items-center overflow-hidden font-mono text-[0.72rem] text-ellipsis whitespace-nowrap text-text-tertiary max-768:max-w-full max-768:basis-full">
                    {projectPath ?? projectName}
                  </span>
                  {runningCount > 0 && (
                    <span className="inline-flex items-center gap-[5px] rounded-full border border-solid border-border-subtle bg-bg-raised px-[7px] py-[1px] text-[0.7rem] whitespace-nowrap text-text-secondary">
                      <span className="size-[6px] animate-[pulse-dot_2.5s_ease_infinite] rounded-full bg-green shadow-[0_0_6px_var(--color-green-glow)]" />
                      {runningCount} running
                    </span>
                  )}
                  <span className="inline-flex min-w-0 items-center font-mono text-[0.72rem] whitespace-nowrap text-text-tertiary">
                    {sessions.length} session
                    {sessions.length === 1 ? "" : "s"}
                  </span>
                  <span className="inline-flex min-w-0 items-center font-mono text-[0.72rem] whitespace-nowrap text-text-tertiary">
                    {archivedCount} archived
                  </span>
                </div>
                <div className="flex shrink-0 items-center gap-sm max-768:self-stretch">
                  <Link
                    href={`/tickets?project=${encodeURIComponent(projectName)}`}
                    className={CC_IBTN_LINK_CLASS}
                    title="Tickets for this project"
                  >
                    <TicketGlyph />
                    Tickets
                    {openTicketCount !== null && (
                      <span className="inline-flex min-w-[16px] justify-center rounded-full bg-bg-raised px-[5px] py-px font-mono text-[0.64rem] font-semibold text-text-secondary">
                        {openTicketCount}
                      </span>
                    )}
                  </Link>
                  <Link
                    href={`/projects/${encodeURIComponent(projectName)}/workflows`}
                    className={CC_IBTN_LINK_CLASS}
                    title="Open the Workflow Builder"
                  >
                    <WorkflowGlyph />
                    Workflows
                  </Link>
                  <button
                    type="button"
                    className={CC_PRIMARY_CLASS}
                    onClick={() => openCreateModal()}
                  >
                    <span className="text-[0.85rem] leading-none font-bold">
                      <PlusIcon size={12} />
                    </span>
                    New session
                    <span className="ml-[6px] rounded-[3px] bg-black/[0.18] px-[5px] py-px text-[0.62rem] opacity-80 max-768:hidden">
                      ⌘N
                    </span>
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
                <EmptyState role="status" aria-live="polite">
                  <EmptyStateTitle>
                    Project conversation unavailable
                  </EmptyStateTitle>
                  <EmptyStateDesc>
                    Could not open project conversation{" "}
                    <code>{visibleUnavailableFocusId}</code>.
                  </EmptyStateDesc>
                </EmptyState>
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
