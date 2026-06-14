"use client";

import { useCallback, useState } from "react";
import type { SessionActiveConversation } from "@/lib/active-conversations/schemas";
import { MAX_OPEN_TABS } from "@/features/session/tabs/open-tabs-model";
import AddConversationMenu from "@/features/session/tabs/AddConversationMenu";

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
    <div className="panes-toolbar">
      <span className="panes-toolbar__count">
        {count} / {MAX_OPEN_TABS} panes
      </span>
      <span className="panes-toolbar__hint">Replies go to the active pane</span>
      <div className="panes-toolbar__spacer" />
      <div className="panes-toolbar__add-wrap">
        <button
          type="button"
          className="panes-toolbar__add"
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
          />
        ) : null}
      </div>
      <button
        type="button"
        className="panes-toolbar__exit"
        aria-label="Exit panes"
        title="Exit panes"
        onClick={onExit}
      >
        Exit
      </button>
    </div>
  );
}
