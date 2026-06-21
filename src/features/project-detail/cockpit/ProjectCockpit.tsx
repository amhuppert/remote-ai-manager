"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { ConversationState } from "@/lib/conversations/schemas";
import { selectLastUserTurnAgentSettings } from "@/lib/conversations/last-turn-agent-settings";
import type { SessionListItem } from "@/lib/sessions/schemas";
import type { AgentBackendId } from "@/lib/shared/schemas";
import { Tabs, Tab, TabCount } from "@/components/ui/Tabs";
import { IconButton } from "@/components/ui/IconButton";
import { cn } from "@/lib/ui/cn";
import {
  useSendProjectPrompt,
  useCreateProjectConversation,
  useCloseProjectConversation,
} from "@/lib/project-conversations-client/mutations";
import { useProjectConversationMessagesQuery } from "@/lib/project-conversations-client/queries";
import { useConversationSpawnCards } from "@/features/_root/spawn-card/useConversationSpawnCards";
import type { FilterToken } from "../components/filter-tokens";
import ConversationTabs, { type ConversationTabItem } from "./ConversationTabs";
import ConversationPane from "./ConversationPane";
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
  useToggleRail,
  useSetRailCollapsed,
} from "./use-cockpit-view-state";
// Imported for the preserved `plc-rise-fade` entry keyframe (referenced by the
// cockpit's entry-animation utility) and the preserved diff slide-over residual.
import "./styles/cockpit.css";

export interface ProjectCockpitProps {
  projectName: string;
  /** Open project conversations from the foundation (server truth). */
  openConversations: ConversationState[];
  sessions: SessionListItem[];
  archivedCount: number;
  /** Shared filter-token state (also driven by the composer's filter mode). */
  tokens: FilterToken[];
  onTokensChange: (next: FilterToken[]) => void;
  onRunCommand: (id: "new" | "capabilities" | "workflow-builder") => void;
  /** Pre-init backend selection (claude/codex); fixed once initialized. */
  selectedBackend: AgentBackendId;
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
  "[--plc-rail-w:308px] [grid-template-columns:var(--plc-rail-w)_minmax(0,1fr)] " +
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
  sessions,
  archivedCount,
  tokens,
  onTokensChange,
  onRunCommand,
  selectedBackend,
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
  const toggleRail = useToggleRail();
  const setRailCollapsed = useSetRailCollapsed();

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

  const sender = useSendProjectPrompt(projectName);
  const createConversation = useCreateProjectConversation(projectName);
  const closeConversation = useCloseProjectConversation(projectName);

  const serverOpenIds = useMemo(
    () => openConversations.map((c) => c.id),
    [openConversations],
  );

  useEffect(() => {
    reconcile(serverOpenIds);
  }, [reconcile, serverOpenIds]);

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

  const activeConversation =
    activeTabId !== null ? byId.get(activeTabId) : undefined;
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
  });

  const handleNewChat = useCallback(() => {
    createConversation.mutate(
      { agentBackend: selectedBackend },
      { onSuccess: (conv) => focusTab(conv.id) },
    );
  }, [createConversation, selectedBackend, focusTab]);

  const handleClose = useCallback(
    (id: string) => {
      closeConversation.mutate(id);
    },
    [closeConversation],
  );

  const transcript = activeTabId ? (
    <ProjectTranscriptHost
      projectName={projectName}
      conversationId={activeTabId}
      selectedBackend={agentBackend}
      spawnCards={spawnCards}
      renderSpawnCardRow={renderSpawnCardRow}
      {...(activeConversation ? { status: activeConversation.status } : {})}
    />
  ) : null;

  const composer = (
    <UnifiedComposer
      projectName={projectName}
      activeConversationId={activeTabId}
      activeConversation={activeConversation}
      agentBackend={agentBackend}
      onAgentChange={onSelectedBackendChange}
      tokens={tokens}
      onTokensChange={onTokensChange}
      sessions={sessions}
      archivedCount={archivedCount}
      busy={sender.sending}
      error={sender.error}
      onDismissError={sender.clearError}
      lastUsedModelId={lastUserTurnAgentSettings.modelId}
      lastUsedEffort={lastUserTurnAgentSettings.effort}
      onRunCommand={onRunCommand}
      onSendPrompt={(input) =>
        void sender.send({
          conversationId: activeTabId,
          text: input.text,
          images: input.images,
          backend: input.backend,
          modelId: input.modelId,
          ...(input.effort !== undefined ? { effort: input.effort } : {}),
        })
      }
    />
  );

  const pane =
    tabs.length > 0 ? (
      <ConversationPane
        agentBackend={agentBackend}
        projectName={projectName}
        {...(activeConversation ? { status: activeConversation.status } : {})}
        tabs={
          <ConversationTabs
            tabs={tabs}
            activeTabId={activeTabId}
            onSelect={setActiveTab}
            onClose={handleClose}
            onNewChat={handleNewChat}
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
                <IconButton
                  type="button"
                  variant="square"
                  aria-label="Expand conversations rail"
                  data-tooltip="Expand rail"
                  onClick={toggleRail}
                >
                  <ChevronGlyph dir="right" />
                </IconButton>
              </div>
            ) : (
              <>
                <div className={RAIL_TOGGLE_ROW_CLASS}>
                  <IconButton
                    type="button"
                    variant="square"
                    aria-label="Collapse conversations rail"
                    data-tooltip="Collapse rail"
                    onClick={toggleRail}
                  >
                    <ChevronGlyph dir="left" />
                  </IconButton>
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
    </div>
  );
}
