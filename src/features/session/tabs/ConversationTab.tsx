"use client";

import { useCallback } from "react";
import type { SessionActiveConversation } from "@/lib/active-conversations/schemas";

export interface ConversationTabProps {
  id: string;
  title: string;
  status: SessionActiveConversation["status"];
  active: boolean;
  hotkeyHint?: string;
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
}

export default function ConversationTab({
  id,
  title,
  status,
  active,
  hotkeyHint,
  onActivate,
  onClose,
}: ConversationTabProps): React.JSX.Element {
  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        onActivate(id);
      }
    },
    [id, onActivate],
  );

  const handleClose = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      // Closing must not also activate the tab; stop the click from bubbling
      // to the tab body's onClick.
      event.stopPropagation();
      onClose(id);
    },
    [id, onClose],
  );

  return (
    <div
      className="conversation-tab"
      role="tab"
      aria-selected={active}
      data-active={active ? "true" : undefined}
      tabIndex={0}
      onClick={() => onActivate(id)}
      onKeyDown={handleKeyDown}
    >
      <span
        className="conversation-tab__dot"
        data-status={status}
        aria-hidden="true"
      />
      <span className="conversation-tab__title">{title}</span>
      {hotkeyHint !== undefined && (
        <span className="conversation-tab__hotkey" aria-hidden="true">
          {hotkeyHint}
        </span>
      )}
      <button
        type="button"
        className="conversation-tab__close"
        aria-label="Close tab"
        onClick={handleClose}
      >
        <CloseIcon />
      </button>
    </div>
  );
}

function CloseIcon(): React.JSX.Element {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 12 12"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M3 3L9 9M9 3L3 9"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}
