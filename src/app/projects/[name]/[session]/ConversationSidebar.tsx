"use client";

import { useState, useCallback, useEffect, useMemo } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { ConversationState } from "@/types";
import { tracedFetch } from "@/lib/traced-fetch";
import { useAppHotkey } from "@/hooks/useAppHotkey";

interface Props {
  projectName: string;
  sessionName: string;
  conversations: ConversationState[];
  activeConversationId: string;
  isFinished: boolean;
}

const STORAGE_KEY = "csm-sidebar-collapsed";

export default function ConversationSidebar({
  projectName,
  sessionName,
  conversations,
  activeConversationId,
  isFinished,
}: Props): React.JSX.Element {
  const router = useRouter();
  const [collapsed, setCollapsed] = useState(false);
  const [creating, setCreating] = useState(false);
  const [showArchived, setShowArchived] = useState(false);

  const archivedCount = useMemo(
    () => conversations.filter((c) => c.archived).length,
    [conversations],
  );

  const filteredConversations = useMemo(() => {
    if (showArchived) return conversations;
    return conversations.filter((c) => !c.archived);
  }, [conversations, showArchived]);

  // Restore collapsed state from localStorage
  useEffect(() => {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === "true") setCollapsed(true);
  }, []);

  const toggleCollapsed = useCallback(() => {
    setCollapsed((prev) => {
      const next = !prev;
      localStorage.setItem(STORAGE_KEY, String(next));
      return next;
    });
  }, []);

  useAppHotkey("toggleSidebar", toggleCollapsed);

  const handleNewConversation = useCallback(async () => {
    if (creating || isFinished) return;
    setCreating(true);
    try {
      const res = await tracedFetch(
        `/api/projects/${encodeURIComponent(projectName)}/sessions/${encodeURIComponent(sessionName)}/conversations`,
        "create-conversation-sidebar",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
        },
      );
      if (res.ok) {
        const convo = (await res.json()) as ConversationState;
        router.push(
          `/projects/${encodeURIComponent(projectName)}/${encodeURIComponent(sessionName)}/${convo.id}`,
        );
      }
    } catch {
      // Silently fail
    } finally {
      setCreating(false);
    }
  }, [creating, isFinished, projectName, sessionName, router]);

  const handleArchive = useCallback(
    async (conversationId: string, archived: boolean) => {
      try {
        const res = await tracedFetch(
          `/api/projects/${encodeURIComponent(projectName)}/sessions/${encodeURIComponent(sessionName)}/conversations/${encodeURIComponent(conversationId)}/archive`,
          "archive-conversation-sidebar",
          {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ archived }),
          },
        );
        if (res.ok) {
          router.refresh();
        }
      } catch {
        // Silently fail
      }
    },
    [projectName, sessionName, router],
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
                    void handleArchive(convo.id, !convo.archived);
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
              onClick={() => void handleNewConversation()}
              disabled={creating || isFinished}
            >
              + New
            </button>
          </div>
        </>
      )}
    </div>
  );
}
