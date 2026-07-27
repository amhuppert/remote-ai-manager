"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { ConversationState } from "@/lib/conversations/schemas";
import { selectLastUserTurnAgentSettings } from "@/lib/conversations/last-turn-agent-settings";
import type { SessionListItem } from "@/lib/sessions/schemas";
import type { AgentBackendId } from "@/lib/shared/schemas";
import type { BackendSelectionDefaultsById } from "@/lib/agent-backends/conversation-policy";
import { Tabs, Tab, TabCount } from "@/components/ui/Tabs";
import { IconButton } from "@/components/ui/IconButton";
import { WithTooltip } from "@/components/ui/WithTooltip";
import ConfirmDialog from "@/components/ConfirmDialog";
import { useQuickTicketConversationRegistration } from "@/components/quick-ticket/useQuickTicketConversationRegistration";
import { useAppHotkey } from "@/hooks/useAppHotkey";
import { cn } from "@/lib/ui/cn";
import type { SerializedPromptDoc } from "@/lib/prompt-editor";
import { createClientLogger } from "@/lib/logging/client-logger";
import { pushToast } from "@/stores/toast.store";
import {
  useSendProjectPrompt,
  useCreateProjectConversation,
  useCloseProjectConversation,
  useQueueProjectMessage,
  conversationTurnKey,
  type ConversationTurnKey,
  type ProjectConversationCreation,
  type ProjectTurnKey,
} from "@/lib/project-conversations-client/mutations";
import type {
  UnifiedComposerSendInput,
  UnifiedComposerSendResult,
} from "../composer/UnifiedComposer";
import { useProjectConversationMessagesQuery } from "@/lib/project-conversations-client/queries";
import { canStopTurn } from "@/lib/conversations/turn-activity";
import { useConversationSpawnCards } from "@/features/project-detail/spawn-card/useConversationSpawnCards";
import { useOrderedConversationHotkeys } from "@/hooks/use-ordered-conversation-hotkeys";
import {
  scheduleActivePromptFocus,
  shouldRestoreActivePromptFocus,
} from "@/lib/hotkeys/prompt-focus";
import type { FilterToken } from "../components/filter-tokens";
import ConversationTabs, { type ConversationTabItem } from "./ConversationTabs";
import ConversationPane from "./ConversationPane";
import ProjectQuestionSlot from "./ProjectQuestionSlot";
import ProjectTranscriptHost from "./ProjectTranscriptHost";
import MainDiffSurface from "./MainDiffSurface";
import SessionsPanel from "./SessionsPanel";
import UnifiedComposer from "../composer/UnifiedComposer";
import {
  useOpenTabIds,
  useActiveTabId,
  useEntering,
  useRailCollapsed,
  useReconcileTabs,
  useSetActiveTab,
  useFocusTab,
  useWorkspaceView,
  useSetWorkspaceView,
  useBeginCloseTab,
  useRestoreCloseSnapshot,
  useToggleRail,
  useSetRailCollapsed,
} from "./use-cockpit-view-state";
import {
  deleteProjectDraft,
  hasProjectDraftContent,
  projectDraftKey,
  setProjectDraft,
  type ProjectDraftMap,
} from "./project-draft-map";
// Imported for the preserved `plc-rise-fade` entry keyframe (referenced by the
// cockpit's entry-animation utility) and the preserved diff slide-over residual.
import "./styles/cockpit.css";

export interface ProjectCockpitProps {
  projectName: string;
  /** Open project conversations from the foundation (server truth). */
  openConversations: ConversationState[];
  /**
   * Every conversation the project has with the creation it records — open,
   * closed, and archived. The second of the two sources that can name the
   * conversation a create-and-send turn created; see `noticeConversations`.
   */
  conversationCreations: ProjectConversationCreation[];
  sessions: SessionListItem[];
  archivedCount: number;
  /** Shared filter-token state (also driven by the composer's filter mode). */
  tokens: FilterToken[];
  onTokensChange: (next: FilterToken[]) => void;
  onRunCommand: (id: "new" | "capabilities" | "workflow-builder") => void;
  /** Pre-init backend selection (claude/codex); fixed once initialized. */
  selectedBackend: AgentBackendId;
  backendDefaults: BackendSelectionDefaultsById;
  onSelectedBackendChange: (next: AgentBackendId) => void;
  onBranch?: (sessionName: string) => void;
  /** The global Active Conversations rail, mounted as the left column. */
  rail: ReactNode;
}

