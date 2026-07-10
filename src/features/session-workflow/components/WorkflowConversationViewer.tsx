"use client";

import { useRef, useState } from "react";
import ConversationPanel from "@/components/conversation/ConversationPanel";
import ConversationTranscript, {
  type TranscriptNav,
} from "@/components/conversation/ConversationTranscript";
import { useSessionQuery } from "@/lib/sessions/queries";

interface WorkflowConversationViewerProps {
  projectName: string;
  sessionName: string;
  conversationId: string;
  isLive: boolean;
  contextTitle: string;
  taskTitle: string;
  onClose: () => void;
}

const noop = () => {};

export default function WorkflowConversationViewer({
  projectName,
  sessionName,
  conversationId,
  isLive,
  contextTitle,
  taskTitle,
  onClose,
}: WorkflowConversationViewerProps) {
  const sessionQuery = useSessionQuery(projectName, sessionName);
  const worktreePath = sessionQuery.data?.worktreePath;
  const conversationStatus = sessionQuery.data?.conversations.find(
    (c) => c.id === conversationId,
  )?.status;

  const panelBodyRef = useRef<HTMLDivElement | null>(null);
  const [nav, setNav] = useState<TranscriptNav | null>(null);

  return (
    <div
      data-testid="wf-transcript-viewer"
      className="flex min-h-0 min-w-0 flex-1 flex-col bg-bg-void [&>.prompt-panel]:min-h-0 [&>.prompt-panel]:flex-1 max-768:[.app[data-page=workflow][data-mobile-panel=graph]_&]:hidden max-768:[.app[data-page=workflow][data-mobile-panel=inspector]_&]:hidden"
    >
      <header className="flex min-h-[44px] shrink-0 items-center gap-[10px] border-b border-border-dim bg-bg-surface px-md py-2">
        <button
          className="flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded-sm border border-border-subtle bg-transparent p-0 text-[0.72rem] text-text-tertiary transition-all duration-150 hover:border-border-default hover:bg-bg-hover hover:text-text-secondary"
          onClick={onClose}
          type="button"
          aria-label="Close transcript"
        >
          ✕
        </button>
        <div className="flex min-w-0 items-center gap-[6px] overflow-hidden">
          <span className="overflow-hidden font-mono text-[0.72rem] font-semibold text-ellipsis whitespace-nowrap text-text-secondary">
            {contextTitle}
          </span>
          <span className="shrink-0 font-mono text-[0.72rem] text-text-tertiary">
            /
          </span>
          <span className="overflow-hidden font-mono text-[0.72rem] font-medium text-ellipsis whitespace-nowrap text-text-primary">
            {taskTitle}
          </span>
        </div>
        {isLive && (
          <span className="ml-auto flex shrink-0 items-center gap-[6px] font-mono text-[0.7rem] font-semibold tracking-[0.06em] text-cyan uppercase">
            <span className="h-[6px] w-[6px] shrink-0 animate-[pulse-dot_2s_ease-in-out_infinite] rounded-full bg-cyan shadow-[0_0_6px_var(--cyan-glow)]" />
            Live
          </span>
        )}
      </header>
      <ConversationPanel
        conversations={false}
        activeConversation={undefined}
        sessionName={sessionName}
        canStop={false}
        onStop={noop}
        openMobileSidebar={noop}
        currentMessageIndex={nav?.currentMessageIndex ?? 0}
        totalMessages={nav?.totalMessages ?? 0}
        handleFirstMessage={nav?.handleFirstMessage ?? noop}
        handlePrevMessage={nav?.handlePrevMessage ?? noop}
        handleNextMessage={nav?.handleNextMessage ?? noop}
        handleLastMessage={nav?.handleLastMessage ?? noop}
        contextPercent={null}
        panelBodyRef={panelBodyRef}
        selectedBackend="claude"
        transcript={
          <ConversationTranscript
            scope={{
              kind: "session",
              projectName,
              sessionName,
              conversationId,
            }}
            backend="claude"
            status={conversationStatus}
            worktreePath={worktreePath}
            onNavChange={setNav}
          />
        }
        alignmentGateSlot={null}
        promptInputSlot={null}
      />
    </div>
  );
}
