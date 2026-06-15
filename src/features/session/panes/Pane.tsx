"use client";

import { useCallback } from "react";
import type { SessionActiveConversation } from "@/lib/active-conversations/schemas";
import { toPaneViewModel } from "./pane-view-model";
import PaneConversationBody from "./PaneConversationBody";

export interface PaneProps {
  conversation: SessionActiveConversation;
  active: boolean;
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
  onActivate,
  onOpenFull,
  onClose,
}: PaneProps): React.JSX.Element {
  const vm = toPaneViewModel(conversation);

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

  // Banner when the agent is blocked on the operator; otherwise the latest
  // status line. When neither applies, the slot renders nothing.
  const showBanner =
    vm.status === "waiting_for_input" && vm.pendingQuestion !== null;

  return (
    <section
      className="pane"
      data-active={active ? "true" : undefined}
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

      <PaneConversationBody
        projectName={conversation.projectName}
        sessionName={conversation.sessionName}
        conversationId={conversation.id}
        selectedBackend={conversation.agentBackend}
        isActive={active}
      />
    </section>
  );
}
