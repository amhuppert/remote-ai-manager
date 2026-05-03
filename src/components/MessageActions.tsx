"use client";

import { useState, useCallback } from "react";
import type { MessageContentBlock } from "@/types";
import CopyMessageButton from "./CopyMessageButton";

interface MessageActionsProps {
  /** The 0-based index of this message in the conversation */
  messageIndex: number;
  /** Content blocks of the message — used for the Copy action */
  content: MessageContentBlock[];
  /** Called when user clicks Fork — forks conversation from this message */
  onFork: (messageIndex: number) => void;
  /** Called when user clicks Edit — enters inline edit mode */
  onEdit: (messageIndex: number) => void;
  /** Whether the session is busy (running/sending) */
  disabled?: boolean;
}

/**
 * Hover action bar for user messages. Shows Fork and Edit buttons
 * at the top-right of the message on hover.
 *
 * Render this inside a `.message.user` element — the parent must
 * have `position: relative` (already set by `.message` class).
 */
export default function MessageActions({
  messageIndex,
  content,
  onFork,
  onEdit,
  disabled = false,
}: MessageActionsProps) {
  const [confirmFork, setConfirmFork] = useState(false);

  const handleFork = useCallback(() => {
    if (confirmFork) {
      onFork(messageIndex);
      setConfirmFork(false);
    } else {
      setConfirmFork(true);
    }
  }, [confirmFork, messageIndex, onFork]);

  const handleEdit = useCallback(() => {
    onEdit(messageIndex);
  }, [messageIndex, onEdit]);

  const handleBlur = useCallback(() => {
    // Reset confirm state when focus leaves the action bar
    setConfirmFork(false);
  }, []);

  return (
    <div
      className={`msg-actions${disabled ? " msg-actions--disabled" : ""}`}
      onMouseLeave={handleBlur}
    >
      {confirmFork ? (
        <div className="msg-actions-confirm">
          <span className="msg-actions-confirm-label">Fork from here?</span>
          <button
            className="msg-action-btn msg-action-btn--confirm"
            onClick={handleFork}
            disabled={disabled}
            title="Confirm fork"
          >
            <svg
              width="10"
              height="10"
              viewBox="0 0 10 10"
              fill="none"
              aria-hidden="true"
            >
              <path
                d="M1.5 5.5L4 8L8.5 2"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
          <button
            className="msg-action-btn"
            onClick={() => setConfirmFork(false)}
            title="Cancel"
          >
            <svg
              width="10"
              height="10"
              viewBox="0 0 10 10"
              fill="none"
              aria-hidden="true"
            >
              <path
                d="M2 2L8 8M8 2L2 8"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </div>
      ) : (
        <>
          <CopyMessageButton content={content} />
          <button
            className="msg-action-btn"
            onClick={handleFork}
            disabled={disabled}
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
              {/* Git branch / fork icon */}
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
          <button
            className="msg-action-btn"
            onClick={handleEdit}
            disabled={disabled}
            data-tooltip="Edit"
            title="Edit this message and fork"
          >
            <svg
              width="12"
              height="12"
              viewBox="0 0 12 12"
              fill="none"
              aria-hidden="true"
            >
              {/* Pencil / edit icon */}
              <path
                d="M8.5 1.5L10.5 3.5L4 10H2V8L8.5 1.5Z"
                stroke="currentColor"
                strokeWidth="1.2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              <path
                d="M7 3L9 5"
                stroke="currentColor"
                strokeWidth="1.2"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </>
      )}
    </div>
  );
}
