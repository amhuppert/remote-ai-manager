"use client";

import { useCallback, useState, type ReactNode, type RefObject } from "react";
import { ContextFillIndicator } from "@/components/ContextFillIndicator";
import { EmptyStateTitle, EmptyStateDesc } from "@/components/ui/EmptyState";
import ConversationNav from "@/components/ConversationNav";
import SyntheticForkBadge from "@/features/session/conversation/SyntheticForkBadge";
import AgentPill from "@/components/AgentPill";
import { CopyIcon, CheckIcon, StopIcon } from "@/components/icons";
import ConversationVirtuosoList, {
  type ConversationVirtuosoListProps,
  type VirtuosoHandle,
} from "@/components/conversation/ConversationVirtuosoList";
import type { ConversationRow } from "@/features/session/conversation/conversation-rows";
import type { ConversationState } from "@/lib/conversations/schemas";
import type { AgentBackendId } from "@/lib/shared/schemas";

export interface ConversationPanelProps {
  conversations: boolean;
  activeConversation: ConversationState | undefined;
  sessionName: string;

  openMobileSidebar: () => void;

  currentMessageIndex: number;
  totalMessages: number;
  handleFirstMessage: () => void;
  handlePrevMessage: () => void;
  handleNextMessage: () => void;
  handleLastMessage: () => void;

  contextPercent: number | null;
  promptError: string | null;
  promptCancelled: boolean;
  dismissError: () => void;
  dismissCancelled: () => void;

  panelBodyRef: RefObject<HTMLDivElement | null>;
  selectedBackend: AgentBackendId;
  setCollabPinnedTopTarget: (el: HTMLDivElement | null) => void;
  isCollabPassageInView: boolean;

  messagesPending: boolean;
  rows: ConversationRow[];
  virtuosoRef: RefObject<VirtuosoHandle | null>;
  conversationId: string;
  followBottom: boolean;
  renderMessageRow: ConversationVirtuosoListProps["renderMessage"];
  renderCollabRow: ConversationVirtuosoListProps["renderCollab"];
  renderTypingIndicator: ConversationVirtuosoListProps["renderFooter"];
  handleRangeChanged: ConversationVirtuosoListProps["onRangeChanged"];
  handleAtBottomStateChange: ConversationVirtuosoListProps["onAtBottomStateChange"];
  handleAtTopStateChange: ConversationVirtuosoListProps["onAtTopStateChange"];

  alignmentGateSlot: ReactNode;

  canStop: boolean;
  onStop: () => void;
  buildMarkdown?: () => string | null;

  promptInputSlot: ReactNode;
}

