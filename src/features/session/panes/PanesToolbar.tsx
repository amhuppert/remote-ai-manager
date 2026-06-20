"use client";

import { useCallback, useState } from "react";
import type { SessionActiveConversation } from "@/lib/active-conversations/schemas";
import { MAX_OPEN_TABS } from "@/features/session/tabs/open-tabs-model";
import AddConversationMenu from "@/features/session/tabs/AddConversationMenu";
import { cn } from "@/lib/ui/cn";

// Toolbar: a flex row with a bottom separator (single-side border zeroed on the
// other three sides — Preflight is OFF, §1.5).
const toolbarClass =
  "flex items-center gap-sm shrink-0 py-xs px-sm border-x-0 border-t-0 border-b border-solid border-border-subtle bg-bg-base";
const countClass =
  "shrink-0 text-text-primary font-mono text-[0.74rem] font-medium";
const hintClass = "shrink-0 text-text-tertiary font-mono text-[0.7rem]";

// Relative containing block for the absolutely-positioned AddConversationMenu
// popup, which anchors itself below-right of the trigger via its `placement`
// prop (no legacy descendant positioning rule).
const addWrapClass = "relative shrink-0";

// Add / exit buttons: 26px outlined controls. Not the Button primitive recipe
// (subtle border, secondary text, no font-weight, fixed height, bg-hover on
// hover — distinct from every `Button` variant), so authored locally.
const toolbarBtnBase =
  "inline-flex items-center h-[26px] px-sm border border-solid border-border-subtle rounded-sm bg-bg-surface text-text-secondary font-mono text-[0.72rem] cursor-pointer " +
  "[transition:background_0.15s_ease,color_0.15s_ease,border-color_0.15s_ease]";
const addBtnClass = cn(
  toolbarBtnBase,
  "enabled:hover:border-border-strong enabled:hover:bg-bg-hover enabled:hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-40",
);
const exitBtnClass = cn(
  toolbarBtnBase,
  "hover:border-border-strong hover:bg-bg-hover hover:text-text-primary",
);

export interface PanesToolbarProps {
  /** Current pane count (the working set length). */
  count: number;
  isAtCap: boolean;
  /** Active conversations not in the working set, for the embedded add-picker. */
  addableConversations: SessionActiveConversation[];
  /** Select a conversation → caller adds it and makes it active. */
  onAdd: (id: string) => void;
  /** Leave panes mode — the caller sets the layout back to "default". */
  onExit: () => void;
}

export default function PanesToolbar({
  count,
  isAtCap,
  addableConversations,
  onAdd,
  onExit,
}: PanesToolbarProps): React.JSX.Element {
  // Unlike the tab strip, the toolbar self-contains its add-picker per the
  // design — it owns the open state and anchors the menu to its own trigger.
  const [menuOpen, setMenuOpen] = useState(false);

  const handleAdd = useCallback(
    (id: string) => {
      onAdd(id);
      setMenuOpen(false);
    },
    [onAdd],
  );

  return (
    <div className={toolbarClass}>
      <span className={countClass}>
        {count} / {MAX_OPEN_TABS} panes
      </span>
      <span className={hintClass}>Replies go to the active pane</span>
      <div className="flex-1" />
      <div className={addWrapClass}>
        <button
          type="button"
          className={addBtnClass}
          aria-label="Add pane"
          disabled={isAtCap}
          title={
            isAtCap
              ? `Pane limit reached (${MAX_OPEN_TABS}) — close a pane first`
              : "Add pane"
          }
          onClick={() => setMenuOpen((open) => !open)}
        >
          Add pane
        </button>
        {menuOpen && !isAtCap ? (
          <AddConversationMenu
            addableConversations={addableConversations}
            onAdd={handleAdd}
            onClose={() => setMenuOpen(false)}
            placement="below-trigger-right"
          />
        ) : null}
      </div>
      <button
        type="button"
        className={exitBtnClass}
        aria-label="Exit panes"
        title="Exit panes"
        onClick={onExit}
      >
        Exit
      </button>
    </div>
  );
}
