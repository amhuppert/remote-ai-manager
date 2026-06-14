"use client";

import type { SessionActiveConversation } from "@/lib/active-conversations/schemas";
import ConversationTab from "./ConversationTab";

export interface ConversationTabStripProps {
  workingSet: SessionActiveConversation[];
  activeId: string;
  isAtCap: boolean;
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
  onAddClick: () => void;
}

// Mirrors the fallback in pane-view-model so tabs and panes label an unnamed
// conversation identically; kept in sync deliberately.
const UNTITLED = "Untitled conversation";

export default function ConversationTabStrip({
  workingSet,
  activeId,
  isAtCap,
  onActivate,
  onClose,
  onAddClick,
}: ConversationTabStripProps): React.JSX.Element {
  return (
    <div className="conversation-tab-strip" role="tablist">
      {workingSet.map((conversation, index) => (
        <ConversationTab
          key={conversation.id}
          id={conversation.id}
          title={
            conversation.name && conversation.name.trim()
              ? conversation.name
              : UNTITLED
          }
          status={conversation.status}
          active={conversation.id === activeId}
          hotkeyHint={index < 9 ? `⌘${index + 1}` : undefined}
          onActivate={onActivate}
          onClose={onClose}
        />
      ))}
      <button
        type="button"
        className="conversation-tab-strip__add"
        aria-label="Add conversation"
        disabled={isAtCap}
        title={
          isAtCap
            ? "Tab limit reached (6) — close a tab first"
            : "Add conversation"
        }
        onClick={onAddClick}
      >
        +
      </button>
    </div>
  );
}
