"use client";

import { useState } from "react";
import {
  EmptyState,
  EmptyStateDesc,
  EmptyStateTitle,
} from "@/components/ui/EmptyState";
import { Button } from "@/components/ui/Button";
import type { SessionActiveConversation } from "@/lib/active-conversations/schemas";
import AddConversationMenu from "./AddConversationMenu";

export interface EmptyConversationWorkingSetProps {
  addableConversations: SessionActiveConversation[];
  onAdd: (id: string) => void;
}

const rootClass = "relative flex min-h-0 flex-1 bg-bg-base";
const actionHostClass = "relative mt-lg";

export default function EmptyConversationWorkingSet({
  addableConversations,
  onAdd,
}: EmptyConversationWorkingSetProps): React.JSX.Element {
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <div className={rootClass}>
      <EmptyState layoutClassName="min-h-0 flex-1">
        <EmptyStateTitle role="heading" aria-level={2}>
          No conversations open
        </EmptyStateTitle>
        <EmptyStateDesc>
          Add an active conversation to the working set to continue.
        </EmptyStateDesc>
        <div className={actionHostClass}>
          <Button
            type="button"
            variant="primary"
            autoFocus
            touch
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((open) => !open)}
          >
            Add conversation
          </Button>
          {menuOpen ? (
            <AddConversationMenu
              addableConversations={addableConversations}
              onAdd={onAdd}
              onClose={() => setMenuOpen(false)}
              placement="below-trigger-right"
            />
          ) : null}
        </div>
      </EmptyState>
    </div>
  );
}
