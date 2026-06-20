"use client";

import { memo, useCallback } from "react";
import type { MessageContentBlock } from "@/lib/conversations/schemas";
import CopyMessageButton, { msgActionBtnClass } from "./CopyMessageButton";

interface MessageActionsProps {
  /** The 0-based index of this message in the conversation */
  messageIndex: number;
  /** Content blocks of the message — used for the Copy action */
  content: MessageContentBlock[];
  /**
   * Called when user clicks Fork — forks the conversation from this message.
   * Omit to hide the Fork action (e.g. surfaces with no fork backend).
   */
  onFork?: (messageIndex: number) => void;
}

/**
 * Hover action bar shown beneath every message. Always renders Copy; renders
 * Fork only when an `onFork` handler is wired.
 *
 * Render inside a message row — the parent must be `position: relative`
 * (MessageRow's row sets the `relative` utility).
 */
function MessageActions({
  messageIndex,
  content,
  onFork,
}: MessageActionsProps) {
  const handleFork = useCallback(() => {
    onFork?.(messageIndex);
  }, [messageIndex, onFork]);

  return (
    <div className="mt-xs ml-auto flex w-fit items-center gap-[2px]">
      <CopyMessageButton content={content} />
      {onFork && (
        <button
          className={msgActionBtnClass}
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
      )}
    </div>
  );
}

export default memo(MessageActions);
