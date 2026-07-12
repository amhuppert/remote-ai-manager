// Size exception: this is the sidebar coordinator. Presentational rows, header,
// filters, context menu, and the row item have been split into separate files
// (ConversationSidebarHeader, ConversationSidebarRow, ConversationSidebarFilters,
// ConversationSidebarRowContextMenu). What remains is the coordinator's effects,
// hotkey wiring, mutation orchestration, mobile gestures, and rename/delete
// flows — splitting these further produces artificial seams.
"use client";

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { cn } from "@/lib/ui/cn";
import type {
  ActiveConversation,
  SessionActiveConversation,
} from "@/lib/active-conversations/schemas";
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
  useMarkConversationReadMutation,
} from "@/lib/conversations/mutations";
import { useMarkProjectConversationReadMutation } from "@/lib/project-conversations-client/mutations";
import { useResolveApprovalMutation } from "@/lib/workflows/mutations";
import { useNotificationsQuery } from "@/lib/notifications/queries";
import { useDismissNotificationMutation } from "@/lib/notifications/mutations";
import {
  useLandPreparedMergeMutation,
  useDiscardPreparedMergeMutation,
} from "@/lib/git/mutations";
import { useNotificationJobs } from "@/stores/notification.store";
import { useGenericArchiveSessionMutation } from "@/lib/sessions/mutations";
import { apiFetch } from "@/lib/api/fetcher";
import { sessionStateSchema } from "@/lib/sessions/schemas";
import { graphWorkflowExecutionFullResponseSchema } from "@/lib/workflows/schemas";
import { buildConversationContext } from "@/lib/conversations/copy-context";
import { conversationsPageHref } from "@/lib/conversations/hrefs";
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
import { isEditableTarget } from "@/lib/shared/dom";
import ConversationSidebarHeader from "@/features/session/sidebar/ConversationSidebarHeader";
import ConversationSidebarFilters from "@/features/session/sidebar/ConversationSidebarFilters";
import ConversationSidebarRow from "@/features/session/sidebar/ConversationSidebarRow";
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
} from "@/components/ui/ContextMenu";
import { Spinner } from "@/components/ui/Spinner";
import {
  ConversationRowMenuItems,
  type ConversationRowMenuItem,
} from "@/features/session/sidebar/conversation-row-menu";
import PeekPopover, {
  type PeekApprovalGate,
} from "@/features/session/sidebar/PeekPopover";
import ActiveWorkSection from "@/features/session/sidebar/ActiveWorkSection";
import type {
  ActiveWorkAction,
  ActiveWorkItem,
  AttentionItem,
} from "@/features/session/sidebar/active-work";
import {
  adaptCollaborations,
  adaptGraphWorkflows,
  adaptStoreJobs,
  deriveNotificationOutcomes,
} from "@/features/session/sidebar/active-work-adapters";
import { usePeekReply } from "@/features/session/sidebar/use-peek-reply";
import { useConversationMessagesQuery } from "@/hooks/conversation/use-conversation-messages-query";
import { useClientStateReady } from "@/hooks/use-client-state-ready";
import {
  filterConversations,
  splitNeedsYou,
  buildConversationSidebarSections,
  describeActiveRow,
  isClosedProjectConversation,
  type ActiveRowActionScope,
  type ActiveSidebarConversation,
  type SidebarListFilter,
  type AnnotatedSidebarConversation,
  type SidebarSection,
} from "@/features/session/sidebar/ConversationSidebar.helpers";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Row item (handles per-row long-press)
// ---------------------------------------------------------------------------

interface SidebarRowItemProps {
  row: AnnotatedSidebarConversation<
    ActiveSidebarConversation & Partial<{ archived: boolean }>
  >;
  conversation: ActiveConversation;
  href: string;
  isActive: boolean;
  activeConversationId: string;
  closed: boolean;
  onNavigate: () => void;
  onPeek?: (anchorEl: HTMLElement, conversationId: string) => void;
  onAcknowledge?: () => void;
}

