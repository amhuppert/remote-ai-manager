"use client";

import { useCallback, useEffect, useRef } from "react";
import type { SessionActiveConversation } from "@/lib/active-conversations/schemas";
import { useOverlayScope } from "@/hooks/useOverlayScope";
import { cn } from "@/lib/ui/cn";

type ConversationStatus = SessionActiveConversation["status"];

// The menu items, dots, and labels are utility-owned (docs/tailwind-conventions
// §1.3); the same transcription as the sibling ConversationTab dots/labels.
const itemClass =
  "flex items-center gap-xs w-full py-[8px] px-[10px] border-0 rounded-sm bg-transparent text-text-secondary font-mono text-[0.72rem] text-left cursor-pointer transition-colors duration-150 ease-[ease] " +
  "hover:bg-bg-hover hover:text-text-primary";

// Static class maps keyed by the status union (docs/tailwind-conventions §1.2):
// a `data-[status=…]` arbitrary variant can't carry the underscore in
// `waiting_for_input` (Tailwind rewrites `_` to a space), so per-status
// appearance is selected in JS. No base background — every status supplies one
// (legacy `bg-text-tertiary` was only a fallback for unlisted statuses, of which
// there are none); a base bg would tie on specificity and resolve by emission
// order rather than intent.
const dotBase = "w-[7px] h-[7px] rounded-full shrink-0";

const dotBgClass: Record<ConversationStatus, string> = {
  new: "bg-blue",
  running: "bg-cyan",
  awaiting: "bg-green",
  waiting_for_input: "bg-amber",
};

const dotGlowClass: Record<ConversationStatus, string> = {
  new: "shadow-[0_0_6px_var(--blue-glow)]",
  running: "shadow-[0_0_6px_var(--cyan-glow-strong)]",
  awaiting: "shadow-[0_0_6px_var(--green-glow)]",
  waiting_for_input: "shadow-[0_0_6px_var(--amber-glow)]",
};

const bodyClass = "flex flex-col gap-2xs min-w-0";
const titleClass = "overflow-hidden text-ellipsis whitespace-nowrap";
const projectClass =
  "overflow-hidden text-ellipsis whitespace-nowrap text-text-tertiary text-[0.68rem]";
const emptyClass =
  "py-[8px] px-[10px] text-text-tertiary font-mono text-[0.72rem]";

// The popup root owns its own appearance (utility-owned, §1.3): absolute box,
// elevated surface, and the menu drop-shadow (`shadow-menu` → --cc-shadow-menu,
// the exact legacy `0 12px 32px rgba(0,0,0,0.35)` value).
const rootClass =
  "absolute z-[90] min-w-[240px] max-w-[320px] p-[4px] border border-solid border-border-default rounded-md bg-bg-elevated shadow-menu";

// Per-host anchoring (§2 — the popup positions itself relative to its `relative`
// host). The tab strip uses the menu's static position; the panes toolbar drops
// it below-right of its `+` trigger (the former `.panes-toolbar__add-wrap
// .add-conversation-menu { top; right }` descendant rule, reattached here).
const placementClass: Record<"static" | "below-trigger-right", string> = {
  static: "",
  "below-trigger-right": "top-[calc(100%_+_var(--space-2xs))] right-0",
};

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
  /**
   * Where the popup anchors inside its `relative` host. `"static"` (the tab
   * strip) uses the menu's in-flow absolute position; `"below-trigger-right"`
   * (the panes toolbar) drops it below-right of the trigger.
   */
  placement?: "static" | "below-trigger-right";
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
  placement = "static",
}: AddConversationMenuProps): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);

  // Registers in the overlay stack so background page hotkeys (the panes-exit
  // Escape, R8.3) are suppressed while open and Escape closes this menu first.
  // The menu is only mounted when open, so `open` is unconditionally true.
  useOverlayScope(true, { onEscape: onClose });

  // Click-outside dismissal — mirrors the SessionActionsMenu idiom. Capture
  // phase so the listener sees the event even if a child stops propagation;
  // cleaned up on unmount.
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
    <div
      className={cn(rootClass, placementClass[placement])}
      role="menu"
      ref={containerRef}
    >
      {addableConversations.length === 0 ? (
        <div className={emptyClass}>No conversations to add</div>
      ) : (
        addableConversations.map((conversation) => (
          <button
            key={conversation.id}
            type="button"
            role="menuitem"
            className={itemClass}
            onClick={() => handleSelect(conversation.id)}
          >
            <span
              className={cn(
                dotBase,
                dotBgClass[conversation.status],
                dotGlowClass[conversation.status],
              )}
              aria-hidden="true"
            />
            <span className={bodyClass}>
              <span className={titleClass}>{titleFor(conversation)}</span>
              <span className={projectClass}>{conversation.projectName}</span>
            </span>
          </button>
        ))
      )}
    </div>
  );
}
