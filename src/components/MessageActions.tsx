"use client";

import { useCallback } from "react";
import type { MessageContentBlock } from "@/types";
import CopyMessageButton from "./CopyMessageButton";

interface MessageActionsProps {
  /** The 0-based index of this message in the conversation */
  messageIndex: number;
  /** Content blocks of the message — used for the Copy action */
  content: MessageContentBlock[];
  /** Called when user clicks Fork — forks conversation from this message */
  onFork: (messageIndex: number) => void;
}

/**
 * Hover action bar shown beneath every message. Renders Copy + Fork.
 *
 * Render inside a `.message` element — the parent must have
 * `position: relative` (already set by `.message` class).
 */
export default function MessageActions({
  messageIndex,
  content,
  onFork,
}: MessageActionsProps) {
  const handleFork = useCallback(() => {
    onFork(messageIndex);
  }, [messageIndex, onFork]);

  return (
    <div className="msg-actions">
      <CopyMessageButton content={content} />
      <button
        className="msg-action-btn"
        onClick={handleFork}
        data-tooltip="Fork"
        title="Fork conversation from this message"
      >
        <svg
          width="12"
          height="12"
          viewBox="0 0 12 12"
          fill="none"
          aria-hidden="true"
        >
          <circle
            cx="3"
            cy="2.5"
            r="1.5"
            stroke="currentColor"
            strokeWidth="1.2"
          />
          <circle
            cx="3"
            cy="9.5"
            r="1.5"
            stroke="currentColor"
            strokeWidth="1.2"
          />
          <circle
            cx="9"
            cy="4.5"
            r="1.5"
            stroke="currentColor"
            strokeWidth="1.2"
          />
          <path
            d="M3 4V8M3 5.5C3 5.5 3 4.5 5.5 4.5H7.5"
            stroke="currentColor"
            strokeWidth="1.2"
            strokeLinecap="round"
          />
        </svg>
      </button>
    </div>
  );
}
