// Size exception: this is the sidebar coordinator. Presentational rows, header,
// filters, context menu, and the row item have been split into separate files
// (ConversationSidebarHeader, ConversationSidebarRow, ConversationSidebarFilters,
// ConversationSidebarRowContextMenu). What remains is the coordinator's effects,
// hotkey wiring, mutation orchestration, mobile gestures, and rename/delete
// flows — splitting these further produces artificial seams.
"use client";

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { ActiveConversation } from "@/lib/active-conversations/schemas";
import { useActiveConversationsQuery } from "@/lib/active-conversations/queries";
import { PlusIcon } from "@/components/icons";
import {
  useCreateConversationMutation,
  useArchiveConversationMutation,
  useRenameConversationMutation,
  useGenericArchiveConversationMutation,
  useGenericRenameConversationMutation,
  useAnswerQuestionMutation,
  useForkConversationMutation,
} from "@/lib/conversations/mutations";
import { useGenericArchiveSessionMutation } from "@/lib/sessions/mutations";
import { apiFetch } from "@/lib/api/fetcher";
import { sessionStateSchema } from "@/lib/sessions/schemas";
import { buildConversationContext } from "@/lib/conversations/copy-context";
import ConfirmDialog from "@/components/ConfirmDialog";
import {
  useSidebarCollapsed,
  useToggleSidebar,
  useHydrateSidebar,
  useSidebarFilter,
  useSidebarSessionFilter,
  useSetSidebarSessionFilter,
} from "@/stores/session-detail.store";
import {
  useSidebarActiveListFilter,
  useSidebarGroupByPersistent,
} from "@/features/session/hooks/use-sidebar-persistent-filters";
import { useAppHotkey } from "@/hooks/useAppHotkey";
import { useLongPress } from "@/hooks/use-long-press";
import ConversationSidebarHeader from "@/features/session/sidebar/ConversationSidebarHeader";
import ConversationSidebarFilters from "@/features/session/sidebar/ConversationSidebarFilters";
import ConversationSidebarRow from "@/features/session/sidebar/ConversationSidebarRow";
import ConversationSidebarRowContextMenu, {
  type ContextMenuItem,
} from "@/features/session/sidebar/ConversationSidebarRowContextMenu";
import PeekPopover from "@/features/session/sidebar/PeekPopover";
import { usePeekReply } from "@/features/session/sidebar/use-peek-reply";
import { useConversationMessagesQuery } from "@/hooks/conversation/use-conversation-messages-query";
import {
  filterConversations,
  splitNeedsYou,
  buildConversationSidebarSections,
  type SidebarConversation,
  type SidebarListFilter,
  type AnnotatedSidebarConversation,
  type SidebarSection,
} from "@/features/session/sidebar/ConversationSidebar.helpers";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Row item (handles per-row long-press)
// ---------------------------------------------------------------------------

interface SidebarRowItemProps {
  row: AnnotatedSidebarConversation<
    SidebarConversation & Partial<{ archived: boolean }>
  >;
  conversation: ActiveConversation;
  href: string;
  isActive: boolean;
  activeConversationId: string;
  archived: boolean;
  onOpenMenu: (point: { x: number; y: number }) => void;
  onNavigate: () => void;
  onPeek: (anchorEl: HTMLElement, conversationId: string) => void;
}