type MobilePane = "chat" | "rail";

const MOBILE_PANES: { id: MobilePane; label: string }[] = [
  { id: "chat", label: "Chat" },
  { id: "rail", label: "List" },
];

// Shell grid: a primary view switch across the top and either the sessions
// table or the rail+conversation workspace below. `--plc-rail-w` collapses the
// rail column; the sessions view drops to a single column. The ≤768px spine
// flips to a single-panel flex column (desktop-first `max-768:`). `group` lets
// the panes read the cockpit's data-* state.
const COCKPIT_CLASS =
  "group grid flex-1 min-h-0 h-full items-stretch " +
  "[--plc-rail-w:clamp(260px,20vw,308px)] [grid-template-columns:var(--plc-rail-w)_minmax(0,1fr)] " +
  "[grid-template-rows:auto_minmax(0,1fr)] [grid-template-areas:'view_view'_'rail_conversation'] " +
  "data-[rail-collapsed=true]:[--plc-rail-w:48px] " +
  "data-[workspace-view=sessions]:[grid-template-columns:minmax(0,1fr)] " +
  "data-[workspace-view=sessions]:[grid-template-areas:'view'_'sessions'] " +
  "max-768:flex max-768:flex-col max-768:min-h-0";

// 8px rise + fade over .2s; `forwards` is required because the cockpit is a
// `.stagger-in > *` child with a resting opacity:0 — without it the cockpit
// reverts to invisible once the animation ends. Reduced motion settles visible.
const ENTER_CLASS =
  "animate-[plc-rise-fade_0.2s_ease_forwards] motion-reduce:animate-none motion-reduce:opacity-100";

const VIEW_SWITCH_LAYOUT =
  "col-start-1 col-span-2 row-start-1 justify-self-start mx-md mb-sm max-768:self-stretch max-768:shrink-0";

// On the mobile spine the view/pane tabs become a centred, equal-width, 36px
// touch target (legacy `.plc-view-switch .cc-tab` / `.plc-mobile-switch .cc-tab`
// at max-768). The equal-split geometry is `flex: 1` = `1 1 0%`, reproduced as
// `grow shrink basis-0` (NOT `grow` alone — its `basis:auto` would weight tab
// widths by label length). The centring + 36px min-height are appearance the Tab
// primitive owns via its `fill` prop; `layoutClassName` carries only this
// allowlisted external geometry (docs/tailwind-conventions.md §2).
const TAB_FILL_LAYOUT = "max-768:grow max-768:shrink max-768:basis-0";

const MOBILE_SWITCH_WRAP =
  "hidden max-768:group-data-[workspace-view=conversations]:block mx-md mb-sm shrink-0";

const RAIL_CLASS =
  "[grid-area:rail] flex flex-col min-w-0 min-h-0 h-full overflow-hidden " +
  "border-y-0 border-l-0 border-r border-solid border-border-subtle bg-bg-base " +
  "[&>.convo-sidebar]:flex-1 [&>.convo-sidebar]:min-h-0 [&>.convo-sidebar]:h-auto " +
  // The injected ConversationSidebar carries the session-page shell's own
  // `--convo-sidebar-w` width/min-width (340px floor), but the cockpit rail
  // column is `--plc-rail-w` (≤308px). Pin the embedded sidebar to the rail
  // column so its content isn't clipped by this pane's `overflow-hidden`.
  "[&>.convo-sidebar]:w-full [&>.convo-sidebar]:min-w-0 " +
  "max-768:hidden max-768:group-data-[mobile-pane=rail]:flex " +
  "max-768:group-data-[mobile-pane=rail]:flex-1 max-768:group-data-[mobile-pane=rail]:w-full " +
  "max-768:group-data-[mobile-pane=rail]:border-r-0 " +
  // The embedded rail is an in-flow cockpit pane, not the session page's
  // slide-out drawer — undo the fixed-position drawer treatment on the injected
  // ConversationSidebar at the mobile rail pane.
  "max-768:group-data-[mobile-pane=rail]:[&_.convo-sidebar]:static " +
  "max-768:group-data-[mobile-pane=rail]:[&_.convo-sidebar]:transform-none " +
  "max-768:group-data-[mobile-pane=rail]:[&_.convo-sidebar]:transition-none " +
  "max-768:group-data-[mobile-pane=rail]:[&_.convo-sidebar]:flex-1 " +
  "max-768:group-data-[mobile-pane=rail]:[&_.convo-sidebar]:min-h-0 " +
  "max-768:group-data-[mobile-pane=rail]:[&_.convo-sidebar]:w-full " +
  "max-768:group-data-[mobile-pane=rail]:[&_.convo-sidebar]:min-w-0 " +
  "max-768:group-data-[mobile-pane=rail]:[&_.convo-sidebar]:h-auto " +
  "max-768:group-data-[mobile-pane=rail]:[&_.convo-sidebar]:border-r-0 " +
  "max-768:group-data-[mobile-pane=rail]:[&_.convo-sidebar]:z-auto " +
  // The host-owned collapse toggle and the drawer close button are meaningless
  // when the rail is the only visible pane.
  "max-768:group-data-[mobile-pane=rail]:[&_[data-sidebar-close]]:hidden";

