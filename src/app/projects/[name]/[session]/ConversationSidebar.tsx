"use client";

import { useState, useCallback, useEffect, useMemo, useRef } from "react";
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
import { tracedFetch } from "@/lib/traced-fetch";
import { useAppHotkey } from "@/hooks/useAppHotkey";

interface Props {
  projectName: string;
  sessionName: string;
  conversations: ConversationState[];
  activeConversationId: string;
  isFinished: boolean;
  mobileOpen?: boolean;
  onMobileClose?: () => void;
}

export default function ConversationSidebar({
  projectName,
  sessionName,
  conversations,
  activeConversationId,
  isFinished,
  mobileOpen,
  onMobileClose,
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

  // Sidebar toggle hotkey
  useAppHotkey("toggleSidebar", toggleCollapsed);

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

  // --- Rename conversation ---
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const editInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editingId && editInputRef.current) {
      editInputRef.current.focus();
      editInputRef.current.select();
    }
  }, [editingId]);

  const handleRenameStart = useCallback((convo: ConversationState) => {
    setEditingId(convo.id);
    setEditValue(convo.name ?? convo.summary ?? "");
  }, []);

  const handleRenameSubmit = useCallback(
    async (conversationId: string) => {
      const trimmed = editValue.trim();
      if (!trimmed) {
        setEditingId(null);
        return;
      }
      try {
        const res = await tracedFetch(
          `/api/projects/${encodeURIComponent(projectName)}/sessions/${encodeURIComponent(sessionName)}/conversations/${encodeURIComponent(conversationId)}/rename`,
          "rename-conversation-sidebar",
          {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name: trimmed }),
          },
        );
        if (res.ok) {
          router.refresh();
        }
      } catch {
        // Silently fail
      } finally {
        setEditingId(null);
      }
    },
    [editValue, projectName, sessionName, router],
  );

  const statusDot = (status: string) => {
    const cls =
      status === "running" ? "running" : status === "ready" ? "ready" : "idle";
    return <span className={`sidebar-dot ${cls}`} />;
  };

  return (
    <>
    {/* Backdrop for mobile drawer */}
    <div
      className={`convo-sidebar-backdrop${mobileOpen ? " visible" : ""}`}
      onClick={onMobileClose}
    />
    <div className={`convo-sidebar${collapsed ? " collapsed" : ""}${mobileOpen ? " mobile-open" : ""}`}>
      <div className="convo-sidebar-header">
        {(!collapsed || mobileOpen) && (
          <span className="convo-sidebar-title">Conversations</span>
        )}
        <button
          className="btn-icon-only convo-sidebar-toggle"
          onClick={toggleCollapsed}
          title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        >
          {collapsed ? "\u25B6" : "\u25C0"}
        </button>
        <button
          className="convo-sidebar-close"
          onClick={onMobileClose}
          title="Close"
        >
          &#10005;
        </button>
      </div>
      {(!collapsed || mobileOpen) && (
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
                  {editingId === convo.id ? (
                    <input
                      ref={editInputRef}
                      className="convo-rename-input"
                      value={editValue}
                      onChange={(e) => setEditValue(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          void handleRenameSubmit(convo.id);
                        } else if (e.key === "Escape") {
                          setEditingId(null);
                        }
                      }}
                      onBlur={() => void handleRenameSubmit(convo.id)}
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                      }}
                      maxLength={200}
                    />
                  ) : (
                    <div className="convo-sidebar-item-summary">
                      {convo.name ?? convo.summary ?? "New conversation"}
                    </div>
                  )}
                  <div className="convo-sidebar-item-meta">
                    {convo.promptCount} prompt
                    {convo.promptCount !== 1 ? "s" : ""}
                    {convo.source === "imported" && " \u00B7 imported"}
                  </div>
                </div>
                <button
                  className="btn-icon-only convo-sidebar-item-action"
                  title="Rename"
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    handleRenameStart(convo);
                  }}
                >
                  &#9998;
                </button>
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
    </>
  );
}
