"use client";

import { useCallback } from "react";
import type { SessionActiveConversation } from "@/lib/active-conversations/schemas";
import { useConversationMessagesQuery } from "@/hooks/conversation/use-conversation-messages-query";
import { toPaneViewModel } from "./pane-view-model";
import PaneMessage from "./PaneMessage";

export interface PaneProps {
  conversation: SessionActiveConversation;
  active: boolean;
  messageLimit: number;
  compact: boolean;
  onActivate: (id: string) => void;
  onOpenFull: (id: string) => void;
  onClose: (id: string) => void;
}

// Duplicated-private in ConversationSidebarRow and PeekPopover (each owns its own
// copy, neither exports it). Kept local here rather than reaching across feature
// boundaries; a shared-util extraction is deferred.
const STATUS_LABEL: Record<SessionActiveConversation["status"], string> = {
  new: "new",
  running: "running",
  awaiting: "awaiting",
  waiting_for_input: "waiting for input",
};

export default function Pane({
  conversation,
  active,
  messageLimit,
  compact,
  onActivate,
  onOpenFull,
  onClose,
}: PaneProps): React.JSX.Element {
  const vm = toPaneViewModel(conversation);

  // Enabled by mount: a Pane only renders inside the panes grid (panes mode), so
  // leaving panes unmounts it and disables the query (perf 8.5). No explicit gate.
  const { data, isLoading, isError } = useConversationMessagesQuery(
    conversation.projectName,
    conversation.sessionName,
    conversation.id,
  );

  const handleActivate = useCallback(() => {
    if (!active) onActivate(conversation.id);
  }, [active, conversation.id, onActivate]);

  const handleOpenFull = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      event.stopPropagation();
      onOpenFull(conversation.id);
    },
    [conversation.id, onOpenFull],
  );

  const handleClose = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      event.stopPropagation();
      onClose(conversation.id);
    },
    [conversation.id, onClose],
  );

  const messages = data ?? [];
  const tail = messages.slice(-messageLimit);
  const hiddenCount = messages.length - tail.length;

  // Banner when the agent is blocked on the operator; otherwise the latest
  // status line. When neither applies, the slot renders nothing.
  const showBanner =
    vm.status === "waiting_for_input" && vm.pendingQuestion !== null;

  return (
    <section
      className="pane"
      data-active={active ? "true" : undefined}
      data-compact={compact ? "true" : undefined}
      onClick={handleActivate}
    >
      <header className="pane__head">
        <span
          className="pane__dot"
          data-status={vm.status}
          aria-hidden="true"
        />
        <span className="pane__title">{vm.title}</span>
        <button
          type="button"
          className="pane__open-full"
          aria-label="Open full"
          onClick={handleOpenFull}
        >
          ↗
        </button>
        <button
          type="button"
          className="pane__close"
          aria-label="Close pane"
          onClick={handleClose}
        >
          ×
        </button>
      </header>

      <div className="pane__meta">
        <span className="pane__meta-status">{STATUS_LABEL[vm.status]}</span>
        <span className="pane__meta-loc">
          {vm.projectName}
          {vm.sessionName !== null && ` / ${vm.sessionName}`}
        </span>
        <span className="pane__meta-time">{vm.relativeTime}</span>
      </div>

      {showBanner && vm.pendingQuestion !== null ? (
        <div className="pane__banner">{vm.pendingQuestion}</div>
      ) : vm.statusLine !== null ? (
        <div className="pane__status-line">{vm.statusLine}</div>
      ) : null}

      <div className="pane__tail">
        {hiddenCount > 0 && (
          <div className="pane__earlier">+ {hiddenCount} earlier</div>
        )}
        {isLoading ? (
          <div className="pane__tail-empty">Loading…</div>
        ) : isError ? (
          <div className="pane__tail-empty">Could not load messages</div>
        ) : tail.length === 0 ? (
          <div className="pane__tail-empty">No messages yet</div>
        ) : (
          tail.map((m) => (
            <PaneMessage key={m.seq} message={m} compact={compact} />
          ))
        )}
      </div>
    </section>
  );
}