const RAIL_TOGGLE_ROW_CLASS =
  "flex justify-end shrink-0 max-768:group-data-[mobile-pane=rail]:hidden";

const WORKSPACE_PANE_CLASS =
  "[grid-area:conversation] flex min-w-0 min-h-0 h-full overflow-hidden " +
  "max-768:hidden max-768:group-data-[mobile-pane=chat]:flex " +
  "max-768:group-data-[mobile-pane=chat]:flex-1 max-768:group-data-[mobile-pane=chat]:min-h-0";

const PANE_CLASS =
  "flex-1 flex flex-col min-h-0 min-w-0 h-full bg-bg-surface overflow-hidden";

const PANE_EMPTY_CLASS =
  "flex-1 min-h-0 flex flex-col items-center justify-center gap-xs px-lg py-xl text-center";

const PANE_COMPOSER_CLASS =
  "shrink-0 px-md py-md max-768:py-sm border-x-0 border-b-0 border-t border-solid border-border-dim bg-bg-base";

const logger = createClientLogger("project-cockpit");

function ChevronGlyph({ dir }: { dir: "left" | "right" }): React.JSX.Element {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={dir === "left" ? "m15 18-6-6 6-6" : "m9 18 6-6-6-6"} />
    </svg>
  );
}

/**
 * The project cockpit and the project page's always-on shell: a full-height
 * Active Conversations rail (collapsible, injected as a slot) and transcript
 * workspace, plus the sessions table behind a primary view switch. The rail is
 * mounted regardless of open-conversation count so closed conversations stay
 * reachable; with no open conversations the pane shows a create-a-conversation
 * composer instead of the tab strip. Tab membership is reconciled against the
 * server open list; the store layers ordering, active selection, workspace
 * view, rail-collapse, and the entry animation.
 */
