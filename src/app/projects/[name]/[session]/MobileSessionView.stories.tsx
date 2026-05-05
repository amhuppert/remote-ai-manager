"use client";

import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { fn } from "storybook/test";
import { useState } from "react";
import MobileActionMenu from "@/components/MobileActionMenu";
import ModelSelector from "@/components/ModelSelector";
import { VoiceRecordButton } from "@/components/VoiceRecordButton";
import ConversationNav from "@/components/ConversationNav";
import { ContextFillIndicator } from "@/components/ContextFillIndicator";

/**
 * Full mobile session view mockup demonstrating the optimized mobile layout:
 * - Full-bleed conversation panel (no margins)
 * - Compact bottom bar with Info and Activity tabs
 * - Context fill bar below panel header
 * - Background step separator between prompt area and bottom bar
 * - Compact panel header (single row, no title)
 */
function MobileSessionViewDemo({
  messageCount = 3,
  sending = false,
  multilinePrompt = false,
  mobilePanel = "chat" as "chat" | "diff" | "info",
  contextPercent = 42,
}: {
  messageCount?: number;
  sending?: boolean;
  multilinePrompt?: boolean;
  mobilePanel?: "chat" | "diff" | "info";
  contextPercent?: number;
}) {
  const [text, setText] = useState(
    multilinePrompt
      ? "This is a multiline prompt that demonstrates the constrained textarea height on mobile. It should not grow beyond 120px, keeping the conversation visible above.\n\nThe user can scroll within the textarea to see all their text, but the conversation area remains usable.\n\nThis is the third paragraph to really push the height."
      : "",
  );
  const [model, setModel] = useState("sonnet");
  const [panel, setPanel] = useState(mobilePanel);

  const sampleMessages = [
    {
      role: "user" as const,
      content: "Can you help me refactor the authentication module?",
    },
    {
      role: "assistant" as const,
      content:
        "I'll help you refactor the authentication module. Let me first look at the current implementation to understand the structure.\n\nI've found the following files that need attention:\n- `src/lib/auth.ts` — main auth logic\n- `src/middleware.ts` — route protection\n- `src/lib/session.ts` — session management",
    },
    {
      role: "user" as const,
      content: "Focus on the session management first, it has the most issues.",
    },
    {
      role: "assistant" as const,
      content:
        "Looking at `src/lib/session.ts`, I can see several issues:\n\n1. **Stale session detection** — the timeout logic doesn't account for active WebSocket connections\n2. **Memory leak** — sessions aren't cleaned up when the browser tab closes\n3. **Race condition** — concurrent session refreshes can corrupt the token",
    },
  ].slice(0, messageCount);

  return (
    <div
      className="app"
      data-page="detail"
      data-mobile-panel={panel}
      style={{
        height: "100%",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
      }}
    >
      {/* Topbar — simplified mobile version */}
      <div
        className="topbar"
        style={{ flexShrink: 0, height: 56, minHeight: 56 }}
      >
        <div className="topbar-brand" style={{ flex: 1, minWidth: 0 }}>
          <span className="topbar-logo">CC</span>
          <div className="topbar-divider" />
          <nav
            className="topbar-breadcrumb"
            style={{ minWidth: 0, overflow: "hidden" }}
          >
            <span
              style={{
                color: "var(--text-tertiary)",
                fontSize: "1.4rem",
                flexShrink: 0,
              }}
            >
              {"\u2039"}
            </span>
            <a
              className="bc-last bc-session"
              href="#"
              style={{
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              fix-authentication-flow-issue
            </a>
          </nav>
        </div>
        <div className="topbar-status-session">
          <div className="status-indicator">
            <div className={`status-dot ${sending ? "cyan" : ""}`} />
          </div>
        </div>
      </div>

      {/* Main content area — full bleed */}
      <main
        className="main"
        style={{
          flex: 1,
          minHeight: 0,
          padding: 0,
          paddingBottom: 48,
        }}
      >
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            height: "100%",
          }}
        >
          <div style={{ flex: 1, minHeight: 0 }}>
            {/* Conversation panel */}
            {panel === "chat" && (
              <div
                className="prompt-panel"
                style={{
                  height: "100%",
                  display: "flex",
                  border: "none",
                  borderRadius: 0,
                }}
              >
                <div
                  className="panel-header"
                  style={{
                    padding: "var(--space-xs) var(--space-sm)",
                    gap: "var(--space-xs)",
                  }}
                >
                  <button
                    className="convo-sidebar-mobile-toggle"
                    style={{ display: "flex" }}
                  >
                    &#9776; Conversations
                  </button>
                  <ConversationNav
                    currentIndex={1}
                    totalCount={messageCount}
                    onFirst={fn()}
                    onPrevious={fn()}
                    onNext={fn()}
                    onLast={fn()}
                  />
                </div>

                {/* Context fill bar */}
                <div
                  className="mobile-context-fill"
                  style={{ display: "flex" }}
                >
                  <ContextFillIndicator percentage={contextPercent} />
                </div>

                {/* Messages */}
                <div
                  className="panel-body"
                  style={{ flex: 1, minHeight: 0, padding: "var(--space-sm)" }}
                >
                  <div className="conversation">
                    {sampleMessages.map((msg, i) => (
                      <div key={i} className={`message ${msg.role}`}>
                        <div className="message-role">
                          {msg.role === "user" ? "You" : "Claude"}
                        </div>
                        <div className="message-content">{msg.content}</div>
                      </div>
                    ))}
                    {sending && (
                      <div className="message assistant typing-indicator">
                        <div className="message-role">Claude</div>
                        <div className="message-content">
                          <div className="typing-dots">
                            <span />
                            <span />
                            <span />
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                </div>

                {/* Prompt input area — background step */}
                <div
                  className="prompt-input-area"
                  style={{
                    padding: "var(--space-xs) var(--space-sm)",
                    background: "rgba(11, 16, 25, 0.6)",
                    borderTop: "1px solid var(--border-default)",
                  }}
                >
                  <div className="prompt-input-wrapper">
                    <textarea
                      className="prompt-textarea"
                      placeholder="Send a prompt to Claude..."
                      rows={1}
                      value={text}
                      onChange={(e) => setText(e.target.value)}
                      style={{ maxHeight: 120 }}
                    />
                    <div className="prompt-toolbar">
                      <div className="prompt-toolbar-start">
                        <button
                          className="attachment-btn"
                          title="Attach image"
                          type="button"
                        >
                          <svg
                            width="16"
                            height="16"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          >
                            <path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
                          </svg>
                        </button>
                        <ModelSelector
                          value={model}
                          onChange={setModel}
                          disabled={sending}
                        />
                      </div>
                      <div className="prompt-toolbar-end">
                        <VoiceRecordButton
                          isRecording={false}
                          isProcessing={false}
                          elapsedTime={0}
                          isAvailable={true}
                          toggleRecording={fn()}
                          disabled={sending}
                        />
                        <button
                          className={`send-btn${sending ? " busy" : ""}`}
                          disabled={!text.trim() || sending}
                        >
                          {sending ? (
                            <div
                              className="spinner"
                              style={{
                                borderColor: "rgba(0, 229, 255, 0.3)",
                                borderTopColor: "var(--cyan)",
                                width: 18,
                                height: 18,
                              }}
                            />
                          ) : (
                            "\u25B6"
                          )}
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* Diff panel placeholder */}
            {panel === "diff" && (
              <div
                className="prompt-panel"
                style={{
                  height: "100%",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  border: "none",
                  borderRadius: 0,
                }}
              >
                <div className="empty-state">
                  <div className="empty-state-title">Diff Panel</div>
                  <div className="empty-state-desc">
                    Code changes would appear here.
                  </div>
                </div>
              </div>
            )}

            {/* Info panel */}
            {panel === "info" && (
              <div className="mobile-info-panel" style={{ display: "flex" }}>
                <div className="mobile-info-row">
                  <span className="mobile-info-label">Status</span>
                  <span className="mobile-info-value">
                    <span
                      className="status-dot"
                      style={{
                        width: 6,
                        height: 6,
                        display: "inline-block",
                        marginRight: 6,
                      }}
                    />
                    awaiting
                  </span>
                </div>
                <div className="mobile-info-row">
                  <span className="mobile-info-label">Branch</span>
                  <span className="mobile-info-value">
                    csm/fix-authentication-flow-issue
                  </span>
                </div>
                <div className="mobile-info-row">
                  <span className="mobile-info-label">Created</span>
                  <span className="mobile-info-value">Mar 18, 2:30 PM</span>
                </div>
                <div className="mobile-info-row">
                  <span className="mobile-info-label">Prompts</span>
                  <span className="mobile-info-value">7</span>
                </div>
                <div className="mobile-info-row">
                  <span className="mobile-info-label">Worktree</span>
                  <span className="mobile-info-value">
                    /home/user/projects/my-app/.worktrees/fix-auth
                  </span>
                </div>
                <div className="mobile-info-row">
                  <span className="mobile-info-label">Conv ID</span>
                  <span className="mobile-info-value">
                    9d0b1290-c2a6-4d9d-b62f-6e6637442d1e
                  </span>
                </div>
                <div className="mobile-info-row">
                  <span className="mobile-info-label">Context</span>
                  <span className="mobile-info-value">
                    <ContextFillIndicator percentage={42} />
                  </span>
                </div>
                <div className="mobile-info-actions">
                  <button
                    className="btn btn-sm"
                    style={{
                      display: "flex",
                      width: "100%",
                      justifyContent: "center",
                    }}
                  >
                    {"\u2398"} Copy Context
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </main>

      {/* Mobile bottom bar */}
      <div
        className="mobile-bottom-bar"
        style={{
          display: "flex",
          flexDirection: "row",
          alignItems: "center",
          gap: "var(--space-sm)",
          position: "fixed",
          bottom: 0,
          left: 0,
          right: 0,
          zIndex: 100,
          height: 48,
          padding: "0 var(--space-md)",
          background: "rgba(11, 16, 25, 0.92)",
          backdropFilter: "blur(16px) saturate(140%)",
          borderTop: "1px solid var(--border-subtle)",
        }}
      >
        <div
          className="cc-tabs"
          style={{
            flex: 1,
            minWidth: 0,
            overflowX: "auto",
            scrollbarWidth: "none",
          }}
        >
          {(["chat", "diff", "specs", "info"] as const).map((tab) => (
            <button
              key={tab}
              className={`cc-tab${panel === tab ? " active" : ""}`}
              onClick={() => setPanel(tab as typeof panel)}
              style={{
                minHeight: 32,
                padding: "4px 10px",
                fontSize: "0.7rem",
                flexShrink: 0,
              }}
            >
              {tab.charAt(0).toUpperCase() + tab.slice(1)}
            </button>
          ))}
          <button
            className="cc-tab"
            style={{
              minHeight: 32,
              padding: "4px 10px",
              fontSize: "0.7rem",
              flexShrink: 0,
            }}
          >
            {"\u26A1"}
            <span
              className="cc-tab-badge"
              style={{
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                minWidth: 16,
                height: 16,
                padding: "0 4px",
                borderRadius: 8,
                background: "var(--red)",
                color: "#fff",
                fontSize: "0.7rem",
                fontWeight: 700,
                fontFamily: "var(--font-mono)",
              }}
            >
              3
            </span>
          </button>
        </div>
        <MobileActionMenu
          tddEnabled={false}
          onTddToggle={fn()}
          commitDisabled={sending}
          mergeDisabled={sending}
          onCommit={fn()}
          onMerge={fn()}
          onDelete={fn()}
          devServerCounts={{ running: 1, total: 2 }}
          onDevServers={fn()}
        />
      </div>
    </div>
  );
}

const meta = {
  title: "Mobile/MobileSessionView",
  component: MobileSessionViewDemo,
  parameters: {
    viewport: {
      defaultViewport: "mobile1",
    },
    layout: "fullscreen",
  },
  decorators: [
    (Story) => (
      <div
        style={{
          width: 390,
          height: 667,
          margin: "0 auto",
          overflow: "hidden",
          position: "relative",
          border: "1px solid var(--border-subtle)",
          borderRadius: "var(--radius-lg)",
          background: "var(--bg-void)",
        }}
      >
        <style>{`
          .mobile-action-menu-trigger {
            display: flex !important;
            align-items: center;
            justify-content: center;
            width: 36px;
            height: 36px;
            border: 1px solid var(--border-subtle);
            border-radius: var(--radius-sm);
            background: transparent;
            color: var(--text-secondary);
            font-size: 1.1rem;
            cursor: pointer;
            padding: 0;
            line-height: 1;
            letter-spacing: 2px;
          }
          .mobile-action-menu-trigger:hover {
            background: var(--bg-hover);
            color: var(--text-primary);
            border-color: var(--border-default);
          }
          .convo-sidebar-mobile-toggle {
            display: flex;
            align-items: center;
            gap: 4px;
            padding: 4px 10px;
            border: 1px solid var(--border-default);
            border-radius: var(--radius-sm);
            background: var(--bg-surface);
            color: var(--text-secondary);
            font-family: var(--font-mono);
            font-size: 0.72rem;
            cursor: pointer;
          }
        `}</style>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof MobileSessionViewDemo>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const WithMultilinePrompt: Story = {
  args: {
    multilinePrompt: true,
  },
};

export const Sending: Story = {
  args: {
    sending: true,
    messageCount: 4,
  },
};

export const FewMessages: Story = {
  args: {
    messageCount: 1,
  },
};

export const DiffPanel: Story = {
  args: {
    mobilePanel: "diff",
  },
};

export const InfoPanel: Story = {
  args: {
    mobilePanel: "info",
  },
};

export const HighContext: Story = {
  args: {
    contextPercent: 85,
  },
};
