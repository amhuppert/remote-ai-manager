"use client";

import { useCallback, useMemo, useState } from "react";
import type { SessionActiveConversation } from "@/lib/active-conversations/schemas";
import { useGenericRenameConversationMutation } from "@/lib/conversations/mutations";
import ConversationSidebarRowContextMenu, {
  type ContextMenuItem,
} from "@/features/session/sidebar/ConversationSidebarRowContextMenu";
import ConversationTab from "./ConversationTab";

export interface ConversationTabStripProps {
  workingSet: SessionActiveConversation[];
  activeId: string;
  isAtCap: boolean;
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
  onAddClick: () => void;
}

// Mirrors the fallback in pane-view-model so tabs and panes label an unnamed
// conversation identically; kept in sync deliberately.
const UNTITLED = "Untitled conversation";

function tabTitle(conversation: SessionActiveConversation): string {
  return conversation.name && conversation.name.trim()
    ? conversation.name
    : UNTITLED;
}

export default function ConversationTabStrip({
  workingSet,
  activeId,
  isAtCap,
  onActivate,
  onClose,
  onAddClick,
}: ConversationTabStripProps): React.JSX.Element {
  const renameMutation = useGenericRenameConversationMutation();
  const [ctxMenu, setCtxMenu] = useState<{
    id: string;
    x: number;
    y: number;
  } | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");

  const startRename = useCallback((conversation: SessionActiveConversation) => {
    setEditingId(conversation.id);
    setEditValue(conversation.name ?? "");
  }, []);

  const cancelRename = useCallback(() => setEditingId(null), []);

  const commitRename = useCallback(() => {
    const conversation = workingSet.find((c) => c.id === editingId);
    const trimmed = editValue.trim();
    // Only persist a real change — an empty or unchanged value is a no-op so we
    // never clear a name or fire a redundant request on blur.
    if (conversation && trimmed && trimmed !== conversation.name) {
      renameMutation.mutate({
        projectName: conversation.projectName,
        sessionName: conversation.sessionName,
        conversationId: conversation.id,
        name: trimmed,
      });
    }
    setEditingId(null);
  }, [workingSet, editingId, editValue, renameMutation]);

  const menuItems = useMemo<ContextMenuItem[]>(() => {
    if (ctxMenu === null) return [];
    const conversation = workingSet.find((c) => c.id === ctxMenu.id);
    if (conversation === undefined) return [];
    return [
      {
        kind: "item",
        label: "Rename…",
        onSelect: () => startRename(conversation),
      },
    ];
  }, [ctxMenu, workingSet, startRename]);

  return (
    <div className="conversation-tab-strip" role="tablist">
      {workingSet.map((conversation, index) => (
        <ConversationTab
          key={conversation.id}
          id={conversation.id}
          title={tabTitle(conversation)}
          status={conversation.status}
          active={conversation.id === activeId}
          hotkeyHint={index < 9 ? `⌘${index + 1}` : undefined}
          onActivate={onActivate}
          onClose={onClose}
          onContextMenu={(point) =>
            setCtxMenu({ id: conversation.id, x: point.x, y: point.y })
          }
          isEditing={editingId === conversation.id}
          editValue={editValue}
          onEditChange={setEditValue}
          onEditCommit={commitRename}
          onEditCancel={cancelRename}
        />
      ))}
      <button
        type="button"
        className="conversation-tab-strip__add"
        aria-label="Add conversation"
        disabled={isAtCap}
        title={
          isAtCap
            ? "Tab limit reached (6) — close a tab first"
            : "Add conversation"
        }
        onClick={onAddClick}
      >
        +
      </button>
      {ctxMenu !== null && (
        <ConversationSidebarRowContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          items={menuItems}
          onClose={() => setCtxMenu(null)}
        />
      )}
    </div>
  );
}
