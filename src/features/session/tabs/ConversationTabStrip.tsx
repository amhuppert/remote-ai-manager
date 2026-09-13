"use client";

import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";
import type { SessionActiveConversation } from "@/lib/active-conversations/schemas";
import {
  useGenericRenameConversationMutation,
  useGenerateConversationNameMutation,
  useGenericArchiveConversationMutation,
  useArchiveOtherConversationsMutation,
} from "@/lib/conversations/mutations";
import { useGenericArchiveSessionMutation } from "@/lib/sessions/mutations";
import { copyConversationRefToClipboard } from "@/lib/conversations/copy-conversation-ref";
import { copyConversationContextToClipboard } from "@/lib/conversations/copy-context-client";
import {
  useSidebarSessionFilter,
  useSetSidebarSessionFilter,
} from "@/stores/session-detail.store";
import { useSidebarActiveListFilter } from "@/hooks/use-sidebar-persistent-filters";
import ConfirmDialog from "@/components/ConfirmDialog";
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
} from "@/components/ui/ContextMenu";
import {
  ConversationRowMenuItems,
  buildConversationRowMenuItems,
} from "@/components/session/sidebar/conversation-row-menu";
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
  "flex items-center gap-2xs h-[36px] max-768:h-[48px] px-sm border-x-0 border-t-0 border-b border-solid border-border-subtle bg-bg-base overflow-x-auto";

const addClass =
  "inline-flex items-center justify-center w-[24px] h-[24px] max-768:size-[44px] border border-solid border-border-dim rounded-md bg-transparent text-text-secondary font-mono text-[0.9rem] leading-none cursor-pointer shrink-0 transition-colors duration-150 ease-[ease] " +
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
  const router = useRouter();
  const renameMutation = useGenericRenameConversationMutation();
  const generateNameMutation = useGenerateConversationNameMutation();
  const archiveMutation = useGenericArchiveConversationMutation();
  const archiveOthersMutation = useArchiveOtherConversationsMutation();
  const archiveSessionMutation = useGenericArchiveSessionMutation();
  const sidebarSessionFilter = useSidebarSessionFilter();
  const setSidebarSessionFilter = useSetSidebarSessionFilter();
  const [activeListFilter, setActiveListFilter] = useSidebarActiveListFilter();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [pendingArchiveSession, setPendingArchiveSession] = useState<{
    projectName: string;
    sessionName: string;
  } | null>(null);

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

  // Same structure as the Active Conversations sidebar menu (shared builder);
  // tab-specific handlers slot in where the surfaces differ. Open-in-tab/pane
  // are omitted — the clicked conversation already is a tab.
  const buildTabMenuItems = useCallback(
    (conversation: SessionActiveConversation) => {
      const sessionFilterActive =
        activeListFilter === "session" &&
        sidebarSessionFilter?.projectName === conversation.projectName &&
        sidebarSessionFilter?.sessionName === conversation.sessionName;
      return buildConversationRowMenuItems(
        {
          scope: "session",
          sessionName: conversation.sessionName,
          branchName: conversation.branchName,
          worktreePath: conversation.worktreePath,
          archived: conversation.archived ?? false,
          approvalGatePending: conversation.pendingApproval !== null,
        },
        {
          onOpenConversation: () => onActivate(conversation.id),
          onOpenProjectPage: () => {
            router.push(
              `/projects/${encodeURIComponent(conversation.projectName)}`,
            );
          },
          sessionFilter: {
            active: sessionFilterActive,
            onSelect: () => {
              setSidebarSessionFilter({
                projectName: conversation.projectName,
                sessionName: conversation.sessionName,
              });
              setActiveListFilter("session");
            },
          },
          onCopyContext: () => {
            void copyConversationContextToClipboard({
              projectName: conversation.projectName,
              sessionName: conversation.sessionName,
              conversationId: conversation.id,
            });
          },
          onCopyReference: () => {
            void copyConversationRefToClipboard(conversation.id);
          },
          onRename: () => startRename(conversation),
          onRegenerateName: () => {
            generateNameMutation.mutate({
              projectName: conversation.projectName,
              sessionName: conversation.sessionName,
              conversationId: conversation.id,
            });
          },
          onToggleArchived: () => {
            archiveMutation.mutate({
              projectName: conversation.projectName,
              sessionName: conversation.sessionName,
              conversationId: conversation.id,
              archived: !conversation.archived,
            });
          },
          onArchiveOthers: () => {
            archiveOthersMutation.mutate({
              projectName: conversation.projectName,
              sessionName: conversation.sessionName,
              conversationId: conversation.id,
            });
          },
          onArchiveSession: () => {
            setPendingArchiveSession({
              projectName: conversation.projectName,
              sessionName: conversation.sessionName,
            });
          },
        },
      );
    },
    [
      activeListFilter,
      archiveMutation,
      archiveOthersMutation,
      generateNameMutation,
      onActivate,
      router,
      setActiveListFilter,
      setSidebarSessionFilter,
      sidebarSessionFilter,
      startRename,
    ],
  );

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
              hotkeyHint={index < 9 ? `G ${index + 1}` : undefined}
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
            <ConversationRowMenuItems items={buildTabMenuItems(conversation)} />
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
      <ConfirmDialog
        open={pendingArchiveSession !== null}
        title="Archive session"
        message="This hides the session and all its conversations, and stops any running dev servers. You can unarchive it later to restore."
        confirmLabel="Archive session"
        onConfirm={() => {
          if (pendingArchiveSession === null) return;
          archiveSessionMutation.mutate({
            projectName: pendingArchiveSession.projectName,
            sessionName: pendingArchiveSession.sessionName,
            archived: true,
          });
          setPendingArchiveSession(null);
        }}
        onCancel={() => setPendingArchiveSession(null)}
      />
    </div>
  );
}