export default function ConversationPanel({
  conversations,
  activeConversation,
  sessionName,
  openMobileSidebar,
  currentMessageIndex,
  totalMessages,
  handleFirstMessage,
  handlePrevMessage,
  handleNextMessage,
  handleLastMessage,
  contextPercent,
  promptError,
  promptCancelled,
  dismissError,
  dismissCancelled,
  panelBodyRef,
  selectedBackend,
  setCollabPinnedTopTarget,
  isCollabPassageInView,
  messagesPending,
  rows,
  virtuosoRef,
  conversationId,
  followBottom,
  renderMessageRow,
  renderCollabRow,
  renderTypingIndicator,
  handleRangeChanged,
  handleAtBottomStateChange,
  handleAtTopStateChange,
  alignmentGateSlot,
  canStop,
  onStop,
  buildMarkdown,
  promptInputSlot,
}: ConversationPanelProps): React.JSX.Element {
  const panelBackend = selectedBackend;
  const conversationTitle = activeConversation?.name ?? sessionName;
  const [copied, setCopied] = useState(false);
  const handleCopyMarkdown = useCallback(() => {
    if (!buildMarkdown) return;
    const text = buildMarkdown();
    if (!text) return;
    void navigator.clipboard?.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    });
  }, [buildMarkdown]);

  return (
    <div
      className="prompt-panel group/panel flex min-h-0 flex-col overflow-clip bg-bg-surface"
      data-agent={panelBackend}
    >
      <div className="panel-header flex items-center gap-sm border-x-0 border-t-0 border-b border-solid border-border-subtle px-lg py-md group-data-[agent=claude]/panel:border-b-[var(--cc-cyan-a18)] group-data-[agent=claude]/panel:bg-[linear-gradient(90deg,var(--cyan-glow),var(--bg-base)_55%)] group-data-[agent=codex]/panel:border-b-[var(--cc-violet-a18)] group-data-[agent=codex]/panel:bg-[linear-gradient(90deg,var(--violet-glow),var(--bg-base)_55%)] max-768:min-h-[40px] max-768:min-w-0 max-768:shrink-0 max-768:flex-nowrap max-768:gap-xs max-768:px-sm max-768:py-xs">
        {conversations && (
          <button
            className="hidden max-768:flex max-768:shrink-0 max-768:cursor-pointer max-768:items-center max-768:gap-[4px] max-768:rounded-sm max-768:border max-768:border-solid max-768:border-border-default max-768:bg-bg-surface max-768:px-[8px] max-768:py-[6px] max-768:font-mono max-768:text-[0px] max-768:leading-none max-768:text-text-secondary max-768:transition-all max-768:duration-150 max-768:ease-[ease] max-768:before:text-[0.95rem] max-768:before:leading-none max-768:before:content-['☰'] max-768:hover:bg-bg-hover max-768:hover:text-text-primary"
            onClick={openMobileSidebar}
            title="Show conversations"
          >
            &#9776; Conversations
          </button>
        )}
        <AgentPill backend={panelBackend} />
        <span
          className="min-w-0 flex-[0_1_auto] overflow-hidden text-[0.92rem] font-[var(--font-sans,inherit)] font-semibold tracking-normal text-ellipsis whitespace-nowrap text-text-primary normal-case max-768:hidden"
          title={conversationTitle}
        >
          {conversationTitle}
        </span>
        <span className="shrink-0 font-mono text-[0.7rem] whitespace-nowrap text-text-tertiary max-768:hidden">
          {totalMessages} message{totalMessages === 1 ? "" : "s"}
        </span>
        {activeConversation?.forkedFrom?.forkMode === "synthetic" && (
          <SyntheticForkBadge />
        )}
        <div className="ml-auto inline-flex shrink-0 items-center gap-[6px] max-768:gap-[4px]">
          <ConversationNav
            currentIndex={currentMessageIndex}
            totalCount={totalMessages}
            onFirst={handleFirstMessage}
            onPrevious={handlePrevMessage}
            onNext={handleNextMessage}
            onLast={handleLastMessage}
          />
          {canStop && (
            <button
              type="button"
              className="inline-flex h-[24px] cursor-pointer items-center gap-[6px] rounded-full border border-solid border-[var(--cc-red-soft-a45)] bg-[var(--cc-red-soft-a08)] px-[10px] font-mono text-[0.66rem] font-bold tracking-[0.08em] text-red uppercase transition-all duration-150 ease-[ease] hover:border-red hover:bg-[var(--cc-red-soft-a14)] hover:shadow-[0_0_12px_var(--cc-red-soft-a25)] max-768:px-[8px]"
              onClick={onStop}
              title="Stop agent"
              aria-label="Stop agent"
            >
              <StopIcon size={11} />
              <span className="leading-none max-768:hidden">Stop</span>
            </button>
          )}
          {buildMarkdown && (
            // Retained hook: `.btn-icon-only` is targeted by a cross-owned rule
            // in conversation.css (28px copy-markdown box, owned by _root and
            // also consumed by ConversationSidebar/ConversationList), which the
            // 30px IconButton primitive would not match. Left on the leaf class.
            <button
              type="button"
              className="btn-icon-only"
              onClick={handleCopyMarkdown}
              title="Copy as markdown"
              aria-label="Copy as markdown"
            >
              {copied ? <CheckIcon size={14} /> : <CopyIcon size={14} />}
            </button>
          )}
        </div>
      </div>
      {contextPercent != null && (
        <div className="mobile-context-fill">
          <ContextFillIndicator percentage={contextPercent} />
        </div>
      )}
      {promptError && (
        <div className="mb-md flex animate-[fadeIn_0.3s_ease] items-center justify-between gap-sm rounded-md border border-solid border-[var(--cc-red-border)] bg-red-glow px-md py-sm font-mono text-[0.78rem] text-red">
          <span>{promptError}</span>
          <button
            className="cursor-pointer border-none bg-transparent px-xs py-0 text-[1.1rem] text-red opacity-70 hover:opacity-100"
            onClick={dismissError}
          >
            &times;
          </button>
        </div>
      )}
      {promptCancelled && (
        <div className="mb-md flex animate-[fadeInOut_2.5s_ease_forwards] items-center justify-between gap-sm rounded-md border border-solid border-[var(--cc-amber-a20)] bg-amber-glow px-md py-sm font-mono text-[0.78rem] text-amber">
          <span>Prompt cancelled</span>
          <button
            className="cursor-pointer border-none bg-transparent px-xs py-0 text-[1.1rem] text-amber opacity-70 hover:opacity-100"
            onClick={dismissCancelled}
          >
            &times;
          </button>
        </div>
      )}
      <div className="group/stage relative flex min-h-0 flex-1 flex-col">
        <div
          className="panel-body flex min-h-0 flex-1 flex-col overflow-hidden p-lg group-has-[.ask-question-overlay]/stage:pb-[58px] group-has-[.ask-question-overlay[data-compact=true]]/stage:pb-[66px] max-768:p-sm"
          ref={panelBodyRef}
          {...(activeConversation?.debugMode?.active
            ? { "data-debug-mode": "" }
            : {})}
        >
          <div className="conversation" data-backend={selectedBackend}>
            <div
              ref={setCollabPinnedTopTarget}
              className="collab-pinned-top-target sticky -top-lg z-[5] -mx-lg -mt-lg mb-0 border-x-0 border-t-0 border-b border-solid border-border-default bg-bg-base px-lg py-sm empty:hidden data-[visible=false]:hidden"
              data-visible={isCollabPassageInView ? "true" : "false"}
            />
            {messagesPending ? (
              <div className="flex flex-col items-center justify-center py-xl text-center">
                <EmptyStateTitle>Loading conversation...</EmptyStateTitle>
              </div>
            ) : rows.length > 0 ? (
              <ConversationVirtuosoList
                rows={rows}
                virtuosoRef={virtuosoRef}
                conversationId={conversationId}
                followBottom={followBottom}
                renderMessage={renderMessageRow}
                renderCollab={renderCollabRow}
                renderFooter={renderTypingIndicator}
                onRangeChanged={handleRangeChanged}
                onAtBottomStateChange={handleAtBottomStateChange}
                onAtTopStateChange={handleAtTopStateChange}
              />
            ) : (
              <div className="flex flex-col items-center justify-center py-xl text-center">
                <EmptyStateTitle>No messages yet</EmptyStateTitle>
                <EmptyStateDesc>
                  Send a prompt to start the conversation.
                </EmptyStateDesc>
              </div>
            )}
          </div>
        </div>

        {alignmentGateSlot}

        {promptInputSlot}
      </div>
    </div>
  );
}
