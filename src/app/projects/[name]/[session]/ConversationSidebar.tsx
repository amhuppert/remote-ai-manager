"use client";

import { useState, useCallback, useEffect, useMemo, useRef } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { ConversationState } from "@/types";
import {
  useActiveConversationsQuery,
  type ActiveConversation,
} from "@/lib/queries";
import {
  useCreateConversationMutation,
  useArchiveConversationMutation,
  useRenameConversationMutation,
  useGenericArchiveConversationMutation,
  useGenericRenameConversationMutation,
} from "@/lib/mutations";
import {
  useSidebarCollapsed,
  useToggleSidebar,
  useHydrateSidebar,
} from "@/stores/session-detail.store";
import { useAppHotkey } from "@/hooks/useAppHotkey";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatRelativeTime(isoDate: string): string {
  const diff = Date.now() - new Date(isoDate).getTime();
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

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

  // --- Active conversations query ---
  const { data: activeConversations } = useActiveConversationsQuery();
  const activeConvoList = useMemo(
    () => activeConversations ?? [],
    [activeConversations],
  );

  // --- Session mutations ---
  const createConvoMutation = useCreateConversationMutation(
    projectName,
    sessionName,
  );
  const archiveConvoMutation = useArchiveConversationMutation(
    projectName,
    sessionName,
  );
  const renameConvoMutation = useRenameConversationMutation(
    projectName,
    sessionName,
  );

  // --- Generic mutations (for active tab — different projects/sessions) ---
  const genericArchiveMutation = useGenericArchiveConversationMutation();
  const genericRenameMutation = useGenericRenameConversationMutation();

  // --- Local state ---
  const [activeTab, setActiveTab] = useState<"session" | "active">("active");
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

  const handleActiveArchive = useCallback(
    (convo: ActiveConversation, archived: boolean) => {
      genericArchiveMutation.mutate({
        projectName: convo.projectName,
        sessionName: convo.sessionName,
        conversationId: convo.id,
        archived,
      });
    },
    [genericArchiveMutation],
  );

  // --- Rename conversation (session tab) ---
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const editInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editingId && editInputRef.current) {
      editInputRef.current.focus();
      editInputRef.current.select();
    }
  }, [editingId]);

  const handleRenameStart = useCallback((id: string, name: string) => {
    setEditingId(id);
    setEditValue(name);
  }, []);

  const handleRenameSubmit = useCallback(
    (conversationId: string) => {
      const trimmed = editValue.trim();
      if (!trimmed) {
        setEditingId(null);
        return;
      }
      renameConvoMutation.mutate(
        { conversationId, name: trimmed },
        { onSettled: () => setEditingId(null) },
      );
    },
    [editValue, renameConvoMutation],
  );

  // --- Rename for active tab conversations ---
  const [activeEditingId, setActiveEditingId] = useState<string | null>(null);
  const [activeEditValue, setActiveEditValue] = useState("");
  const activeEditInputRef = useRef<HTMLInputElement>(null);
  const activeEditConvoRef = useRef<ActiveConversation | null>(null);

  useEffect(() => {
    if (activeEditingId && activeEditInputRef.current) {
      activeEditInputRef.current.focus();
      activeEditInputRef.current.select();
    }
  }, [activeEditingId]);

  const handleActiveRenameStart = useCallback((convo: ActiveConversation) => {
    setActiveEditingId(convo.id);
    setActiveEditValue(convo.name ?? "");
    activeEditConvoRef.current = convo;
  }, []);

  const handleActiveRenameSubmit = useCallback(
    (conversationId: string) => {
      const trimmed = activeEditValue.trim();
      if (!trimmed || !activeEditConvoRef.current) {
        setActiveEditingId(null);
        return;
      }
      genericRenameMutation.mutate(
        {
          projectName: activeEditConvoRef.current.projectName,
          sessionName: activeEditConvoRef.current.sessionName,
          conversationId,
          name: trimmed,
        },
        { onSettled: () => setActiveEditingId(null) },
      );
    },
    [activeEditValue, genericRenameMutation],
  );

  const statusDot = (status: string) => {
    return <span className={`sidebar-dot ${status}`} />;
  };

  return (
    <>
      {/* Backdrop for mobile drawer */}
      <div
        className={`convo-sidebar-backdrop${mobileOpen ? " visible" : ""}`}
        onClick={onMobileClose}
      />
      <div
        className={`convo-sidebar${collapsed ? " collapsed" : ""}${mobileOpen ? " mobile-open" : ""}`}
      >
        <div className="cc-section-header convo-sidebar-header">
          {(!collapsed || mobileOpen) && (
            <span className="cc-section-label">Conversations</span>
          )}
          <div className="cc-section-actions">
            <button
              className="btn-icon-only convo-sidebar-toggle"
              onClick={toggleCollapsed}
              data-tooltip={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            >
              {collapsed ? "\u25B6" : "\u25C0"}
            </button>
            <button
              className="convo-sidebar-close"
              onClick={onMobileClose}
              data-tooltip="Close"
            >
              &#10005;
            </button>
          </div>
        </div>
        {(!collapsed || mobileOpen) && (
          <>
            <div className="cc-tabs">
              <button
                className={`cc-tab${activeTab === "session" ? " active" : ""}`}
                onClick={() => setActiveTab("session")}
              >
                Session
              </button>
              <button
                className={`cc-tab${activeTab === "active" ? " active" : ""}`}
                onClick={() => setActiveTab("active")}
              >
                Active
                {activeConvoList.length > 0 && (
                  <span className="cc-tab-count">{activeConvoList.length}</span>
                )}
              </button>
            </div>

            {activeTab === "session" ? (
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
                                e.stopPropagation();
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
                            {convo.forkedFrom && (
                              <span
                                className="convo-sidebar-fork-icon"
                                data-tooltip={(() => {
                                  const source = conversations.find(
                                    (c) =>
                                      c.id ===
                                      convo.forkedFrom?.sourceConversationId,
                                  );
                                  const sourceName =
                                    source?.name ?? "deleted conversation";
                                  const turn =
                                    Math.floor(
                                      convo.forkedFrom.messageIndex / 2,
                                    ) + 1;
                                  return `Forked from ${sourceName} at turn ${turn}`;
                                })()}
                              >
                                <svg
                                  width="10"
                                  height="10"
                                  viewBox="0 0 12 12"
                                  fill="none"
                                  aria-hidden="true"
                                >
                                  <circle
                                    cx="3"
                                    cy="2.5"
                                    r="1.5"
                                    stroke="currentColor"
                                    strokeWidth="1.2"
                                  />
                                  <circle
                                    cx="3"
                                    cy="9.5"
                                    r="1.5"
                                    stroke="currentColor"
                                    strokeWidth="1.2"
                                  />
                                  <circle
                                    cx="9"
                                    cy="4.5"
                                    r="1.5"
                                    stroke="currentColor"
                                    strokeWidth="1.2"
                                  />
                                  <path
                                    d="M3 4V8M3 5.5C3 5.5 3 4.5 5.5 4.5H7.5"
                                    stroke="currentColor"
                                    strokeWidth="1.2"
                                    strokeLinecap="round"
                                  />
                                </svg>
                              </span>
                            )}
                            {convo.name ?? convo.summary ?? "New conversation"}
                          </div>
                        )}
                        <div className="convo-sidebar-item-meta">
                          {convo.promptCount} prompt
                          {convo.promptCount !== 1 ? "s" : ""}
                          {convo.source === "imported" && " \u00B7 imported"}
                          {" \u00B7 "}
                          <span
                            className="convo-sidebar-id"
                            onClick={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              void navigator.clipboard.writeText(convo.id);
                            }}
                            title={convo.id}
                          >
                            {convo.id.slice(0, 8)}
                          </span>
                        </div>
                      </div>
                      <button
                        className="btn-icon-only convo-sidebar-item-action"
                        data-tooltip="Rename"
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          handleRenameStart(
                            convo.id,
                            convo.name ?? convo.summary ?? "",
                          );
                        }}
                      >
                        &#9998;
                      </button>
                      <button
                        className="btn-icon-only convo-sidebar-item-action"
                        data-tooltip={convo.archived ? "Unarchive" : "Archive"}
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          handleArchive(convo.id, !convo.archived);
                        }}
                      >
                        {convo.archived ? "\u21A9" : "\u2913"}
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
            ) : (
              <div className="convo-sidebar-list">
                {activeConvoList.length === 0 ? (
                  <div className="convo-sidebar-empty">
                    No active conversations.
                    <span className="convo-sidebar-empty-hint">
                      New, running, or awaiting conversations will appear here.
                    </span>
                  </div>
                ) : (
                  activeConvoList.map((convo) => (
                    <Link
                      key={convo.id}
                      href={`/projects/${encodeURIComponent(convo.projectName)}/${encodeURIComponent(convo.sessionName)}/${convo.id}`}
                      className={`convo-sidebar-item${convo.id === activeConversationId ? " active" : ""}`}
                    >
                      {statusDot(convo.status)}
                      <div className="convo-sidebar-item-body">
                        <div className="convo-sidebar-item-name-row">
                          {activeEditingId === convo.id ? (
                            <input
                              ref={activeEditInputRef}
                              className="convo-rename-input"
                              value={activeEditValue}
                              onChange={(e) =>
                                setActiveEditValue(e.target.value)
                              }
                              onKeyDown={(e) => {
                                if (e.key === "Enter") {
                                  e.preventDefault();
                                  void handleActiveRenameSubmit(convo.id);
                                } else if (e.key === "Escape") {
                                  e.stopPropagation();
                                  setActiveEditingId(null);
                                }
                              }}
                              onBlur={() =>
                                void handleActiveRenameSubmit(convo.id)
                              }
                              onClick={(e) => {
                                e.preventDefault();
                                e.stopPropagation();
                              }}
                              maxLength={200}
                              style={{ flex: 1 }}
                            />
                          ) : (
                            <>
                              <div className="convo-sidebar-item-summary">
                                {convo.name ?? "Unnamed conversation"}
                              </div>
                              <span className="convo-sidebar-active-time">
                                {formatRelativeTime(convo.lastActivityAt)}
                              </span>
                            </>
                          )}
                        </div>
                        {activeEditingId !== convo.id && (
                          <div className="convo-sidebar-active-meta">
                            <span
                              className="convo-sidebar-meta-chip"
                              onClick={(e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                router.push(
                                  `/projects/${encodeURIComponent(convo.projectName)}`,
                                );
                              }}
                              role="link"
                              tabIndex={0}
                            >
                              {convo.projectName}
                            </span>
                            <span className="convo-sidebar-meta-sep">/</span>
                            <span
                              className="convo-sidebar-meta-chip"
                              onClick={(e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                router.push(
                                  `/projects/${encodeURIComponent(convo.projectName)}/${encodeURIComponent(convo.sessionName)}`,
                                );
                              }}
                              role="link"
                              tabIndex={0}
                            >
                              {convo.sessionName}
                            </span>
                          </div>
                        )}
                      </div>
                      <button
                        className="btn-icon-only convo-sidebar-item-action"
                        data-tooltip="Rename"
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          handleActiveRenameStart(convo);
                        }}
                      >
                        &#9998;
                      </button>
                      <button
                        className="btn-icon-only convo-sidebar-item-action"
                        data-tooltip="Archive"
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          handleActiveArchive(convo, true);
                        }}
                      >
                        {"\u2913"}
                      </button>
                    </Link>
                  ))
                )}
              </div>
            )}
          </>
        )}
      </div>
    </>
  );
}
