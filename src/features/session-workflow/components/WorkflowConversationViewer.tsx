"use client";

import { useRef, useState } from "react";
import ConversationPanel from "@/components/conversation/ConversationPanel";
import ConversationTranscript, {
  type TranscriptNav,
} from "@/components/conversation/ConversationTranscript";
import { useSessionQuery } from "@/lib/sessions/queries";
import { useQuickTicketConversationRegistration } from "@/components/quick-ticket/useQuickTicketConversationRegistration";
import { CloseIcon } from "@/components/icons";
import { StatusChip } from "@/components/ui/StatusChip";

/**
 * The Log surface: one workflow conversation, opened from a task, a validator
 * seat, or a History conversation row (README §11).
 *
 * The header names the conversation itself — id and the role that owns it —
 * because with a validator cohort several transcripts belong to one context and
 * one task, so a context/task title alone no longer identifies which transcript
 * is on screen. The context/task path stays as a second line: it is still the
 * only thing that says where the reader came from.
 */
interface WorkflowConversationViewerProps {
  projectName: string;
  sessionName: string;
  conversationId: string;
  isLive: boolean;
  /** The use site this transcript belongs to: `Implementer`, `Validator · security`. */
  role: string;
  contextTitle: string;
  /** Only when the transcript was opened from a task rather than a lane. */
  taskTitle?: string;
  onClose: () => void;
}

const noop = () => {};

export default function WorkflowConversationViewer({
  projectName,
  sessionName,
  conversationId,
  isLive,
  role,
  contextTitle,
  taskTitle,
  onClose,
}: WorkflowConversationViewerProps) {
  const sessionQuery = useSessionQuery(projectName, sessionName);
  const worktreePath = sessionQuery.data?.worktreePath;
  const conversation = sessionQuery.data?.conversations.find(
    (c) => c.id === conversationId,
  );
  useQuickTicketConversationRegistration({
    projectName,
    sessionName,
    conversationId,
    title: taskTitle ?? role,
  });

  const panelBodyRef = useRef<HTMLDivElement | null>(null);
  const [nav, setNav] = useState<TranscriptNav | null>(null);

  return (
    <div
      data-testid="wf-transcript-viewer"
      className="flex min-h-0 min-w-0 flex-1 flex-col bg-bg-void [&>.prompt-panel]:min-h-0 [&>.prompt-panel]:flex-1 max-768:[.app[data-page=workflow][data-mobile-panel=graph]_&]:hidden max-768:[.app[data-page=workflow][data-mobile-panel=inspector]_&]:hidden"
    >
      <header className="flex shrink-0 items-center gap-[10px] border-b border-border-dim bg-bg-surface px-md py-2">
        <button
          className="flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded-sm border border-solid border-border-subtle bg-transparent p-0 text-text-tertiary transition-colors duration-150 hover:border-border-default hover:bg-bg-hover hover:text-text-secondary focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:outline-offset-2 max-768:size-[44px]"
          onClick={onClose}
          type="button"
          aria-label="Close transcript and return to graph"
        >
          <CloseIcon size={12} />
        </button>
        <div className="flex min-w-0 flex-col gap-[2px]">
          <span
            data-testid="transcript-identity"
            className="overflow-hidden font-mono text-[0.78rem] font-semibold text-ellipsis whitespace-nowrap text-text-primary"
          >
            {conversationId}
            <span className="mx-[5px] text-text-tertiary">&middot;</span>
            <span className="font-medium text-text-secondary">{role}</span>
          </span>
          <span
            data-testid="transcript-breadcrumb"
            className="overflow-hidden font-mono text-[0.7rem] text-ellipsis whitespace-nowrap text-text-tertiary"
          >
            {taskTitle === undefined
              ? contextTitle
              : `${contextTitle} / ${taskTitle}`}
          </span>
        </div>
        <StatusChip
          tone={isLive ? "cyan" : "neutral"}
          layoutClassName="ml-auto shrink-0"
          data-testid="transcript-status"
          {...(isLive
            ? {
                icon: (
                  <span className="h-[6px] w-[6px] shrink-0 animate-[pulse-dot_2s_ease-in-out_infinite] rounded-full bg-cyan shadow-[0_0_6px_var(--cyan-glow)] motion-reduce:animate-none" />
                ),
              }
            : {})}
        >
          {isLive ? "live" : "ended"}
        </StatusChip>
      </header>
      {conversation ? (
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
          selectedBackend={conversation.agentBackend}
          transcript={
            <ConversationTranscript
              scope={{
                kind: "session",
                projectName,
                sessionName,
                conversationId,
              }}
              backend={conversation.agentBackend}
              status={conversation.status}
              worktreePath={worktreePath}
              onNavChange={setNav}
            />
          }
          alignmentGateSlot={null}
          promptInputSlot={null}
        />
      ) : (
        <p className="p-md text-sm text-text-secondary" role="status">
          {sessionQuery.isPending
            ? "Loading conversation…"
            : "Conversation unavailable."}
        </p>
      )}
    </div>
  );
}
