"use client";

import { useCallback, useEffect, useMemo, type ReactNode } from "react";
import type { ConversationState } from "@/lib/conversations/schemas";
import type { SessionListItem } from "@/lib/sessions/schemas";
import type { AgentBackendId } from "@/lib/shared/schemas";
import {
  useSendProjectPrompt,
  useCreateProjectConversation,
  useCloseProjectConversation,
} from "@/lib/project-conversations-client/mutations";
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
 * The three-column project cockpit: the global Active Conversations rail
 * (collapsible, injected as a slot), the conversation pane (tabs · transcript ·
 * docked composer · diff toggle), and the sessions panel. Layout defaults are
 * locked (composer bottom, tabs switcher, comfy density, ~60% pane width) — no
 * tweak controls. Tab membership is reconciled against the server open list;
 * the store layers ordering, active selection, rail-collapse, and the entry
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

  const pane = (
    <ConversationPane
      agentBackend={agentBackend}
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
  );

  return (
    <div
      className={`plc-cockpit${entering ? " plc-enter" : ""}`}
      data-rail-collapsed={railCollapsed}
    >
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
            <div style={{ display: "flex", justifyContent: "flex-end" }}>
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