export default function ProjectCockpit({
  projectName,
  openConversations,
  conversationCreations,
  sessions,
  archivedCount,
  tokens,
  onTokensChange,
  onRunCommand,
  selectedBackend,
  backendDefaults,
  onSelectedBackendChange,
  onBranch,
  rail,
}: ProjectCockpitProps): React.JSX.Element {
  const openTabIds = useOpenTabIds();
  const activeTabId = useActiveTabId();
  const entering = useEntering();
  const workspaceView = useWorkspaceView();
  const railCollapsed = useRailCollapsed();
  const reconcile = useReconcileTabs();
  const setActiveTab = useSetActiveTab();
  const focusTab = useFocusTab();
  const setWorkspaceView = useSetWorkspaceView();
  const beginCloseTab = useBeginCloseTab();
  const restoreCloseSnapshot = useRestoreCloseSnapshot();
  const toggleRail = useToggleRail();
  const setRailCollapsed = useSetRailCollapsed();
  const [drafts, setDrafts] = useState<ProjectDraftMap>(() => new Map());
  const [closeConfirmTargetId, setCloseConfirmTargetId] = useState<
    string | null
  >(null);
  const restorePromptFocusAfterCloseRef = useRef(false);

  const [mobilePane, setMobilePane] = useState<MobilePane>("chat");
  const handleMobilePane = useCallback(
    (pane: MobilePane) => {
      setMobilePane(pane);
      // A collapsed rail renders no content; opening the rail pane on mobile
      // must always show the conversations list.
      if (pane === "rail") setRailCollapsed(false);
    },
    [setRailCollapsed],
  );

  // Focusing a conversation (rail tap, `?focus=` param, new tab) must surface
  // the chat pane on mobile — otherwise the selection happens invisibly behind
  // the rail pane.
  const [prevActiveTabId, setPrevActiveTabId] = useState(activeTabId);
  if (prevActiveTabId !== activeTabId) {
    setPrevActiveTabId(activeTabId);
    setMobilePane("chat");
  }

  const sender = useSendProjectPrompt(projectName, {
    // The turn's conversation now exists, so its tab is where the turn reports
    // from here on — opening it immediately is what makes releasing the
    // provisional key a handover rather than a gap.
    onConversationAdopted: focusTab,
  });
  const createConversation = useCreateProjectConversation(projectName);
  const closeConversation = useCloseProjectConversation(projectName);
  const queueMessage = useQueueProjectMessage(projectName);

  const serverOpenIds = useMemo(
    () => openConversations.map((c) => c.id),
    [openConversations],
  );

  // The conversation list is the second of the two sources that can name the
  // conversation a create-and-send turn created — the first being that turn's
  // own request stream. Whichever arrives first adopts the turn.
  //
  // It reports every conversation, not the open subset, and each one's recorded
  // creation rather than its id alone: a conversation names a pending turn by
  // carrying that turn's submission token. Membership would not do — a reopened
  // conversation, another tab's creation, and a first fetch that has only just
  // resolved all look equally new to this client.
  //
  // Tab reconciliation is unaffected — it tracks the open list exactly as the
  // server currently reports it.
  const noticeConversations = sender.noticeConversations;
  useEffect(() => {
    reconcile(serverOpenIds);
  }, [reconcile, serverOpenIds]);
  useEffect(() => {
    noticeConversations(conversationCreations);
  }, [noticeConversations, conversationCreations]);

  const byId = useMemo(
    () => new Map(openConversations.map((c) => [c.id, c])),
    [openConversations],
  );

  const tabs = useMemo<ConversationTabItem[]>(
    () =>
      openTabIds.flatMap((id) => {
        const conv = byId.get(id);
        if (!conv) return [];
        return [
          {
            id: conv.id,
            name: conv.name ?? "Conversation",
            unread: conv.unread,
            agent: conv.agentBackend,
            status: conv.status,
          },
        ];
      }),
    [openTabIds, byId],
  );
  const orderedTabIds = useMemo(() => tabs.map((tab) => tab.id), [tabs]);
  useOrderedConversationHotkeys({
    orderedIds: orderedTabIds,
    activeId: activeTabId,
    activate: setActiveTab,
    enabled: workspaceView === "conversations",
  });

  const activeConversation =
    activeTabId !== null ? byId.get(activeTabId) : undefined;
  useQuickTicketConversationRegistration(
    activeConversation === undefined
      ? null
      : {
          projectName,
          sessionName: null,
          conversationId: activeConversation.id,
          title:
            activeConversation.name ??
            activeConversation.summary ??
            "Conversation",
        },
  );
  // Backend is fixed to the conversation's once initialized (promptCount > 0);
  // before the first turn it tracks the user's pre-init selection so the
  // composer toggle works for new tabs (Req 7.3).
  const backendLocked = (activeConversation?.promptCount ?? 0) > 0;
  const agentBackend =
    backendLocked && activeConversation
      ? activeConversation.agentBackend
      : selectedBackend;

  // Source the inline spawn cards from the active conversation's transcript.
  // The query shares its key with the transcript host, so this is the same
  // fetch — no extra request — and re-derives the cards from the messages.
  const messagesQuery = useProjectConversationMessagesQuery(
    projectName,
    activeTabId,
  );
  const messages = useMemo(
    () => messagesQuery.data ?? [],
    [messagesQuery.data],
  );
  const lastUserTurnAgentSettings = useMemo(
    () => selectLastUserTurnAgentSettings(messages),
    [messages],
  );
  const { spawnCards, renderSpawnCardRow } = useConversationSpawnCards({
    projectName,
    conversationId: activeTabId,
    messages,
    sessions,
    backendDefaults,
  });

  const handleNewChat = useCallback(() => {
    createConversation.mutate(
      { agentBackend: selectedBackend },
      { onSuccess: (conv) => focusTab(conv.id) },
    );
  }, [createConversation, selectedBackend, focusTab]);

  useAppHotkey("newConversation", handleNewChat, {
    enabled: !createConversation.isPending,
  });
  useAppHotkey("viewSessions", () => setWorkspaceView("sessions"));
  useAppHotkey("viewConversation", () => setWorkspaceView("conversations"));
  useAppHotkey("toggleSidebar", toggleRail, {
    enabled: workspaceView === "conversations",
  });

  const persistClose = useCallback(
    (id: string) => {
      const restorePromptFocus = restorePromptFocusAfterCloseRef.current;
      const snapshot = beginCloseTab(id);
      if (snapshot === null) {
        restorePromptFocusAfterCloseRef.current = false;
        return;
      }
      if (restorePromptFocus) scheduleActivePromptFocus();
      logger.info("project.conversation_tab.close_started", {
        projectName,
        conversationId: id,
      });
      closeConversation.mutate(id, {
        onSuccess: () => {
          setDrafts((current) => deleteProjectDraft(current, id));
          restorePromptFocusAfterCloseRef.current = false;
          logger.info("project.conversation_tab.close_succeeded", {
            projectName,
            conversationId: id,
          });
        },
        onError: (error) => {
          restoreCloseSnapshot(snapshot);
          if (restorePromptFocus) scheduleActivePromptFocus();
          restorePromptFocusAfterCloseRef.current = false;
          pushToast(
            "Couldn’t close conversation. The tab and draft were restored.",
          );
          logger.error("project.conversation_tab.close_failed", {
            projectName,
            conversationId: id,
            errorName: error.name,
            errorMessage: error.message,
          });
        },
      });
    },
    [beginCloseTab, closeConversation, projectName, restoreCloseSnapshot],
  );

  const requestClose = useCallback(
    (id: string) => {
      if (closeConversation.isPending) return;
      const document = drafts.get(id);
      if (document && hasProjectDraftContent(document)) {
        setCloseConfirmTargetId(id);
        return;
      }
      persistClose(id);
    },
    [closeConversation.isPending, drafts, persistClose],
  );

  useAppHotkey(
    "closeConversationTab",
    (event, invocation) => {
      restorePromptFocusAfterCloseRef.current = shouldRestoreActivePromptFocus(
        event.target,
        invocation.context,
      );
      if (activeTabId !== null) requestClose(activeTabId);
    },
    {
      enabled:
        workspaceView === "conversations" &&
        activeTabId !== null &&
        !closeConversation.isPending,
    },
  );

  const composerDraftKey = projectDraftKey(activeTabId);
  const initialComposerDocument = drafts.get(composerDraftKey);
  const handleComposerDocumentChange = useCallback(
    (document: SerializedPromptDoc) => {
      setDrafts((current) =>
        hasProjectDraftContent(document)
          ? setProjectDraft(current, composerDraftKey, document)
          : deleteProjectDraft(current, composerDraftKey),
      );
    },
    [composerDraftKey],
  );

  // A create-and-send turn has no tab to report on until the conversation it
  // created exists, so until then the composer reads it under the provisional
  // key that submission allocated.
  const pendingCreateKey = sender.pendingCreateKey;
  const composerTurnKey = useMemo<ProjectTurnKey | null>(
    () =>
      activeTabId !== null
        ? conversationTurnKey(activeTabId)
        : pendingCreateKey,
    [activeTabId, pendingCreateKey],
  );

  const clearPromptError = sender.clearError;
  const handleDismissError = useCallback(() => {
    clearPromptError(composerTurnKey);
  }, [clearPromptError, composerTurnKey]);

  // A turn is active when this tab's own submission is streaming OR the server
  // reports the conversation running — a turn started before a reload, from
  // another client, or by a drained queued message. Reading only this tab's flag
  // would send a direct prompt into a busy conversation and lose it to a 409.
  //
  // Both halves are read from THIS conversation, never the project: a sibling
  // conversation running is not a reason to queue here, and treating it as one
  // would reintroduce the cross-conversation block the cockpit removed.
  const turnActive =
    sender.isSending(composerTurnKey) ||
    activeConversation?.status === "running";

  const queueTurnState = useMemo(
    () => ({
      pendingQueue: activeConversation?.pendingQueue ?? [],
      running: turnActive,
    }),
    [activeConversation?.pendingQueue, turnActive],
  );

  const queueProjectMessage = queueMessage.queue;
  const sendPrompt = sender.send;
  const handleSendPrompt = useCallback(
    async (
      input: UnifiedComposerSendInput,
    ): Promise<UnifiedComposerSendResult> => {
      // Queue rather than send when this conversation already has a turn in
      // flight; a conversation that does not exist yet has nothing to queue into.
      if (turnActive && activeTabId !== null) {
        const queued = await queueProjectMessage({
          conversationId: activeTabId,
          text: input.text,
          ...(input.images.length > 0 ? { images: input.images } : {}),
        });
        return queued ? "accepted" : "rejected";
      }

      const submission = sendPrompt({
        target:
          activeTabId !== null
            ? conversationTurnKey(activeTabId)
            : { kind: "create" },
        text: input.text,
        images: input.images,
        backend: input.backend,
        modelId: input.modelId,
        ...(input.effort !== undefined ? { effort: input.effort } : {}),
      });
      return (await submission.accepted) ? "accepted" : "rejected";
    },
    [turnActive, activeTabId, queueProjectMessage, sendPrompt],
  );

  // Stop is offered for the conversation on screen and stops that conversation,
  // so a turn running in a background tab is never what the button reaches. The
  // same gate the session header uses: this tab's own keyed sending flag, or a
  // server-running turn this client did not start (another tab, or a reload).
  const activeTurnKey = useMemo<ConversationTurnKey | null>(
    () => (activeTabId !== null ? conversationTurnKey(activeTabId) : null),
    [activeTabId],
  );
  const canStop = canStopTurn({
    sending: sender.isSending(activeTurnKey),
    status: activeConversation?.status,
    // Graph workflow execution at project scope is a spec non-goal, so no
    // project turn is workflow-driven; reading the field keeps the gate shared
    // rather than forking a project-only rule.
    drivenByWorkflow: activeConversation?.activeTurnSource === "workflow",
  });
  const abortTurn = sender.abort;
  const handleStop = useCallback(() => {
    if (activeTurnKey === null) return;
    void abortTurn(activeTurnKey);
  }, [abortTurn, activeTurnKey]);

  const transcript = activeTabId ? (
    <ProjectTranscriptHost
      projectName={projectName}
      conversationId={activeTabId}
      selectedBackend={agentBackend}
      spawnCards={spawnCards}
      renderSpawnCardRow={renderSpawnCardRow}
      pendingQueue={queueTurnState.pendingQueue}
      {...(activeConversation ? { status: activeConversation.status } : {})}
    />
  ) : null;

  const composerInput = (
    <UnifiedComposer
      projectName={projectName}
      activeConversationId={activeTabId}
      activeConversation={activeConversation}
      agentBackend={agentBackend}
      backendDefaults={backendDefaults}
      onAgentChange={onSelectedBackendChange}
      tokens={tokens}
      onTokensChange={onTokensChange}
      sessions={sessions}
      archivedCount={archivedCount}
      busy={sender.isSending(composerTurnKey)}
      error={sender.errorFor(composerTurnKey)}
      onDismissError={handleDismissError}
      lastUsedModelId={lastUserTurnAgentSettings.modelId}
      lastUsedEffort={lastUserTurnAgentSettings.effort}
      initialDocument={initialComposerDocument}
      onDocumentChange={handleComposerDocumentChange}
      onRunCommand={onRunCommand}
      onSendPrompt={handleSendPrompt}
      queueTurnState={queueTurnState}
    />
  );

  // A pending question takes the composer's place, exactly as it does on the
  // session page. It is hydrated from the active conversation's persisted
  // fields, so it is there after a reload and on whichever client opens the tab.
  const composer = (
    <ProjectQuestionSlot
      projectName={projectName}
      conversation={activeConversation}
      agentBackend={agentBackend}
      composer={composerInput}
    />
  );

  const pane =
    tabs.length > 0 ? (
      <ConversationPane
        agentBackend={agentBackend}
        projectName={projectName}
        canStop={canStop}
        onStop={handleStop}
        {...(activeConversation ? { status: activeConversation.status } : {})}
        tabs={
          <ConversationTabs
            tabs={tabs}
            activeTabId={activeTabId}
            onSelect={setActiveTab}
            onClose={requestClose}
            onNewChat={handleNewChat}
            creating={createConversation.isPending}
          />
        }
        transcript={transcript}
        composer={composer}
        diffSurface={<MainDiffSurface projectName={projectName} />}
      />
    ) : (
      <section className={PANE_CLASS} data-agent={agentBackend}>
        <div className={PANE_EMPTY_CLASS}>
          <p className="m-0 font-semibold text-text-secondary">
            No open conversations
          </p>
          <p className="m-0 max-w-[42ch] leading-[1.5] text-text-tertiary">
            Send a prompt to start a new conversation, or reopen a closed one
            from the rail.
          </p>
        </div>
        <div className={PANE_COMPOSER_CLASS}>{composer}</div>
      </section>
    );
  const showingConversations = workspaceView === "conversations";
  const showingSessions = workspaceView === "sessions";

  return (
    <div
      className={cn(COCKPIT_CLASS, entering && ENTER_CLASS)}
      data-rail-collapsed={railCollapsed}
      data-workspace-view={workspaceView}
      data-mobile-pane={mobilePane}
    >
      <Tabs
        role="tablist"
        aria-label="Project view"
        layoutClassName={VIEW_SWITCH_LAYOUT}
      >
        <Tab
          type="button"
          role="tab"
          aria-selected={workspaceView === "sessions"}
          aria-controls="plc-sessions-panel"
          active={workspaceView === "sessions"}
          onClick={() => setWorkspaceView("sessions")}
          fill
          layoutClassName={TAB_FILL_LAYOUT}
        >
          Sessions
          <TabCount active={workspaceView === "sessions"}>
            {sessions.length}
          </TabCount>
        </Tab>
        <Tab
          type="button"
          role="tab"
          aria-selected={workspaceView === "conversations"}
          aria-controls="plc-conversation-workspace"
          active={workspaceView === "conversations"}
          onClick={() => setWorkspaceView("conversations")}
          fill
          layoutClassName={TAB_FILL_LAYOUT}
        >
          Conversations
          <TabCount active={workspaceView === "conversations"}>
            {openConversations.length}
          </TabCount>
        </Tab>
      </Tabs>
      <div className={MOBILE_SWITCH_WRAP}>
        <Tabs role="tablist" aria-label="Conversation pane">
          {MOBILE_PANES.map((pane) => (
            <Tab
              key={pane.id}
              type="button"
              role="tab"
              aria-selected={mobilePane === pane.id}
              active={mobilePane === pane.id}
              onClick={() => handleMobilePane(pane.id)}
              fill
              layoutClassName={TAB_FILL_LAYOUT}
            >
              {pane.label}
            </Tab>
          ))}
        </Tabs>
      </div>
      {showingConversations && (
        <>
          <div
            className={RAIL_CLASS}
            id="plc-conversation-list"
            data-collapsed={railCollapsed}
          >
            {railCollapsed ? (
              <div className="flex flex-col items-center py-sm">
                <WithTooltip label="Expand rail">
                  <IconButton
                    type="button"
                    variant="square"
                    aria-label="Expand conversations rail"
                    onClick={toggleRail}
                  >
                    <ChevronGlyph dir="right" />
                  </IconButton>
                </WithTooltip>
              </div>
            ) : (
              <>
                <div className={RAIL_TOGGLE_ROW_CLASS}>
                  <WithTooltip label="Collapse rail">
                    <IconButton
                      type="button"
                      variant="square"
                      aria-label="Collapse conversations rail"
                      onClick={toggleRail}
                    >
                      <ChevronGlyph dir="left" />
                    </IconButton>
                  </WithTooltip>
                </div>
                {rail}
              </>
            )}
          </div>
          <div
            id="plc-conversation-workspace"
            className={WORKSPACE_PANE_CLASS}
            role="tabpanel"
            aria-label="Conversations"
          >
            {pane}
          </div>
        </>
      )}
      {!showingConversations && (
        <div
          id="plc-conversation-workspace"
          role="tabpanel"
          aria-label="Conversations"
          hidden
        />
      )}
      <SessionsPanel
        id="plc-sessions-panel"
        hidden={!showingSessions}
        projectName={projectName}
        sessions={sessions}
        tokens={tokens}
        onTokensChange={onTokensChange}
        {...(onBranch ? { onBranch } : {})}
      />
      <ConfirmDialog
        open={closeConfirmTargetId !== null}
        title="Discard draft and close tab?"
        message={`Closing "${closeConfirmTargetId ? (byId.get(closeConfirmTargetId)?.name ?? "Conversation") : "Conversation"}" removes it from this working set and discards its unsent draft. Running work continues.`}
        confirmLabel="Discard draft and close"
        danger
        onConfirm={() => {
          const targetId = closeConfirmTargetId;
          setCloseConfirmTargetId(null);
          if (targetId !== null) persistClose(targetId);
        }}
        onCancel={() => {
          restorePromptFocusAfterCloseRef.current = false;
          setCloseConfirmTargetId(null);
        }}
      />
    </div>
  );
}
