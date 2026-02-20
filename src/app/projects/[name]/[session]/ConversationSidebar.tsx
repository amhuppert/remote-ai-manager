"use client";

import { useState, useCallback, useEffect, useMemo } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { ConversationState } from "@/types";
import {
  useCreateConversationMutation,
  useArchiveConversationMutation,
} from "@/lib/mutations";
import {
  useSidebarCollapsed,
  useToggleSidebar,
  useHydrateSidebar,
} from "@/stores/session-detail.store";

interface Props {
  projectName: string;
  sessionName: string;
  conversations: ConversationState[];
  activeConversationId: string;
  isFinished: boolean;
}

export default function ConversationSidebar({
  projectName,
  sessionName,
  conversations,
  activeConversationId,
  isFinished,
}: Props): React.JSX.Element {
  const router = useRouter();

  // --- Zustand ---
  const collapsed = useSidebarCollapsed();
  const toggleCollapsed = useToggleSidebar();
  const hydrateSidebar = useHydrateSidebar();

  // --- Mutations ---
  const createConvoMutation = useCreateConversationMutation(
    projectName,
    sessionName,
  );
  const archiveConvoMutation = useArchiveConversationMutation(
    projectName,
    sessionName,
  );

  // --- Local state ---
  const [showArchived, setShowArchived] = useState(false);

  const archivedCount = useMemo(
    () => conversations.filter((c) => c.archived).length,
    [conversations],
  );

  const filteredConversations = useMemo(() => {
    if (showArchived) return conversations;
    return conversations.filter((c) => !c.archived);
  }, [conversations, showArchived]);

  // Restore collapsed state from localStorage on mount
  useEffect(() => {
    hydrateSidebar();
  }, [hydrateSidebar]);

  const handleNewConversation = useCallback(() => {
    if (createConvoMutation.isPending || isFinished) return;
    createConvoMutation.mutate(undefined, {
      onSuccess: (convo) => {
        router.push(
          `/projects/${encodeURIComponent(projectName)}/${encodeURIComponent(sessionName)}/${convo.id}`,
        );
      },
    });
  }, [createConvoMutation, isFinished, projectName, sessionName, router]);

  const handleArchive = useCallback(
    (conversationId: string, archived: boolean) => {
      archiveConvoMutation.mutate({ conversationId, archived });
    },
    [archiveConvoMutation],
  );

  const statusDot = (status: string) => {
    const cls =
      status === "running" ? "running" : status === "ready" ? "ready" : "idle";
    return <span className={`sidebar-dot ${cls}`} />;
  };

  return (
    <div className={`convo-sidebar${collapsed ? " collapsed" : ""}`}>
      <div className="convo-sidebar-header">
        {!collapsed && (
          <span className="convo-sidebar-title">Conversations</span>
        )}
        <button
          className="btn-icon-only convo-sidebar-toggle"
          onClick={toggleCollapsed}
          title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        >
          {collapsed ? "\u25B6" : "\u25C0"}
        </button>
      </div>
      {!collapsed && (
        <>
          <div className="convo-sidebar-list">
            {filteredConversations.map((convo) => (
              <Link
                key={convo.id}
                href={`/projects/${encodeURIComponent(projectName)}/${encodeURIComponent(sessionName)}/${convo.id}`}
                className={`convo-sidebar-item${convo.id === activeConversationId ? " active" : ""}${convo.archived ? " archived" : ""}`}
              >
                {statusDot(convo.status)}
                <div className="convo-sidebar-item-body">
                  <div className="convo-sidebar-item-summary">
                    {convo.summary ?? "New conversation"}
                  </div>
                  <div className="convo-sidebar-item-meta">
                    {convo.promptCount} prompt
                    {convo.promptCount !== 1 ? "s" : ""}
                    {convo.source === "imported" && " \u00B7 imported"}
                  </div>
                </div>
                <button
                  className="btn-icon-only convo-sidebar-item-action"
                  title={convo.archived ? "Unarchive" : "Archive"}
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    handleArchive(convo.id, !convo.archived);
                  }}
                >
                  {convo.archived ? "\u21A9" : "\u2912"}
                </button>
              </Link>
            ))}
          </div>
          <div className="convo-sidebar-footer">
            {archivedCount > 0 && (
              <button
                className={`convo-sidebar-archive-toggle${showArchived ? " active" : ""}`}
                onClick={() => setShowArchived((v) => !v)}
                type="button"
              >
                Archived ({archivedCount})
              </button>
            )}
            <button
              className="btn btn-sm convo-sidebar-new"
              onClick={handleNewConversation}
              disabled={createConvoMutation.isPending || isFinished}
            >
              + New
            </button>
          </div>
        </>
      )}
    </div>
  );
}
