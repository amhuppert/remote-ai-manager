"use client";

import { useCallback, useEffect, useRef } from "react";
import type { SessionActiveConversation } from "@/lib/active-conversations/schemas";

export interface ConversationTabProps {
  id: string;
  title: string;
  status: SessionActiveConversation["status"];
  active: boolean;
  hotkeyHint?: string;
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
  /** Open the tab's context menu at the cursor (viewport coordinates). */
  onContextMenu?: (point: { x: number; y: number }) => void;
  /** When true, the title is replaced with an inline rename input. */
  isEditing?: boolean;
  editValue?: string;
  onEditChange?: (value: string) => void;
  onEditCommit?: () => void;
  onEditCancel?: () => void;
}

export default function ConversationTab({
  id,
  title,
  status,
  active,
  hotkeyHint,
  onActivate,
  onClose,
  onContextMenu,
  isEditing = false,
  editValue = "",
  onEditChange,
  onEditCommit,
  onEditCancel,
}: ConversationTabProps): React.JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!isEditing) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [isEditing]);

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

  const handleContextMenu = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      if (!onContextMenu) return;
      event.preventDefault();
      onContextMenu({ x: event.clientX, y: event.clientY });
    },
    [onContextMenu],
  );

  return (
    <div
      className="conversation-tab"
      role="tab"
      aria-selected={active}
      data-active={active ? "true" : undefined}
      tabIndex={0}
      onClick={isEditing ? undefined : () => onActivate(id)}
      onKeyDown={isEditing ? undefined : handleKeyDown}
      onContextMenu={handleContextMenu}
    >
      <span
        className="conversation-tab__dot"
        data-status={status}
        aria-hidden="true"
      />
      {isEditing ? (
        <input
          ref={inputRef}
          className="conversation-tab__rename-input"
          aria-label="Rename conversation"
          value={editValue}
          maxLength={200}
          onClick={(event) => event.stopPropagation()}
          onChange={(event) => onEditChange?.(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              onEditCommit?.();
            } else if (event.key === "Escape") {
              event.stopPropagation();
              onEditCancel?.();
            }
          }}
          onBlur={() => onEditCommit?.()}
        />
      ) : (
        <>
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
        </>
      )}
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
