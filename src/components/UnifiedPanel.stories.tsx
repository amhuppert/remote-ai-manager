import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { fn } from "storybook/test";
import Link from "next/link";

// ---------------------------------------------------------------------------
// Presentational shell for stories (avoids hook dependencies)
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

interface ActiveConversation {
  id: string;
  name: string | null;
  status: "running" | "awaiting";
  lastActivityAt: string;
  projectName: string;
  projectPath: string;
  sessionName: string;
}

interface PanelShellProps {
  conversations: ActiveConversation[];
  onClose: () => void;
}

function PanelShell({ conversations, onClose }: PanelShellProps) {
  return (
    <>
      <div className="unified-panel-backdrop" onClick={onClose} />
      <aside className="unified-panel" style={{ position: "absolute" }}>
        <div className="unified-panel-header">
          <span className="unified-panel-title">Active Conversations</span>
          <button
            className="btn-icon-only unified-panel-close"
            onClick={onClose}
            title="Close panel"
          >
            &#10005;
          </button>
        </div>
        <div className="unified-panel-body">
          {conversations.length === 0 ? (
            <div className="unified-panel-empty">
              No active conversations.
              <br />
              <span className="unified-panel-empty-hint">
                Conversations with status running or awaiting will appear here.
              </span>
            </div>
          ) : (
            <ul className="unified-panel-list">
              {conversations.map((convo) => (
                <li key={convo.id}>
                  <Link
                    href={`/projects/${encodeURIComponent(convo.projectName)}/${encodeURIComponent(convo.sessionName)}/${convo.id}`}
                    className="unified-panel-item"
                  >
                    <span
                      className={`unified-panel-dot ${convo.status}`}
                      title={convo.status}
                    />
                    <div className="unified-panel-item-body">
                      <div className="unified-panel-item-name">
                        {convo.name ?? "Unnamed conversation"}
                      </div>
                      <div className="unified-panel-item-meta">
                        {convo.projectName} / {convo.sessionName}
                      </div>
                    </div>
                    <div className="unified-panel-item-time">
                      {formatRelativeTime(convo.lastActivityAt)}
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      </aside>
    </>
  );
}

// ---------------------------------------------------------------------------
// Meta
// ---------------------------------------------------------------------------

const meta = {
  title: "Components/UnifiedPanel",
  component: PanelShell,
  args: {
    onClose: fn(),
  },
  decorators: [
    (Story) => (
      <div style={{ position: "relative", height: 500, width: 400 }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof PanelShell>;

export default meta;
type Story = StoryObj<typeof meta>;

const now = new Date().toISOString();
const twoMinAgo = new Date(Date.now() - 2 * 60_000).toISOString();
const tenMinAgo = new Date(Date.now() - 10 * 60_000).toISOString();
const oneHourAgo = new Date(Date.now() - 60 * 60_000).toISOString();

// ---------------------------------------------------------------------------
// Stories
// ---------------------------------------------------------------------------

export const Empty = {
  args: {
    conversations: [],
  },
} satisfies Story;

export const RunningConversations = {
  args: {
    conversations: [
      {
        id: "conv-1",
        name: "Implementing auth flow",
        status: "running",
        lastActivityAt: now,
        projectName: "my-app",
        projectPath: "/home/user/my-app",
        sessionName: "auth-feature",
      },
      {
        id: "conv-2",
        name: "Fix CSS layout bug",
        status: "running",
        lastActivityAt: twoMinAgo,
        projectName: "dashboard",
        projectPath: "/home/user/dashboard",
        sessionName: "bugfix-layout",
      },
    ],
  },
} satisfies Story;

export const AwaitingConversations = {
  args: {
    conversations: [
      {
        id: "conv-3",
        name: "Database migration",
        status: "awaiting",
        lastActivityAt: tenMinAgo,
        projectName: "backend-api",
        projectPath: "/home/user/backend-api",
        sessionName: "db-migration",
      },
      {
        id: "conv-4",
        name: null,
        status: "awaiting",
        lastActivityAt: oneHourAgo,
        projectName: "my-app",
        projectPath: "/home/user/my-app",
        sessionName: "refactor-utils",
      },
    ],
  },
} satisfies Story;

export const MixedStates = {
  args: {
    conversations: [
      {
        id: "conv-5",
        name: "Adding unit tests for auth module",
        status: "running",
        lastActivityAt: now,
        projectName: "my-app",
        projectPath: "/home/user/my-app",
        sessionName: "auth-feature",
      },
      {
        id: "conv-6",
        name: "Database migration scripts",
        status: "awaiting",
        lastActivityAt: twoMinAgo,
        projectName: "backend-api",
        projectPath: "/home/user/backend-api",
        sessionName: "db-migration",
      },
      {
        id: "conv-7",
        name: "Performance optimization",
        status: "running",
        lastActivityAt: tenMinAgo,
        projectName: "dashboard",
        projectPath: "/home/user/dashboard",
        sessionName: "perf-opt",
      },
      {
        id: "conv-8",
        name: null,
        status: "awaiting",
        lastActivityAt: oneHourAgo,
        projectName: "my-app",
        projectPath: "/home/user/my-app",
        sessionName: "refactor-utils",
      },
    ],
  },
} satisfies Story;