function SidebarRowItem({
  row,
  conversation,
  href,
  isActive,
  activeConversationId,
  archived,
  onOpenMenu,
  onNavigate,
  onPeek,
}: SidebarRowItemProps): React.JSX.Element {
  const { handlers, didLongPressRef } = useLongPress({
    onLongPress: onOpenMenu,
  });

  return (
    <div
      className={`conversation-sidebar-row-wrapper${archived ? " is-archived" : ""}`}
      style={{ position: "relative" }}
      {...handlers}
    >
      <ConversationSidebarRow
        href={href}
        conversation={conversation}
        isActive={isActive}
        isFirstInSession={row.isFirstInSession}
        isLastInSession={row.isLastInSession}
        currentConversationId={activeConversationId}
        onClick={() => {
          if (didLongPressRef.current) return;
          onNavigate();
        }}
        onPeek={onPeek}
        onOpenMenu={onOpenMenu}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface Props {
  projectName: string;
  sessionName: string;
  activeConversationId: string;
  mobileOpen?: boolean;
  onMobileClose?: () => void;
}

function ConversationSidebar({
  projectName,
  sessionName,
  activeConversationId,
  mobileOpen,
  onMobileClose,
}: Props): React.JSX.Element {
  const router = useRouter();

  // --- Zustand ---
  const collapsed = useSidebarCollapsed();
  const toggleCollapsed = useToggleSidebar();
  const hydrateSidebar = useHydrateSidebar();
  const sidebarFilter = useSidebarFilter();
  const [sidebarGroupBy] = useSidebarGroupByPersistent();
  const sidebarSessionFilter = useSidebarSessionFilter();
  const setSidebarSessionFilter = useSetSidebarSessionFilter();

  // --- Active conversations query ---
  const { data: activeData } = useActiveConversationsQuery();
  const activeConvoList = useMemo(
    () => activeData?.conversations ?? [],
    [activeData],
  );
  const activeGraphWorkflows = useMemo(
    () => activeData?.graphWorkflowExecutions ?? [],
    [activeData],
  );
  const activeCollaborations = useMemo(
    () => activeData?.activeCollaborationExecutions ?? [],
    [activeData],
  );

  // --- Mutations ---
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
  const genericArchiveMutation = useGenericArchiveConversationMutation();
  const genericRenameMutation = useGenericRenameConversationMutation();
  const genericArchiveSessionMutation = useGenericArchiveSessionMutation();

  // --- Local UI state ---
  const [activeListFilter, setActiveListFilter] = useSidebarActiveListFilter();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const editInputRef = useRef<HTMLInputElement>(null);
  const [ctxMenu, setCtxMenu] = useState<{
    row: SidebarConversation & { archived?: boolean };
    scope: { projectName: string; sessionName: string };
    x: number;
    y: number;
  } | null>(null);
  const [pendingArchiveSession, setPendingArchiveSession] = useState<{
    projectName: string;
    sessionName: string;
  } | null>(null);
  const [peek, setPeek] = useState<{
    anchorEl: HTMLElement;
    conversationId: string;
  } | null>(null);
  const editScopeRef = useRef<{
    projectName: string;
    sessionName: string;
  } | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const openPeek = useCallback(
    (anchorEl: HTMLElement, conversationId: string) => {
      setCtxMenu(null);
      setPeek({ anchorEl, conversationId });
    },
    [],
  );

  const closePeek = useCallback(() => setPeek(null), []);

  // Restore collapsed state from localStorage on mount
  useEffect(() => {
    hydrateSidebar();
  }, [hydrateSidebar]);

  // Hotkeys
  useAppHotkey("toggleSidebar", toggleCollapsed);
  useAppHotkey("focusSidebarSearch", () => {
    // Don't steal focus from the prompt composer or other editable element.
    const active = document.activeElement;
    if (active instanceof HTMLElement) {
      const tag = active.tagName;
      const isEditable =
        tag === "INPUT" ||
        tag === "TEXTAREA" ||
        tag === "SELECT" ||
        active.isContentEditable;
      // If editable and not our own search input, leave focus alone.
      if (isEditable && active !== searchInputRef.current) return;
    }
    searchInputRef.current?.focus();
    searchInputRef.current?.select();
  });

  // Focus the rename input when editing begins
  useEffect(() => {
    if (editingId && editInputRef.current) {
      editInputRef.current.focus();
      editInputRef.current.select();
    }
  }, [editingId]);

  const handleNewConversation = useCallback(() => {
    if (createConvoMutation.isPending) return;
    createConvoMutation.mutate(undefined, {
      onSuccess: (convo) => {
        router.push(
          `/projects/${encodeURIComponent(projectName)}/${encodeURIComponent(sessionName)}/${convo.id}`,
        );
      },
    });
  }, [createConvoMutation, projectName, sessionName, router]);

  const handleRenameStart = useCallback(
    (
      id: string,
      name: string,
      scope: { projectName: string; sessionName: string },
    ) => {
      setEditingId(id);
      setEditValue(name);
      editScopeRef.current = scope;
    },
    [],
  );

  const handleRenameSubmit = useCallback(
    (id: string) => {
      const trimmed = editValue.trim();
      const scope = editScopeRef.current;
      if (!trimmed || !scope) {
        setEditingId(null);
        return;
      }
      const isCurrentSession =
        scope.projectName === projectName && scope.sessionName === sessionName;
      const onSettled = () => setEditingId(null);
      if (isCurrentSession) {
        renameConvoMutation.mutate(
          { conversationId: id, name: trimmed },
          { onSettled },
        );
      } else {
        genericRenameMutation.mutate(
          {
            projectName: scope.projectName,
            sessionName: scope.sessionName,
            conversationId: id,
            name: trimmed,
          },
          { onSettled },
        );
      }
    },
    [
      editValue,
      genericRenameMutation,
      projectName,
      renameConvoMutation,
      sessionName,
    ],
  );

  const handleArchive = useCallback(
    (
      id: string,
      archived: boolean,
      scope: { projectName: string; sessionName: string },
    ) => {
      const isCurrentSession =
        scope.projectName === projectName && scope.sessionName === sessionName;
      if (isCurrentSession) {
        archiveConvoMutation.mutate({ conversationId: id, archived });
      } else {
        genericArchiveMutation.mutate({
          projectName: scope.projectName,
          sessionName: scope.sessionName,
          conversationId: id,
          archived,
        });
      }
    },
    [archiveConvoMutation, genericArchiveMutation, projectName, sessionName],
  );

  const handleCopyContext = useCallback(
    async (row: SidebarConversation): Promise<void> => {
      const session = await apiFetch(
        `/api/projects/${encodeURIComponent(row.projectName)}/sessions/${encodeURIComponent(row.sessionName)}`,
        sessionStateSchema,
      );
      const text = buildConversationContext({
        projectName: row.projectName,
        sessionName: row.sessionName,
        session,
        conversationId: row.id,
      });
      await navigator.clipboard.writeText(text);
    },
    [],
  );

  const activeRows: SidebarConversation[] = activeConvoList;
  const peekConversation = useMemo(() => {
    if (peek === null) return null;
    return (
      activeConvoList.find(
        (conversation) => conversation.id === peek.conversationId,
      ) ?? null
    );
  }, [activeConvoList, peek]);
  const peekProjectName = peekConversation?.projectName ?? projectName;
  const peekSessionName = peekConversation?.sessionName ?? sessionName;
  const peekConversationId = peek?.conversationId ?? "";
  const peekMessagesQuery = useConversationMessagesQuery(
    peekProjectName,
    peekSessionName,
    peekConversationId,
    { enabled: peek !== null && peekConversation !== null },
  );
  const peekReplyMutation = usePeekReply({
    projectName: peekProjectName,
    sessionName: peekSessionName,
    conversationId: peekConversationId,
  });
  const peekAnswerMutation = useAnswerQuestionMutation(
    peekProjectName,
    peekSessionName,
    peekConversationId,
  );
  const peekForkMutation = useForkConversationMutation(
    peekProjectName,
    peekSessionName,
  );

  const handlePeekFork = useCallback(
    (messageIndex: number) => {
      if (peek === null || peekConversation === null) return;
      void peekForkMutation
        .mutateAsync({ conversationId: peek.conversationId, messageIndex })
        .then(({ conversationId }) => {
          closePeek();
          if (onMobileClose) onMobileClose();
          router.push(
            `/projects/${encodeURIComponent(peekConversation.projectName)}/${encodeURIComponent(peekConversation.sessionName)}/${conversationId}`,
          );
        });
    },
    [
      closePeek,
      onMobileClose,
      peek,
      peekConversation,
      peekForkMutation,
      router,
    ],
  );

  const sessionScope = useMemo(
    () => sidebarSessionFilter ?? { projectName, sessionName },
    [projectName, sessionName, sidebarSessionFilter],
  );

  const filterCounts = useMemo(() => {
    const { needsYou } = splitNeedsYou(activeRows);
    return {
      all: activeRows.length,
      needs: needsYou.length,
      running: activeRows.filter((row) => row.status === "running").length,
      session: activeRows.filter(
        (row) =>
          row.projectName === sessionScope.projectName &&
          row.sessionName === sessionScope.sessionName,
      ).length,
    } satisfies Record<SidebarListFilter, number>;
  }, [activeRows, sessionScope]);

  const sidebarSections = useMemo(
    () =>
      buildConversationSidebarSections(
        filterConversations(activeRows, sidebarFilter),
        {
          filter: activeListFilter,
          groupBy: sidebarGroupBy,
          sessionScope,
        },
      ),
    [activeListFilter, activeRows, sessionScope, sidebarFilter, sidebarGroupBy],
  );

  const hasConversationResults = sidebarSections.some(
    (section) => section.items.length > 0,
  );

  const renderRow = useCallback(
    <T extends SidebarConversation & Partial<{ archived: boolean }>>(
      row: AnnotatedSidebarConversation<T>,
    ) => {
      const isEditing = editingId === row.id;
      const isActive = row.id === activeConversationId;
      const archived = row.archived === true;
      const conversation: ActiveConversation = {
        id: row.id,
        name: row.name,
        status: row.status,
        lastActivityAt: row.lastActivityAt,
        projectName: row.projectName,
        projectPath: row.projectPath,
        sessionName: row.sessionName,
        agentBackend: row.agentBackend,
        summary: row.summary,
        pendingQuestion: row.pendingQuestion,
        pendingQuestionId: row.pendingQuestionId,
        pendingQuestions: row.pendingQuestions,
        forkedFrom: row.forkedFrom,
        debugActive: row.debugActive,
        role: row.role,
        branchName: row.branchName,
        worktreePath: row.worktreePath,
        lastActivitySummary: row.lastActivitySummary,
      };
      const scope = {
        projectName: row.projectName,
        sessionName: row.sessionName,
      };
      const href = `/projects/${encodeURIComponent(row.projectName)}/${encodeURIComponent(row.sessionName)}/${row.id}`;

      if (isEditing) {
        return (
          <div
            key={row.id}
            className={`conversation-sidebar-row-wrapper${archived ? " is-archived" : ""}`}
            style={{ position: "relative" }}
          >
            <div
              className="conversation-sidebar-row"
              data-status={row.status}
              style={{ padding: "var(--space-sm) var(--space-md)" }}
            >
              <input
                ref={editInputRef}
                className="convo-rename-input"
                value={editValue}
                onChange={(e) => setEditValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    handleRenameSubmit(row.id);
                  } else if (e.key === "Escape") {
                    e.stopPropagation();
                    setEditingId(null);
                  }
                }}
                onBlur={() => handleRenameSubmit(row.id)}
                maxLength={200}
                style={{ flex: 1, minWidth: 0 }}
              />
            </div>
          </div>
        );
      }

      return (
        <SidebarRowItem
          key={row.id}
          row={row}
          conversation={conversation}
          href={href}
          isActive={isActive}
          activeConversationId={activeConversationId}
          archived={archived}
          onNavigate={() => {
            router.push(href);
            if (onMobileClose) onMobileClose();
          }}
          onPeek={openPeek}
          onOpenMenu={(point) => {
            setCtxMenu({ row, scope, x: point.x, y: point.y });
          }}
        />
      );
    },
    [
      activeConversationId,
      editValue,
      editingId,
      handleRenameSubmit,
      onMobileClose,
      openPeek,
      router,
    ],
  );

  const renderSections = useCallback(
    <T extends SidebarConversation & Partial<{ archived: boolean }>>(
      sections: SidebarSection<T>[],
    ) => {
      return sections.map((section) => {
        if (section.items.length === 0) return null;
        return (
          <section
            key={section.groupKey}
            className="convo-sidebar-section"
            data-section-kind={section.kind}
          >
            <div
              className={`convo-sidebar-section-header${
                section.kind === "needs"
                  ? " convo-sidebar-section-header--needs"
                  : ""
              }`}
            >
              {section.kind === "session" &&
              section.projectLabel !== undefined &&
              section.sessionLabel !== undefined ? (
                <span className="convo-sidebar-section-label convo-sidebar-section-label--session">
                  <span className="convo-sidebar-section-label-project">
                    {section.projectLabel}
                  </span>
                  <span className="convo-sidebar-section-label-separator">
                    /
                  </span>
                  <span className="convo-sidebar-section-label-session">
                    {section.sessionLabel}
                  </span>
                </span>
              ) : (
                <span className="convo-sidebar-section-label">
                  {section.label}
                </span>
              )}
              <span className="convo-sidebar-section-count">
                {section.kind === "needs"
                  ? `(${section.items.length})`
                  : section.items.length}
              </span>
            </div>
            <div className="convo-sidebar-section-rows">
              {section.items.map((row) => renderRow(row))}
            </div>
          </section>
        );
      });
    },
    [renderRow],
  );

  const ctxMenuItems: ContextMenuItem[] = useMemo(() => {
    if (ctxMenu === null) return [];
    const { row, scope } = ctxMenu;
    const archived = row.archived === true;
    const href = `/projects/${encodeURIComponent(row.projectName)}/${encodeURIComponent(row.sessionName)}/${row.id}`;
    const projectHref = `/projects/${encodeURIComponent(row.projectName)}`;
    const filterAlreadyApplied =
      activeListFilter === "session" &&
      sessionScope.projectName === row.projectName &&
      sessionScope.sessionName === row.sessionName;
    const items: ContextMenuItem[] = [
      {
        kind: "item",
        label: "Open conversation",
        hotkey: "Enter",
        onSelect: () => {
          router.push(href);
          if (onMobileClose) onMobileClose();
        },
      },
      { kind: "divider" },
      {
        kind: "item",
        label: filterAlreadyApplied
          ? `Filtered to ${row.sessionName}`
          : `Filter sidebar to session: ${row.sessionName}`,
        disabled: filterAlreadyApplied,
        onSelect: () => {
          setSidebarSessionFilter({
            projectName: row.projectName,
            sessionName: row.sessionName,
          });
          setActiveListFilter("session");
        },
      },
      {
        kind: "item",
        label: "Open project page",
        onSelect: () => {
          router.push(projectHref);
          if (onMobileClose) onMobileClose();
        },
      },
      {
        kind: "item",
        label: "Copy branch name",
        disabled: row.branchName === null,
        onSelect: () => {
          if (row.branchName === null) return;
          void navigator.clipboard.writeText(row.branchName);
        },
      },
      {
        kind: "item",
        label: "Copy worktree path",
        onSelect: () => {
          void navigator.clipboard.writeText(row.worktreePath);
        },
      },
      {
        kind: "item",
        label: "Copy context",
        hotkey: "\u2318\u21E7C",
        onSelect: () => {
          void handleCopyContext(row);
        },
      },
      { kind: "divider" },
      {
        kind: "item",
        label: "Rename\u2026",
        onSelect: () => {
          handleRenameStart(row.id, row.name ?? row.summary ?? "", scope);
        },
      },
      {
        kind: "item",
        label: archived ? "Unarchive conversation" : "Archive conversation",
        onSelect: () => {
          handleArchive(row.id, !archived, scope);
        },
      },
      {
        kind: "item",
        label: "Archive session",
        onSelect: () => {
          setPendingArchiveSession({
            projectName: row.projectName,
            sessionName: row.sessionName,
          });
        },
      },
    ];
    return items;
  }, [
    ctxMenu,
    activeListFilter,
    handleArchive,
    handleCopyContext,
    handleRenameStart,
    onMobileClose,
    router,
    setActiveListFilter,
    setSidebarSessionFilter,
    sessionScope,
  ]);

  return (
    <>
      {/* Backdrop for mobile drawer */}
      <div
        className={`convo-sidebar-backdrop${mobileOpen ? " visible" : ""}`}
        onClick={onMobileClose}
      />
      <div
        className={`convo-sidebar${collapsed ? " collapsed" : ""}${mobileOpen ? " mobile-open" : ""}`}
      >
        <div className="cc-section-header convo-sidebar-header">
          <span className="convo-sidebar-title">
            Active Conversations{" "}
            <span className="convo-sidebar-title-count">
              ({filterCounts.all})
            </span>
          </span>
          <div className="cc-section-actions">
            <button
              className="btn-icon-only convo-sidebar-header-new"
              onClick={handleNewConversation}
              disabled={createConvoMutation.isPending}
              data-tooltip="New conversation"
              aria-label="New conversation"
            >
              <PlusIcon />
            </button>
            <button
              className="btn-icon-only convo-sidebar-toggle"
              onClick={toggleCollapsed}
              data-tooltip="Collapse sidebar"
            >
              {"\u25C0"}
            </button>
            <button
              className="convo-sidebar-close"
              onClick={onMobileClose}
              data-tooltip="Close"
            >
              &#10005;
            </button>
          </div>
        </div>
        {(!collapsed || mobileOpen) && (
          <>
            <div className="convo-sidebar-controls-wrapper">
              <ConversationSidebarHeader
                counts={filterCounts}
                activeFilter={activeListFilter}
                onFilterChange={(value) => {
                  if (value !== "session") setSidebarSessionFilter(null);
                  setActiveListFilter(value);
                }}
                searchInputRef={searchInputRef}
              />
              <ConversationSidebarFilters />
            </div>

            <div className="convo-sidebar-list">
              {activeGraphWorkflows.length > 0 && (
                <div className="convo-sidebar-section">
                  <div className="convo-sidebar-section-header">
                    <span className="convo-sidebar-section-label">
                      Graph Workflows
                    </span>
                    <span className="convo-sidebar-section-count">
                      {activeGraphWorkflows.length}
                    </span>
                  </div>
                  {activeGraphWorkflows.map((gw) => (
                    <Link
                      key={gw.executionId}
                      href={`/projects/${encodeURIComponent(gw.projectName)}/${encodeURIComponent(gw.sessionName)}/workflow`}
                      className="convo-sidebar-item"
                    >
                      <span className={`sidebar-dot ${gw.status}`} />
                      <div className="convo-sidebar-item-body">
                        <div className="convo-sidebar-item-name-row">
                          <div className="convo-sidebar-item-summary">
                            {gw.activeContextTitles.length > 0
                              ? gw.activeContextTitles.join(" + ")
                              : "Graph Workflow"}
                          </div>
                          <span className="convo-sidebar-active-time">
                            {gw.completedContexts}/{gw.totalContexts}
                          </span>
                        </div>
                        <span className="convo-sidebar-session-label">
                          {gw.projectName} / {gw.sessionName}
                        </span>
                      </div>
                    </Link>
                  ))}
                </div>
              )}
              {activeCollaborations.length > 0 && (
                <div className="convo-sidebar-section">
                  <div className="convo-sidebar-section-header">
                    <span className="convo-sidebar-section-label">
                      Collaborations
                    </span>
                    <span className="convo-sidebar-section-count">
                      {activeCollaborations.length}
                    </span>
                  </div>
                  {activeCollaborations.map((collab) => {
                    const href = collab.conversationId
                      ? `/projects/${encodeURIComponent(collab.projectName)}/${encodeURIComponent(collab.sessionName)}/${collab.conversationId}`
                      : `/projects/${encodeURIComponent(collab.projectName)}/${encodeURIComponent(collab.sessionName)}`;
                    return (
                      <Link
                        key={collab.workflowId}
                        href={href}
                        className="convo-sidebar-item"
                      >
                        <span className={`sidebar-dot ${collab.status}`} />
                        <div className="convo-sidebar-item-body">
                          <div className="convo-sidebar-item-name-row">
                            <div className="convo-sidebar-item-summary">
                              Collaboration ({collab.status})
                            </div>
                            <span className="convo-sidebar-active-time">
                              {formatRelativeTime(collab.updatedAt)}
                            </span>
                          </div>
                          <span className="convo-sidebar-session-label">
                            {collab.projectName} / {collab.sessionName}
                          </span>
                        </div>
                      </Link>
                    );
                  })}
                </div>
              )}
              {hasConversationResults
                ? renderSections(sidebarSections)
                : activeGraphWorkflows.length === 0 &&
                  activeCollaborations.length === 0 && (
                    <div className="convo-sidebar-empty">
                      {sidebarFilter
                        ? "No matches."
                        : "No active conversations."}
                      <span className="convo-sidebar-empty-hint">
                        {sidebarFilter
                          ? "Try clearing the search."
                          : "New, running, or awaiting conversations will appear here."}
                      </span>
                    </div>
                  )}
            </div>
          </>
        )}
      </div>
      {ctxMenu !== null && (
        <ConversationSidebarRowContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          items={ctxMenuItems}
          onClose={() => setCtxMenu(null)}
        />
      )}
      {peek !== null && peekConversation !== null && (
        <PeekPopover
          anchorEl={peek.anchorEl}
          conversation={peekConversation}
          transcriptMessages={peekMessagesQuery.data ?? []}
          onClose={closePeek}
          onOpenFull={() => {
            router.push(
              `/projects/${encodeURIComponent(peekConversation.projectName)}/${encodeURIComponent(peekConversation.sessionName)}/${peekConversation.id}`,
            );
            if (onMobileClose) onMobileClose();
            closePeek();
          }}
          onReplyText={(text) => {
            peekReplyMutation.mutate(text);
          }}
          onAnswerQuestion={(answers) => {
            peekAnswerMutation.mutate({
              questionId:
                peekConversation.pendingQuestionId ?? peekConversation.id,
              answers,
            });
          }}
          onFork={handlePeekFork}
        />
      )}
      <ConfirmDialog
        open={pendingArchiveSession !== null}
        title="Archive session"
        message="This hides the session and all its conversations, and stops any running dev servers. You can unarchive it later to restore."
        confirmLabel="Archive session"
        onConfirm={() => {
          if (pendingArchiveSession === null) return;
          genericArchiveSessionMutation.mutate({
            projectName: pendingArchiveSession.projectName,
            sessionName: pendingArchiveSession.sessionName,
            archived: true,
          });
          setPendingArchiveSession(null);
        }}
        onCancel={() => setPendingArchiveSession(null)}
      />
    </>
  );
}

export default memo(ConversationSidebar);
