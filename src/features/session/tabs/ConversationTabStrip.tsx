"use client";

import { useCallback, useState } from "react";
import type { SessionActiveConversation } from "@/lib/active-conversations/schemas";
import { useGenericRenameConversationMutation } from "@/lib/conversations/mutations";
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
} from "@/components/ui/ContextMenu";
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

const stripClass =
  "flex items-center gap-2xs h-[36px] px-sm border-x-0 border-t-0 border-b border-solid border-border-subtle bg-bg-base overflow-x-auto";

const addClass =
  "inline-flex items-center justify-center w-[24px] h-[24px] border border-solid border-border-dim rounded-md bg-transparent text-text-secondary font-mono text-[0.9rem] leading-none cursor-pointer shrink-0 transition-colors duration-150 ease-[ease] " +
  "enabled:hover:bg-bg-hover enabled:hover:border-border-strong enabled:hover:text-text-primary " +
  "disabled:opacity-40 disabled:cursor-not-allowed";

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

  return (
    <div className={stripClass} role="tablist">
      {workingSet.map((conversation, index) => (
        // `contents` on the trigger keeps the tab as the flex item; Radix anchors
        // the menu at the cursor, so the trigger needs no box of its own.
        <ContextMenu key={conversation.id}>
          <ContextMenuTrigger className="contents">
            <ConversationTab
              id={conversation.id}
              title={tabTitle(conversation)}
              status={conversation.status}
              active={conversation.id === activeId}
              hotkeyHint={index < 9 ? `⌘${index + 1}` : undefined}
              onActivate={onActivate}
              onClose={onClose}
              isEditing={editingId === conversation.id}
              editValue={editValue}
              onEditChange={setEditValue}
              onEditCommit={commitRename}
              onEditCancel={cancelRename}
            />
          </ContextMenuTrigger>
          <ContextMenuContent>
            <ContextMenuItem onSelect={() => startRename(conversation)}>
              Rename…
            </ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
      ))}
      <button
        type="button"
        className={addClass}
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
    </div>
  );
}
