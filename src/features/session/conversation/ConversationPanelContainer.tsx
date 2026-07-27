"use client";

import { useState } from "react";
import ConversationPanel from "@/components/conversation/ConversationPanel";
import ConversationTranscript, {
  type TranscriptNav,
} from "@/components/conversation/ConversationTranscript";
import AlignmentGate from "@/features/session/conversation/AlignmentGate";
import { useOpenMobileSidebar } from "@/stores/session-detail.store";
import { useCollabPassageVisibility } from "@/features/session/hooks/use-collab-passage-visibility";
import { useCollabRowRenderer } from "@/features/session/hooks/use-collab-row-renderer";
import { useMessageRowRenderer } from "@/features/session/hooks/use-message-row-renderer";
import { useThinkingBlockExpansionHotkeys } from "@/hooks/use-thinking-block-expansion-hotkeys";
import type { useSessionPageLocalState } from "@/features/session/hooks/use-session-page-local-state";
import type { useCollabContext } from "@/features/session/hooks/use-collab-context";
import type { ConversationState } from "@/lib/conversations/schemas";
import type { AgentBackendId } from "@/lib/shared/schemas";

type LocalState = ReturnType<typeof useSessionPageLocalState>;
type CollabContext = ReturnType<typeof useCollabContext>;

const noop = (): void => {};

export interface ConversationPanelContainerProps {
  projectName: string;
  sessionName: string;
  conversationId: string;

  activeConversation: ConversationState | undefined;
  conversations: ConversationState[] | undefined;

  isBusy: boolean;
  isReadOnly: boolean;
  hasActiveCollab: boolean;
  worktreePath: string | undefined;
  selectedBackend: AgentBackendId;
  contextPercent: number | null;

  handleDirectPrompt: (text: string) => Promise<void>;
  handleFork: (messageIndex: number) => Promise<void>;

  local: LocalState;
  collab: CollabContext;

  canStop: boolean;
  onStop: () => void;
}

export default function ConversationPanelContainer({
  projectName,
  sessionName,
  conversationId,
  activeConversation,
  conversations,
  isBusy,
  isReadOnly,
  hasActiveCollab,
  worktreePath,
  selectedBackend,
  contextPercent,
  handleDirectPrompt,
  handleFork,
  local,
  collab,
  canStop,
  onStop,
}: ConversationPanelContainerProps): React.JSX.Element {
  const {
    virtuosoRef,
    panelBodyRef,
    collabPinnedTopTarget,
    setCollabPinnedTopTarget,
    collabRowEl,
    setCollabRowEl,
  } = local;
  const {
    collabPassageProps,
    collabEnvelopeForConversation,
    isCollabRunning,
    hiddenMessageIndex,
    handleCollabStop,
    handleCollabRefClick,
    collabUserAnswerDrafts,
    setCollabUserAnswerDraft,
    clearCollabUserAnswerDrafts,
    collabResumeMutation,
  } = collab;
  const openMobileSidebar = useOpenMobileSidebar();
  const thinkingExpansionCommand = useThinkingBlockExpansionHotkeys();
  const [nav, setNav] = useState<TranscriptNav | null>(null);

  const renderMessageRow = useMessageRowRenderer({
    activeConversation,
    selectedBackend,
    worktreePath,
    thinkingExpansionCommand,
    handleDirectPrompt,
    handleFork,
    isBusy,
    projectName,
    sessionName,
  });

  const renderCollabRow = useCollabRowRenderer({
    collabPassageProps,
    collabEnvelopeForConversation,
    isCollabRunning,
    collabPinnedTopTarget,
    setCollabRowEl,
    handleCollabStop,
    handleCollabRefClick,
    projectName,
    sessionName,
    conversationId,
    collabUserAnswerDrafts,
    setCollabUserAnswerDraft,
    clearCollabUserAnswerDrafts,
    collabResumeMutation,
  });

  const isCollabPassageInView = useCollabPassageVisibility(
    collabRowEl,
    panelBodyRef,
  );

  const transcript = (
    <ConversationTranscript
      scope={{ kind: "session", projectName, sessionName, conversationId }}
      backend={selectedBackend}
      status={activeConversation?.status}
      pendingQueue={activeConversation?.pendingQueue}
      worktreePath={worktreePath}
      thinkingExpansionCommand={thinkingExpansionCommand}
      renderMessageRow={renderMessageRow}
      collab={{
        envelope: collabEnvelopeForConversation,
        hiddenMessageIndex,
        renderRow: renderCollabRow,
        suppressIndicator: hasActiveCollab,
      }}
      showInFlightBanners
      leadingSlot={
        <div
          ref={setCollabPinnedTopTarget}
          className="collab-pinned-top-target sticky -top-lg z-[5] -mx-lg -mt-lg mb-0 border-x-0 border-t-0 border-b border-solid border-border-default bg-bg-base px-lg py-sm empty:hidden data-[visible=false]:hidden max-768:-top-sm max-768:-mx-sm max-768:-mt-sm max-768:border-b-0 max-768:px-0 max-768:py-0"
          data-visible={isCollabPassageInView ? "true" : "false"}
        />
      }
      onNavChange={setNav}
      virtuosoRef={virtuosoRef}
    />
  );

  return (
    <ConversationPanel
      conversations={Boolean(conversations)}
      activeConversation={activeConversation}
      sessionName={sessionName}
      openMobileSidebar={openMobileSidebar}
      currentMessageIndex={nav?.currentMessageIndex ?? 0}
      totalMessages={nav?.totalMessages ?? 0}
      handleFirstMessage={nav?.handleFirstMessage ?? noop}
      handlePrevMessage={nav?.handlePrevMessage ?? noop}
      handleNextMessage={nav?.handleNextMessage ?? noop}
      handleLastMessage={nav?.handleLastMessage ?? noop}
      contextPercent={contextPercent}
      panelBodyRef={panelBodyRef}
      selectedBackend={selectedBackend}
      transcript={transcript}
      alignmentGateSlot={
        <AlignmentGate
          projectName={projectName}
          sessionName={sessionName}
          disabled={isReadOnly}
        />
      }
      canStop={canStop}
      onStop={onStop}
      promptInputSlot={undefined}
    />
  );
}
