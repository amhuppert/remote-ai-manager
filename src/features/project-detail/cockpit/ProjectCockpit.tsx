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
import {
  useSendProjectPrompt,
  useCreateProjectConversation,
  useCloseProjectConversation,
} from "@/lib/project-conversations-client/mutations";
import { useProjectConversationMessagesQuery } from "@/lib/project-conversations-client/queries";
import { useMainWorktreeDiffQuery } from "@/lib/git/queries";
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
  useToggleRail,
  useSetRailCollapsed,
} from "./use-cockpit-view-state";
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

/**
 * Which cockpit area a small viewport shows. Desktop shows all three at once;
 * at ≤768px the switcher picks one (the grid collapses to a single column).
 */
type MobilePane = "chat" | "rail" | "sessions";

const MOBILE_PANES: { id: MobilePane; label: string }[] = [
  { id: "chat", label: "Chat" },
  { id: "rail", label: "Conversations" },
  { id: "sessions", label: "Sessions" },
];

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
 * Active Conversations rail (collapsible, injected as a slot) on the left, with
 * the right column split 50/50 in height — the conversation pane on top, the
 * sessions panel below. The rail is mounted regardless of open-conversation
 * count so closed conversations stay reachable; with no open conversations the
 * pane shows a create-a-conversation composer (the empty state) instead of the
 * tab strip. Tab membership is reconciled against the server open list; the
 * store layers ordering, active selection, rail-collapse, and the entry
 * animation.
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
  const railCollapsed = useRailCollapsed();
  const reconcile = useReconcileTabs();
  const setActiveTab = useSetActiveTab();
  const focusTab = useFocusTab();
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
  // the rail or sessions pane.
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

  // Live +/− stat for the `main · worktree` review chip. A 404 (endpoint not
  // shipped) or clean tree resolves to no stat; the chip still opens the
  // read-only diff slide-over.
  const diffQuery = useMainWorktreeDiffQuery(projectName);
  const diffStat = useMemo(() => {
    const d = diffQuery.data;
    if (!d) return null;
    return {
      additions: d.totalAdditions,
      deletions: d.totalDeletions,
      fileCount: d.files.length,
    };
  }, [diffQuery.data]);

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
        diffStat={diffStat}
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
      <section className="plc-pane plc-pane--empty" data-agent={agentBackend}>
        <div className="plc-pane-empty">
          <p className="plc-pane-empty-title">No open conversations</p>
          <p className="plc-pane-empty-hint">
            Send a prompt to start a new conversation, or reopen a closed one
            from the rail.
          </p>
        </div>
        <div className="plc-pane-composer">{composer}</div>
      </section>
    );

  return (
    <div
      className={`plc-cockpit${entering ? " plc-enter" : ""}`}
      data-rail-collapsed={railCollapsed}
      data-mobile-pane={mobilePane}
    >
      <div
        className="plc-mobile-switch cc-tabs"
        role="tablist"
        aria-label="Cockpit panes"
      >
        {MOBILE_PANES.map((pane) => (
          <button
            key={pane.id}
            type="button"
            role="tab"
            aria-selected={mobilePane === pane.id}
            className={`cc-tab${mobilePane === pane.id ? " active" : ""}`}
            onClick={() => handleMobilePane(pane.id)}
          >
            {pane.label}
          </button>
        ))}
      </div>
      <div className="plc-rail" data-collapsed={railCollapsed}>
        {railCollapsed ? (
          <div className="plc-rail-collapsed">
            <button
              type="button"
              className="btn-icon-only"
              aria-label="Expand conversations rail"
              data-tooltip="Expand rail"
              onClick={toggleRail}
            >
              <ChevronGlyph dir="right" />
            </button>
          </div>
        ) : (
          <>
            <div className="plc-rail-toggle-row">
              <button
                type="button"
                className="btn-icon-only"
                aria-label="Collapse conversations rail"
                data-tooltip="Collapse rail"
                onClick={toggleRail}
              >
                <ChevronGlyph dir="left" />
              </button>
            </div>
            {rail}
          </>
        )}
      </div>
      {pane}
      <SessionsPanel
        projectName={projectName}
        sessions={sessions}
        tokens={tokens}
        onTokensChange={onTokensChange}
        {...(onBranch ? { onBranch } : {})}
      />
    </div>
  );
}
