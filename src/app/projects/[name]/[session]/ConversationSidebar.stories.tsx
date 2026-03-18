import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { fn } from "storybook/test";
import { useState, useEffect, useRef } from "react";
import Link from "next/link";

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
// Types
// ---------------------------------------------------------------------------

interface SessionConversation {
  id: string;
  name: string | null;
  summary: string | null;
  status: string;
  promptCount: number;
  archived: boolean;
  source?: string;
  lastActivityAt: string;
}

interface ActiveConversation {
  id: string;
  name: string | null;
  status: "running" | "awaiting";
  lastActivityAt: string;
  projectName: string;
  sessionName: string;
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface SidebarShellProps {
  conversations: SessionConversation[];
  activeConversations: ActiveConversation[];
  activeConversationId: string;
  projectName: string;
  sessionName: string;
  initialTab?: "session" | "active";
  onRename: (id: string) => void;
  onArchive: (id: string, archived: boolean) => void;
  onNewConversation: () => void;
  onToggleCollapse: () => void;
}

// ---------------------------------------------------------------------------
// Presentational Shell
// ---------------------------------------------------------------------------

function SidebarShell({
  conversations,
  activeConversations,
  activeConversationId,
  projectName,
  sessionName,
  initialTab = "session",
  onRename,
  onArchive,
  onNewConversation,
  onToggleCollapse,
}: SidebarShellProps) {
  const [activeTab, setActiveTab] = useState<"session" | "active">(initialTab);
  const [showArchived, setShowArchived] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const editInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editingId && editInputRef.current) {
      editInputRef.current.focus();
      editInputRef.current.select();
    }
  }, [editingId]);

  const archivedCount = conversations.filter((c) => c.archived).length;
  const filteredConversations = showArchived
    ? conversations
    : conversations.filter((c) => !c.archived);

  const handleRenameStart = (id: string, name: string) => {
    setEditingId(id);
    setEditValue(name);
  };

  const handleRenameSubmit = (id: string) => {
    if (editValue.trim()) {
      onRename(id);
    }
    setEditingId(null);
  };

  return (
    <div className="convo-sidebar" style={{ height: "100%" }}>
      <div className="cc-section-header convo-sidebar-header">
        <span className="cc-section-label">Conversations</span>
        <div className="cc-section-actions">
          <button
            className="btn-icon-only convo-sidebar-toggle"
            onClick={onToggleCollapse}
            data-tooltip="Collapse"
          >
            &#9664;
          </button>
        </div>
      </div>

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
          {activeConversations.length > 0 && (
            <span className="cc-tab-count">{activeConversations.length}</span>
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
                <span className={`sidebar-dot ${convo.status}`} />
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
                          handleRenameSubmit(convo.id);
                        } else if (e.key === "Escape") {
                          setEditingId(null);
                        }
                      }}
                      onBlur={() => handleRenameSubmit(convo.id)}
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
                    onArchive(convo.id, !convo.archived);
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
              onClick={onNewConversation}
            >
              + New
            </button>
          </div>
        </>
      ) : (
        <div className="convo-sidebar-list">
          {activeConversations.length === 0 ? (
            <div className="convo-sidebar-empty">
              No active conversations.
              <span className="convo-sidebar-empty-hint">
                Running or awaiting conversations will appear here.
              </span>
            </div>
          ) : (
            activeConversations.map((convo) => (
              <Link
                key={convo.id}
                href={`/projects/${encodeURIComponent(convo.projectName)}/${encodeURIComponent(convo.sessionName)}/${convo.id}`}
                className="convo-sidebar-item"
              >
                <span className={`sidebar-dot ${convo.status}`} />
                <div className="convo-sidebar-item-body">
                  <div className="convo-sidebar-item-name-row">
                    {editingId === convo.id ? (
                      <input
                        ref={editInputRef}
                        className="convo-rename-input"
                        value={editValue}
                        onChange={(e) => setEditValue(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            e.preventDefault();
                            handleRenameSubmit(convo.id);
                          } else if (e.key === "Escape") {
                            setEditingId(null);
                          }
                        }}
                        onBlur={() => handleRenameSubmit(convo.id)}
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
                  {editingId !== convo.id && (
                    <div className="convo-sidebar-active-meta">
                      <span
                        className="convo-sidebar-meta-chip"
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
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
                    handleRenameStart(convo.id, convo.name ?? "");
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
                    onArchive(convo.id, true);
                  }}
                >
                  {"\u2913"}
                </button>
              </Link>
            ))
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Meta
// ---------------------------------------------------------------------------

const meta = {
  title: "Session/ConversationSidebar",
  component: SidebarShell,
  args: {
    onRename: fn(),
    onArchive: fn(),
    onNewConversation: fn(),
    onToggleCollapse: fn(),
    projectName: "remote-ai-manager",
    sessionName: "unified-view",
  },
  decorators: [
    (Story) => (
      <div
        style={{
          height: 600,
          width: 260,
          position: "relative",
          background: "var(--bg-void)",
        }}
      >
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof SidebarShell>;

export default meta;
type Story = StoryObj<typeof meta>;

// ---------------------------------------------------------------------------
// Test Data
// ---------------------------------------------------------------------------

const now = new Date().toISOString();
const twoMinAgo = new Date(Date.now() - 2 * 60_000).toISOString();
const tenMinAgo = new Date(Date.now() - 10 * 60_000).toISOString();
const twentyMinAgo = new Date(Date.now() - 21 * 60_000).toISOString();
const oneHourAgo = new Date(Date.now() - 60 * 60_000).toISOString();
const tenHoursAgo = new Date(Date.now() - 600 * 60_000).toISOString();

const sessionConversations: SessionConversation[] = [
  {
    id: "conv-1",
    name: "Validate impl",
    summary: "Validate implementation",
    status: "awaiting",
    promptCount: 1,
    archived: false,
    lastActivityAt: tenMinAgo,
  },
  {
    id: "conv-2",
    name: "Impl",
    summary: "Implementation work",
    status: "running",
    promptCount: 3,
    archived: false,
    lastActivityAt: twoMinAgo,
  },
  {
    id: "conv-3",
    name: "Plan",
    summary: "Planning session",
    status: "idle",
    promptCount: 7,
    archived: false,
    lastActivityAt: oneHourAgo,
  },
  {
    id: "conv-4",
    name: "Research spike",
    summary: "Initial research",
    status: "idle",
    promptCount: 2,
    archived: true,
    lastActivityAt: tenHoursAgo,
  },
];

const activeConversations: ActiveConversation[] = [
  {
    id: "ac-1",
    name: "test container",
    status: "running",
    lastActivityAt: now,
    projectName: "remote-ai-manager",
    sessionName: "Dev containers",
  },
  {
    id: "ac-2",
    name: "Unnamed conversation",
    status: "awaiting",
    lastActivityAt: twoMinAgo,
    projectName: "creative-ai",
    sessionName: "container-test",
  },
  {
    id: "ac-3",
    name: "Auth with subscription",
    status: "running",
    lastActivityAt: twentyMinAgo,
    projectName: "remote-ai-manager",
    sessionName: "Dev containers",
  },
  {
    id: "ac-4",
    name: "Validate impl",
    status: "awaiting",
    lastActivityAt: oneHourAgo,
    projectName: "remote-ai-manager",
    sessionName: "Unified view",
  },
  {
    id: "ac-5",
    name: "Impl",
    status: "running",
    lastActivityAt: oneHourAgo,
    projectName: "remote-ai-manager",
    sessionName: "Unified view",
  },
  {
    id: "ac-6",
    name: "Plan",
    status: "awaiting",
    lastActivityAt: tenHoursAgo,
    projectName: "remote-ai-manager",
    sessionName: "Unified view",
  },
];

// ---------------------------------------------------------------------------
// Stories
// ---------------------------------------------------------------------------

export const SessionTab: Story = {
  args: {
    conversations: sessionConversations,
    activeConversations,
    activeConversationId: "conv-2",
    initialTab: "session",
  },
};

export const ActiveTab: Story = {
  args: {
    conversations: sessionConversations,
    activeConversations,
    activeConversationId: "conv-2",
    initialTab: "active",
  },
};

export const ActiveTabEmpty: Story = {
  args: {
    conversations: sessionConversations,
    activeConversations: [],
    activeConversationId: "conv-1",
    initialTab: "active",
  },
};
