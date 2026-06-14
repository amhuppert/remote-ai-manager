"use client";

import { useCallback, useEffect, useRef } from "react";
import type { SessionActiveConversation } from "@/lib/active-conversations/schemas";
import { useOverlayScope } from "@/hooks/useOverlayScope";

export interface AddConversationMenuProps {
  /**
   * Already filtered to "not in the working set" by the caller
   * (`useOpenTabs.addableConversations`). Rendered as-is — never re-filtered.
   */
  addableConversations: SessionActiveConversation[];
  /** Select an item → caller adds the conversation and makes it active. */
  onAdd: (id: string) => void;
  /** Dismiss the menu (Escape, click-outside, or after a selection). */
  onClose: () => void;
}

function titleFor(conversation: SessionActiveConversation): string {
  return conversation.name && conversation.name.trim()
    ? conversation.name
    : "Untitled conversation";
}

/**
 * The dropdown POPUP only — not a self-contained trigger. The tab strip
 * (task 3.2) and the panes toolbar (task 4.2) each own their own `+` button
 * and mount this menu when open, anchoring it near that trigger. This keeps a
 * single shared add-picker without duplicating the trigger button.
 */
export default function AddConversationMenu({
  addableConversations,
  onAdd,
  onClose,
}: AddConversationMenuProps): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);

  // Registers in the overlay stack so background page hotkeys (the panes-exit
  // Escape, R8.3) are suppressed while open and Escape closes this menu first.
  // The menu is only mounted when open, so `open` is unconditionally true.
  useOverlayScope(true, { onEscape: onClose });

  // Click-outside dismissal — mirrors the ModelSelector/SessionActionsMenu
  // idiom. Capture phase so the listener sees the event even if a child stops
  // propagation; cleaned up on unmount.
  useEffect(() => {
    const onMouseDown = (event: MouseEvent): void => {
      if (
        containerRef.current &&
        !containerRef.current.contains(event.target as Node)
      ) {
        onClose();
      }
    };
    document.addEventListener("mousedown", onMouseDown, { capture: true });
    return () =>
      document.removeEventListener("mousedown", onMouseDown, { capture: true });
  }, [onClose]);

  const handleSelect = useCallback(
    (id: string) => {
      onAdd(id);
      onClose();
    },
    [onAdd, onClose],
  );

  return (
    <div className="add-conversation-menu" role="menu" ref={containerRef}>
      {addableConversations.length === 0 ? (
        <div className="add-conversation-menu__empty">
          No conversations to add
        </div>
      ) : (
        addableConversations.map((conversation) => (
          <button
            key={conversation.id}
            type="button"
            role="menuitem"
            className="add-conversation-menu__item"
            onClick={() => handleSelect(conversation.id)}
          >
            <span
              className="add-conversation-menu__dot"
              data-status={conversation.status}
              aria-hidden="true"
            />
            <span className="add-conversation-menu__body">
              <span className="add-conversation-menu__title">
                {titleFor(conversation)}
              </span>
              <span className="add-conversation-menu__project">
                {conversation.projectName}
              </span>
            </span>
          </button>
        ))
      )}
    </div>
  );
}