function SidebarRowItem({
  row,
  conversation,
  href,
  isActive,
  activeConversationId,
  closed,
  onNavigate,
  onPeek,
  onAcknowledge,
}: SidebarRowItemProps): React.JSX.Element {
  // Right-click and touch long-press are handled by the row's ContextMenu
  // trigger (renderRow), so no manual long-press wiring lives here.
  return (
    <div className="relative mx-[8px] my-[1px]">
      <ConversationSidebarRow
        href={href}
        conversation={conversation}
        isActive={isActive}
        isFirstInSession={row.isFirstInSession}
        isLastInSession={row.isLastInSession}
        currentConversationId={activeConversationId}
        isClosed={closed}
        onClick={onNavigate}
        onPeek={onPeek}
        onAcknowledge={onAcknowledge}
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
  showNewConversationButton?: boolean;
  /**
   * Whether this sidebar owns its own collapse control. The project cockpit
   * embeds the rail inside a host that owns rail-collapse, so it passes `false`
   * to suppress the redundant inner toggle (and to ignore any persisted
   * collapsed state, which would otherwise strand the panel with no restore).
   */
  showCollapseControl?: boolean;
  /**
   * Whether this sidebar owns the mod+k binding. On the project page mod+k
   * belongs to the command console (the cockpit composer), so the embedded
   * rail passes `false` to keep the route-exclusive binding from colliding.
   */
  enableSearchHotkey?: boolean;
  /**
   * When provided, invoked instead of `router.push` for every session-scoped
   * conversation open (row navigate, open-after-create, open-after-fork,
   * open-from-peek, context-menu open) so a host can switch conversations
   * in place. Project-scoped rows always `router.push` regardless. Rows keep
   * rendering real anchors, so modifier-clicks still open a new tab.
   */
  onOpenConversation?: (target: {
    conversationId: string;
    projectName: string;
    sessionName: string;
  }) => void;
  /**
   * When provided, the context menu of a session-scoped row offers
   * "Open in New Tab" — the host switches the /conversations layout to a
   * tab-showing (non-panes) view and opens the conversation. Absent outside
   * /conversations, where tabs/panes have no meaning.
   */
  onOpenInTab?: (target: {
    conversationId: string;
    projectName: string;
    sessionName: string;
  }) => void;
  /**
   * When provided, the context menu of a session-scoped row offers
   * "Open in New Pane" — the host switches the /conversations layout to the
   * panes (split-screen) view and opens the conversation.
   */
  onOpenInPane?: (target: {
    conversationId: string;
    projectName: string;
    sessionName: string;
  }) => void;
}

function ConversationSidebar({
  projectName,
  sessionName,
  activeConversationId,
  mobileOpen,
  onMobileClose,
  showNewConversationButton = true,
  showCollapseControl = true,
  enableSearchHotkey = true,
  onOpenConversation,
  onOpenInTab,
  onOpenInPane,
}: Props): React.JSX.Element {
  const router = useRouter();

  const openSessionScopedConversation = useCallback(
    (
      target: {
        conversationId: string;
        projectName: string;
        sessionName: string;
      },
      href: string,
    ) => {
      if (onOpenConversation !== undefined) {
        onOpenConversation(target);
        return;
      }
      router.push(href);
    },
    [onOpenConversation, router],
  );

  // --- Zustand ---
  const collapsed = useSidebarCollapsed();
  const toggleCollapsed = useToggleSidebar();
  // When the host owns collapse, never self-collapse — the inner toggle is
  // hidden and there is no in-rail restore affordance.
  const effectiveCollapsed = showCollapseControl ? collapsed : false;
  const hydrateSidebar = useHydrateSidebar();
  const sidebarFilter = useSidebarFilter();
  const [sidebarGroupBy] = useSidebarGroupByPersistent();
  const sidebarSessionFilter = useSidebarSessionFilter();
  const setSidebarSessionFilter = useSetSidebarSessionFilter();

  // --- Active conversations query ---
  const { data: activeData } = useActiveConversationsQuery();
  const clientStateReady = useClientStateReady();
  const activeConvoList = useMemo(
    () => (clientStateReady ? (activeData?.conversations ?? []) : []),
    [activeData, clientStateReady],
  );
  const activeGraphWorkflows = useMemo(
    () => (clientStateReady ? (activeData?.graphWorkflowExecutions ?? []) : []),
    [activeData, clientStateReady],
  );
  const activeCollaborations = useMemo(
    () =>
      clientStateReady ? (activeData?.activeCollaborationExecutions ?? []) : [],
    [activeData, clientStateReady],
  );

  // --- Active work (jobs + workflows + collabs + durable actionables) ---
  const storeJobsMap = useNotificationJobs();
  const storeJobs = useMemo(() => [...storeJobsMap.values()], [storeJobsMap]);
  const { data: notificationsData } = useNotificationsQuery();
  const notificationOutcomes = useMemo(
    () =>
      deriveNotificationOutcomes(
        clientStateReady ? (notificationsData?.notifications ?? []) : [],
        storeJobs,
      ),
    [clientStateReady, notificationsData, storeJobs],
  );
  const activeWorkItems = useMemo(
    () => [
      ...adaptStoreJobs(storeJobs),
      ...adaptGraphWorkflows(activeGraphWorkflows),
      ...adaptCollaborations(activeCollaborations),
      ...notificationOutcomes.needsAction,
    ],
    [
      storeJobs,
      activeGraphWorkflows,
      activeCollaborations,
      notificationOutcomes,
    ],
  );
  const attentionItems = notificationOutcomes.attention;

  // Elapsed-time labels tick on a coarse clock; per-row precision below a
  // minute is not needed in the rail.
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  const landMutation = useLandPreparedMergeMutation();
  const discardMutation = useDiscardPreparedMergeMutation();
  const dismissNotificationMutation = useDismissNotificationMutation();

  const handleActiveWorkAction = useCallback(
    (item: ActiveWorkItem, action: ActiveWorkAction) => {
      if (action.kind === "land") {
        landMutation.mutate({
          projectName: item.projectName,
          sessionName: item.sessionName,
        });
        return;
      }
      if (action.kind === "discard") {
        discardMutation.mutate({
          projectName: item.projectName,
          sessionName: item.sessionName,
        });
        return;
      }
      router.push(item.href);
    },
    [landMutation, discardMutation, router],
  );

  const handleDismissAttention = useCallback(
    (item: AttentionItem) => {
      dismissNotificationMutation.mutate(item.id);
    },
    [dismissNotificationMutation],
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
  const markReadMutation = useMarkConversationReadMutation();
  const markProjectReadMutation = useMarkProjectConversationReadMutation();

  // --- Local UI state ---
  const [activeListFilter, setActiveListFilter] = useSidebarActiveListFilter();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const editInputRef = useRef<HTMLInputElement>(null);
  const [pendingArchiveSession, setPendingArchiveSession] = useState<{
    projectName: string;
    sessionName: string;
  } | null>(null);
  const [peek, setPeek] = useState<{
    anchorEl: HTMLElement;
    conversationId: string;
  } | null>(null);
  const editScopeRef = useRef<{
    scope: ActiveRowActionScope;
  } | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const openPeek = useCallback(
    (anchorEl: HTMLElement, conversationId: string) => {
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
  useAppHotkey("toggleSidebar", () => {
    if (showCollapseControl) toggleCollapsed();
  });
  useAppHotkey(
    "focusSidebarSearch",
    () => {
      // Don't steal focus from the prompt composer or other editable element.
      const active = document.activeElement;
      // If editable and not our own search input, leave focus alone.
      if (isEditableTarget(active) && active !== searchInputRef.current) return;
      searchInputRef.current?.focus();
      searchInputRef.current?.select();
    },
    { enabled: enableSearchHotkey },
  );

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
        openSessionScopedConversation(
          { conversationId: convo.id, projectName, sessionName },
          conversationsPageHref({ conversationId: convo.id }),
        );
      },
    });
  }, [
    createConvoMutation,
    projectName,
    sessionName,
    openSessionScopedConversation,
  ]);

  const handleRenameStart = useCallback(
    (id: string, name: string, scope: ActiveRowActionScope) => {
      setEditingId(id);
      setEditValue(name);
      editScopeRef.current = { scope };
    },
    [],
  );

  const handleRenameSubmit = useCallback(
    (id: string) => {
      const trimmed = editValue.trim();
      const scope = editScopeRef.current?.scope;
      if (!trimmed || scope === undefined) {
        setEditingId(null);
        return;
      }
      const isCurrentSession =
        scope.scope === "session" &&
        scope.projectName === projectName &&
        scope.sessionName === sessionName;
      const onSettled = () => setEditingId(null);
      if (isCurrentSession) {
        renameConvoMutation.mutate(
          { conversationId: id, name: trimmed },
          { onSettled },
        );
      } else {
        genericRenameMutation.mutate(
          { ...scope, name: trimmed },
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
    (id: string, archived: boolean, scope: ActiveRowActionScope) => {
      const isCurrentSession =
        scope.scope === "session" &&
        scope.projectName === projectName &&
        scope.sessionName === sessionName;
      if (isCurrentSession) {
        archiveConvoMutation.mutate({ conversationId: id, archived });
      } else {
        genericArchiveMutation.mutate({ ...scope, archived });
      }
    },
    [archiveConvoMutation, genericArchiveMutation, projectName, sessionName],
  );

  const handleCopyContext = useCallback(
    async (row: SessionActiveConversation): Promise<void> => {
      const [session, executionResponse] = await Promise.all([
        apiFetch(
          `/api/projects/${encodeURIComponent(row.projectName)}/sessions/${encodeURIComponent(row.sessionName)}`,
          sessionStateSchema,
        ),
        // The execution no longer rides the session payload (decoupled table),
        // so fetch it separately to keep the workflow block in the copy.
        apiFetch(
          `/api/projects/${encodeURIComponent(row.projectName)}/sessions/${encodeURIComponent(row.sessionName)}/graph-workflow/execution`,
          graphWorkflowExecutionFullResponseSchema,
        ),
      ]);
      const text = buildConversationContext({
        projectName: row.projectName,
        sessionName: row.sessionName,
        session,
        conversationId: row.id,
        graphWorkflowExecution: executionResponse.execution,
      });
      await navigator.clipboard.writeText(text);
    },
    [],
  );

  const activeRows: ActiveSidebarConversation[] = activeConvoList;
  const peekConversation = useMemo((): SessionActiveConversation | null => {
    if (peek === null) return null;
    const conversation = activeConvoList.find(
      (candidate) => candidate.id === peek.conversationId,
    );
    return conversation?.scope === "session" ? conversation : null;
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
  const peekResolveApprovalMutation = useResolveApprovalMutation(
    peekProjectName,
    peekSessionName,
  );

  const peekApprovalGate = ((): PeekApprovalGate | null => {
    const standing = peekConversation?.pendingApproval ?? null;
    if (standing === null) return null;
    const contextId = standing.contextId;
    return {
      isSubmitting: peekResolveApprovalMutation.isPending,
      // The standing payload carries the suspension flag — the active
      // execution list omits halted executions, so it cannot be derived here.
      executionSuspended: standing.executionSuspended,
      onApprove: () => {
        peekResolveApprovalMutation.mutate({ contextId, decision: "approve" });
      },
      onReject: (message: string) => {
        peekResolveApprovalMutation.mutate({
          contextId,
          decision: "reject",
          message,
        });
      },
    };
  })();

  // Returns the fork promise so the triggering control (MessageActions' Fork
  // button inside the peek) can render its in-flight pending state.
  const handlePeekFork = useCallback(
    (messageIndex: number) => {
      if (peek === null || peekConversation === null) return;
      return peekForkMutation
        .mutateAsync({ conversationId: peek.conversationId, messageIndex })
        .then(({ conversationId }) => {
          closePeek();
          if (onMobileClose) onMobileClose();
          openSessionScopedConversation(
            {
              conversationId,
              projectName: peekConversation.projectName,
              sessionName: peekConversation.sessionName,
            },
            conversationsPageHref({ conversationId }),
          );
        });
    },
    [
      closePeek,
      onMobileClose,
      peek,
      peekConversation,
      peekForkMutation,
      openSessionScopedConversation,
    ],
  );

  const sessionScope = useMemo(
    () => sidebarSessionFilter ?? { projectName, sessionName },
    [projectName, sessionName, sidebarSessionFilter],
  );

  const filterCounts = useMemo(() => {
    const openRows = activeRows.filter(
      (row) => !isClosedProjectConversation(row),
    );
    const { approvals, questions, finished } = splitNeedsYou(openRows);
    return {
      all: activeRows.length,
      needs: approvals.length + questions.length + finished.length,
      running: openRows.filter((row) => row.status === "running").length,
      session: activeRows.filter(
        (row) =>
          row.scope === "session" &&
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

  // Builds the right-click menu items for a given row (used by each row's
  // ContextMenu in renderRow). Defined before renderRow so it can be a stable
  // dependency.
  const buildRowItems = useCallback(
    (
      row: ActiveSidebarConversation & { archived?: boolean },
      actionScope: ActiveRowActionScope,
    ): ConversationRowMenuItem[] => {
      const archived = row.archived === true;
      const descriptor = describeActiveRow(row);
      const href = descriptor.href;
      const projectHref = `/projects/${encodeURIComponent(row.projectName)}`;
      const items: ConversationRowMenuItem[] = [
        {
          kind: "item",
          label: "Open conversation",
          hotkey: "Enter",
          onSelect: () => {
            if (row.scope === "session") {
              openSessionScopedConversation(
                {
                  conversationId: row.id,
                  projectName: row.projectName,
                  sessionName: row.sessionName,
                },
                href,
              );
            } else {
              router.push(href);
            }
            if (onMobileClose) onMobileClose();
          },
        },
        ...(row.scope === "session" && onOpenInTab
          ? [
              {
                kind: "item" as const,
                label: "Open in New Tab",
                onSelect: () => {
                  onOpenInTab({
                    conversationId: row.id,
                    projectName: row.projectName,
                    sessionName: row.sessionName,
                  });
                  if (onMobileClose) onMobileClose();
                },
              },
            ]
          : []),
        ...(row.scope === "session" && onOpenInPane
          ? [
              {
                kind: "item" as const,
                label: "Open in New Pane",
                onSelect: () => {
                  onOpenInPane({
                    conversationId: row.id,
                    projectName: row.projectName,
                    sessionName: row.sessionName,
                  });
                  if (onMobileClose) onMobileClose();
                },
              },
            ]
          : []),
        { kind: "divider" },
        {
          kind: "item",
          label: "Open project page",
          onSelect: () => {
            router.push(projectHref);
            if (onMobileClose) onMobileClose();
          },
        },
        ...(row.scope === "session"
          ? [
              {
                kind: "item" as const,
                label:
                  activeListFilter === "session" &&
                  sessionScope.projectName === row.projectName &&
                  sessionScope.sessionName === row.sessionName
                    ? `Filtered to ${row.sessionName}`
                    : `Filter sidebar to session: ${row.sessionName}`,
                disabled:
                  activeListFilter === "session" &&
                  sessionScope.projectName === row.projectName &&
                  sessionScope.sessionName === row.sessionName,
                onSelect: () => {
                  setSidebarSessionFilter({
                    projectName: row.projectName,
                    sessionName: row.sessionName,
                  });
                  setActiveListFilter("session");
                },
              },
              {
                kind: "item" as const,
                label: "Copy branch name",
                disabled: row.branchName === null,
                onSelect: () => {
                  if (row.branchName === null) return;
                  void navigator.clipboard.writeText(row.branchName);
                },
              },
            ]
          : []),
        {
          kind: "item",
          label: "Copy worktree path",
          onSelect: () => {
            void navigator.clipboard.writeText(row.worktreePath);
          },
        },
        ...(row.scope === "session"
          ? [
              {
                kind: "item" as const,
                label: "Copy context",
                hotkey: "⌘⇧C",
                onSelect: () => {
                  void handleCopyContext(row);
                },
              },
            ]
          : []),
        { kind: "divider" },
        {
          kind: "item",
          label: "Rename…",
          onSelect: () => {
            handleRenameStart(
              row.id,
              row.name ?? row.summary ?? "",
              actionScope,
            );
          },
        },
        // While an approval gate is pending the row must stay visible and
        // actionable in Needs Input, so the archive affordance is withheld.
        ...(row.pendingApproval === null
          ? [
              {
                kind: "item" as const,
                label: archived
                  ? "Unarchive conversation"
                  : "Archive conversation",
                onSelect: () => {
                  handleArchive(row.id, !archived, actionScope);
                },
              },
            ]
          : []),
        ...(row.scope === "session"
          ? [
              {
                kind: "item" as const,
                label: "Archive session",
                onSelect: () => {
                  setPendingArchiveSession({
                    projectName: row.projectName,
                    sessionName: row.sessionName,
                  });
                },
              },
            ]
          : []),
      ];
      return items;
    },
    [
      activeListFilter,
      handleArchive,
      handleCopyContext,
      handleRenameStart,
      onMobileClose,
      onOpenInTab,
      onOpenInPane,
      openSessionScopedConversation,
      router,
      setActiveListFilter,
      setSidebarSessionFilter,
      sessionScope,
    ],
  );

  const renderRow = useCallback(
    <T extends ActiveSidebarConversation & Partial<{ archived: boolean }>>(
      row: AnnotatedSidebarConversation<T>,
    ) => {
      const isEditing = editingId === row.id;
      const isActive = row.id === activeConversationId;
      const closed = isClosedProjectConversation(row);
      const descriptor = describeActiveRow(row);
      const href = descriptor.href;

      if (isEditing) {
        return (
          <div key={row.id} className="relative mx-[8px] my-[1px]">
            <div
              className="relative flex w-full flex-col items-start gap-[5px] overflow-hidden rounded-md border border-solid border-border-dim bg-transparent px-md py-sm"
              data-status={row.status}
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
        // `contents` keeps the row as the flex item; Radix anchors the menu at
        // the cursor, so the trigger needs no box of its own.
        <ContextMenu key={row.id}>
          <ContextMenuTrigger className="contents">
            <SidebarRowItem
              row={row}
              conversation={row}
              href={href}
              isActive={isActive}
              activeConversationId={activeConversationId}
              closed={closed}
              onNavigate={() => {
                if (row.scope === "session") {
                  openSessionScopedConversation(
                    {
                      conversationId: row.id,
                      projectName: row.projectName,
                      sessionName: row.sessionName,
                    },
                    href,
                  );
                } else {
                  router.push(href);
                }
                if (onMobileClose) onMobileClose();
              }}
              onPeek={descriptor.supportsSessionPeek ? openPeek : undefined}
              onAcknowledge={
                row.scope === "session"
                  ? () => {
                      markReadMutation.mutate({
                        projectName: row.projectName,
                        sessionName: row.sessionName,
                        conversationId: row.id,
                      });
                    }
                  : () => {
                      markProjectReadMutation.mutate({
                        projectName: row.projectName,
                        conversationId: row.id,
                      });
                    }
              }
            />
          </ContextMenuTrigger>
          <ContextMenuContent>
            <ConversationRowMenuItems
              items={buildRowItems(row, descriptor.actionScope)}
            />
          </ContextMenuContent>
        </ContextMenu>
      );
    },
    [
      activeConversationId,
      buildRowItems,
      editValue,
      editingId,
      handleRenameSubmit,
      markReadMutation,
      markProjectReadMutation,
      onMobileClose,
      openPeek,
      openSessionScopedConversation,
      router,
    ],
  );

  const renderSections = useCallback(
    <T extends ActiveSidebarConversation & Partial<{ archived: boolean }>>(
      sections: SidebarSection<T>[],
    ) => {
      return sections.map((section) => {
        if (section.items.length === 0) return null;
        const isNeeds = section.kind === "needs";
        const isFinished = isNeeds && section.tone === "finished";
        const isClosedSection = section.kind === "closed";
        const headerClass = cn(
          "flex min-w-0 items-center gap-sm px-[12px] pb-[4px] font-mono text-[0.7rem] leading-[1.2] font-semibold tracking-[0.12em] uppercase",
          isNeeds ? "pt-[10px]" : "pt-[12px]",
          isFinished
            ? "text-green"
            : isNeeds
              ? "text-amber"
              : isClosedSection
                ? "text-text-tertiary"
                : "text-text-primary",
          !isNeeds &&
            "after:order-2 after:h-[1px] after:min-w-[16px] after:flex-1 after:[background-image:linear-gradient(to_right,var(--border-default),transparent)] after:content-['']",
        );
        const countClass = cn(
          "order-1 font-medium",
          isFinished
            ? "text-green-dim"
            : isNeeds
              ? "text-amber-dim"
              : "text-text-tertiary",
        );
        return (
          <section
            key={section.groupKey}
            className="flex flex-col"
            data-section-kind={section.kind}
            data-section-tone={section.tone ?? undefined}
          >
            <div className={headerClass}>
              {section.kind === "session" &&
              section.projectLabel !== undefined &&
              section.sessionLabel !== undefined ? (
                <span className="inline-flex min-w-0 items-baseline gap-[5px] overflow-hidden text-ellipsis whitespace-nowrap">
                  <span className="min-w-0 overflow-hidden text-ellipsis text-text-tertiary">
                    {section.projectLabel}
                  </span>
                  <span className="shrink-0 text-text-tertiary">/</span>
                  <span className="min-w-0 overflow-hidden text-ellipsis text-text-primary">
                    {section.sessionLabel}
                  </span>
                </span>
              ) : (
                <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">
                  {section.label}
                </span>
              )}
              <span className={countClass}>
                {section.kind === "needs"
                  ? `(${section.items.length})`
                  : section.items.length}
              </span>
            </div>
            <div>{section.items.map((row) => renderRow(row))}</div>
          </section>
        );
      });
    },
    [renderRow],
  );

  return (
    <>
      {/* Backdrop for mobile drawer */}
      <div
        className={cn(
          "hidden max-768:fixed max-768:inset-0 max-768:z-[89] max-768:bg-[var(--cc-bg-void-a60)] max-768:backdrop-blur-[4px]",
          mobileOpen && "max-768:block",
        )}
        onClick={onMobileClose}
      />
      <div
        className={cn(
          // `convo-sidebar` is kept as a structural hook: out-of-scope
          // conversation.css (`.convo-sidebar .convo-rename-input`, Stage B-4)
          // and the already-migrated ProjectCockpit (`[&_.convo-sidebar]`
          // overrides) both select it. The panel's own appearance is
          // utility-owned here.
          "convo-sidebar flex flex-col overflow-hidden rounded-none border-y-0 border-r border-l-0 border-solid bg-bg-base transition-[width,min-width,border-right-color] duration-200 ease-[ease]",
          effectiveCollapsed
            ? "w-0 min-w-0 border-r-transparent"
            : "w-[var(--convo-sidebar-w)] min-w-[var(--convo-sidebar-w)] border-border-default",
          "max-768:fixed max-768:top-[var(--topbar-height)] max-768:bottom-[56px] max-768:left-0 max-768:z-[90] max-768:rounded-none max-768:border-border-default max-768:bg-bg-surface max-768:transition-transform max-768:duration-[250ms] max-768:ease-[ease]",
          effectiveCollapsed
            ? "max-768:w-[280px] max-768:min-w-[280px]"
            : "max-768:w-[308px] max-768:min-w-[308px]",
          mobileOpen ? "max-768:translate-x-0" : "max-768:-translate-x-full",
        )}
      >
        <div className="mb-header-content flex min-h-[28px] items-center justify-between gap-xs border-x-0 border-t-0 border-b border-solid border-border-subtle px-[10px] pt-[10px] pb-[8px]">
          <span className="inline-flex min-w-0 items-baseline gap-[5px] overflow-hidden font-mono text-[0.72rem] leading-[1.2] font-semibold tracking-[0.1em] whitespace-nowrap text-text-secondary uppercase">
            Active Conversations{" "}
            <span className="font-medium text-text-tertiary">
              ({filterCounts.all})
            </span>
          </span>
          <div className="ml-auto flex items-center gap-xs">
            {showNewConversationButton && (
              <button
                className="relative flex size-[28px] shrink-0 cursor-pointer items-center justify-center rounded-sm border border-solid border-transparent bg-transparent p-0 text-[1rem] font-medium text-cyan transition-[color,background-color,border-color] duration-150 ease-[ease] hover:border-cyan-dim hover:bg-[var(--cc-cyan-a10)] hover:text-text-primary disabled:cursor-not-allowed disabled:text-text-tertiary disabled:opacity-50 max-768:size-[44px] [&>svg]:size-[18px]"
                onClick={handleNewConversation}
                disabled={createConvoMutation.isPending}
                aria-busy={createConvoMutation.isPending || undefined}
                data-tooltip="New conversation"
                aria-label="New conversation"
              >
                {createConvoMutation.isPending ? (
                  <Spinner size="sm" tone="inherit" />
                ) : (
                  <PlusIcon />
                )}
              </button>
            )}
            {showCollapseControl && (
              <button
                // Legacy parity: `.convo-sidebar-toggle{display:none}` at
                // max-768 was overridden by the later-sourced unlayered
                // `.btn-icon-only{display:flex}`, so the collapse toggle in fact
                // stayed visible on mobile and inherited the `.btn-icon-only`
                // 44px/1rem touch enlargement.
                className="relative flex size-[30px] shrink-0 cursor-pointer items-center justify-center rounded-sm border border-solid border-border-default bg-transparent p-0 text-[0.7rem] text-text-tertiary transition-all duration-150 ease-[ease] hover:border-border-strong hover:bg-bg-hover hover:text-text-primary max-768:size-[44px] max-768:text-[1rem]"
                onClick={toggleCollapsed}
                data-tooltip="Collapse sidebar"
              >
                {"\u25C0"}
              </button>
            )}
            <button
              // `data-sidebar-close` is the hook ProjectCockpit uses to hide
              // this drawer-close button in its embedded mobile rail pane.
              data-sidebar-close=""
              className="hidden size-[30px] shrink-0 cursor-pointer items-center justify-center rounded-sm border border-solid border-border-default bg-transparent p-0 text-[0.85rem] text-text-secondary max-768:flex max-768:size-[44px]"
              onClick={onMobileClose}
              data-tooltip="Close"
            >
              &#10005;
            </button>
          </div>
        </div>
        {(!effectiveCollapsed || mobileOpen) && (
          <>
            <div className="flex flex-col gap-sm border-x-0 border-t-0 border-b border-solid border-border-subtle px-[12px] py-[8px]">
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

            <div className="flex flex-1 flex-col gap-0 overflow-y-auto bg-bg-base pt-[8px] pb-[16px]">
              <ActiveWorkSection
                items={activeWorkItems}
                attention={attentionItems}
                nowMs={nowMs}
                onAction={handleActiveWorkAction}
                onDismissAttention={handleDismissAttention}
              />
              {hasConversationResults
                ? renderSections(sidebarSections)
                : activeWorkItems.length === 0 &&
                  attentionItems.length === 0 && (
                    <div className="px-md py-lg text-center font-mono text-[0.72rem] leading-[1.6] text-text-tertiary">
                      {sidebarFilter
                        ? "No matches."
                        : "No active conversations."}
                      <span className="mt-xs block text-[0.7rem] opacity-[0.7]">
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
      {peek !== null && peekConversation !== null && (
        <PeekPopover
          anchorEl={peek.anchorEl}
          conversation={peekConversation}
          transcriptMessages={peekMessagesQuery.data ?? []}
          onClose={closePeek}
          onOpenFull={() => {
            openSessionScopedConversation(
              {
                conversationId: peekConversation.id,
                projectName: peekConversation.projectName,
                sessionName: peekConversation.sessionName,
              },
              conversationsPageHref({ conversationId: peekConversation.id }),
            );
            if (onMobileClose) onMobileClose();
            closePeek();
          }}
          onReplyText={(text) => {
            peekReplyMutation.mutate(text);
          }}
          isSendingReply={peekReplyMutation.isPending}
          onAnswerQuestion={(answers) => {
            peekAnswerMutation.mutate({
              questionId:
                peekConversation.pendingQuestionId ?? peekConversation.id,
              answers,
            });
          }}
          onFork={handlePeekFork}
          approvalGate={peekApprovalGate}
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
