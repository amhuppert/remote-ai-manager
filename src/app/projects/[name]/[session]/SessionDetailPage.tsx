"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import type {
  SessionState,
  SessionDiff,
  TranscriptMessage,
  LayoutMode,
} from "@/types";
import Topbar from "@/components/Topbar";
import LayoutSwitcher from "./LayoutSwitcher";
import DiffPanel from "./DiffPanel";
import ConfirmDialog from "@/components/ConfirmDialog";
import { tracedFetch } from "@/lib/traced-fetch";
type MobilePanel = "chat" | "diff";

interface Props {
  projectName: string;
  session: SessionState;
  messages: TranscriptMessage[];
  diff: SessionDiff;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function SessionDetailPage({
  projectName,
  session,
  messages,
  diff,
}: Props): React.JSX.Element {
  const router = useRouter();
  const storageKey = `csm-layout-${projectName}-${session.sessionName}`;
  const [layout, setLayout] = useState<LayoutMode>("default");
  const [mobilePanel, setMobilePanel] = useState<MobilePanel>("chat");
  const [promptText, setPromptText] = useState("");
  const [sending, setSending] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [infoExpanded, setInfoExpanded] = useState(false);

  // Message navigation state
  const [currentMsgIndex, setCurrentMsgIndex] = useState(0);
  const panelBodyRef = useRef<HTMLDivElement>(null);
  const messageRefs = useRef<(HTMLDivElement | null)[]>([]);

  // Reset refs array when messages change
  useEffect(() => {
    messageRefs.current = messageRefs.current.slice(0, messages.length);
  }, [messages.length]);

  // Track which message is visible via IntersectionObserver
  useEffect(() => {
    const panelBody = panelBodyRef.current;
    if (!panelBody || messages.length === 0) return;

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting && entry.target instanceof HTMLElement) {
            const idx = Number(entry.target.dataset["msgIndex"]);
            if (!Number.isNaN(idx)) {
              setCurrentMsgIndex(idx);
            }
          }
        }
      },
      {
        root: panelBody,
        threshold: 0.5,
      },
    );

    for (const ref of messageRefs.current) {
      if (ref) observer.observe(ref);
    }

    return () => observer.disconnect();
  }, [messages.length]);

  const scrollToMessage = useCallback(
    (index: number) => {
      const clamped = Math.max(0, Math.min(index, messages.length - 1));
      const el = messageRefs.current[clamped];
      if (el) {
        el.scrollIntoView({ behavior: "smooth", block: "start" });
        setCurrentMsgIndex(clamped);
      }
    },
    [messages.length],
  );

  const handlePrevMessage = useCallback(() => {
    scrollToMessage(currentMsgIndex - 1);
  }, [currentMsgIndex, scrollToMessage]);

  const handleNextMessage = useCallback(() => {
    scrollToMessage(currentMsgIndex + 1);
  }, [currentMsgIndex, scrollToMessage]);

  // Restore layout from localStorage
  useEffect(() => {
    const saved = localStorage.getItem(storageKey);
    if (
      saved === "conversation" ||
      saved === "default" ||
      saved === "split" ||
      saved === "diff"
    ) {
      setLayout(saved);
    }
  }, [storageKey]);

  const handleLayoutChange = useCallback(
    (mode: LayoutMode) => {
      setLayout(mode);
      localStorage.setItem(storageKey, mode);
    },
    [storageKey],
  );

  const handleSendPrompt = useCallback(async () => {
    if (!promptText.trim() || sending) return;
    setSending(true);

    try {
      const res = await tracedFetch(
        `/api/projects/${encodeURIComponent(projectName)}/sessions/${encodeURIComponent(session.sessionName)}/prompt`,
        "send-prompt",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ prompt: promptText.trim() }),
        },
      );

      if (res.ok) {
        setPromptText("");
      }
    } catch {
      // TODO: show error
    } finally {
      setSending(false);
    }
  }, [promptText, sending, projectName, session.sessionName]);

  const handleDelete = useCallback(async () => {
    try {
      const res = await tracedFetch(
        `/api/projects/${encodeURIComponent(projectName)}/sessions?sessionName=${encodeURIComponent(session.sessionName)}`,
        "delete-session",
        { method: "DELETE" },
      );
      if (res.ok) {
        router.push(`/projects/${encodeURIComponent(projectName)}`);
      }
    } catch {
      // TODO: show error
    }
  }, [projectName, session.sessionName, router]);

  const decodedProjectName = decodeURIComponent(projectName);
  const statusDotClass =
    session.status === "running"
      ? "cyan"
      : session.status === "ready"
        ? ""
        : "";

  return (
    <div className="app" data-page="detail" data-mobile-panel={mobilePanel}>
      <Topbar
        page="detail"
        breadcrumbs={[
          { label: "projects", href: "/projects" },
          {
            label: decodedProjectName,
            href: `/projects/${encodeURIComponent(projectName)}`,
          },
          {
            label: session.sessionName,
            href: `/projects/${encodeURIComponent(projectName)}/${encodeURIComponent(session.sessionName)}`,
            isSession: true,
          },
        ]}
        sessionControls={
          <>
            <div className="status-indicator">
              <div className={`status-dot ${statusDotClass}`} />
              {session.status}
            </div>
            <div className="topbar-sep" />
            <LayoutSwitcher
              activeLayout={layout}
              onLayoutChange={handleLayoutChange}
            />
            <div className="topbar-sep" />
            <button
              className="btn-icon-only"
              data-tooltip="Refresh"
              onClick={() => router.refresh()}
            >
              &#8635;
            </button>
            <button
              className="btn-icon-only danger"
              data-tooltip="Delete session"
              onClick={() => setShowDeleteConfirm(true)}
            >
              &#10005;
            </button>
          </>
        }
      />

      <main className="main">
        <div className="session-detail-layout stagger-in">
          {/* Info strip */}
          <div
            className={`session-info-strip${infoExpanded ? " expanded" : ""}`}
            onClick={() => setInfoExpanded((prev) => !prev)}
          >
            {/* Mobile collapsed summary chip */}
            <div className="si-summary">
              <span
                className={`status-dot ${statusDotClass}`}
                style={{ width: 6, height: 6 }}
              />
              <span className="si-val">{session.branchName}</span>
              <span className="si-expand-hint">
                {infoExpanded ? "\u25B2" : "\u25BC"}
              </span>
            </div>
            {/* Full details (visible on desktop always, on mobile when expanded) */}
            <div className="si-details">
              <div className="si-item">
                <span className="si-label">Branch</span>
                <span className="si-val">{session.branchName}</span>
              </div>
              <div className="si-sep" />
              <div className="si-item">
                <span className="si-label">Created</span>
                <span className="si-val">{formatDate(session.createdAt)}</span>
              </div>
              <div className="si-sep" />
              <div className="si-item">
                <span className="si-label">Prompts</span>
                <span className="si-val">{session.promptCount}</span>
              </div>
              <div className="si-sep" />
              <div className="si-item">
                <span className="si-label">Worktree</span>
                <span className="si-val" style={{ opacity: 0.6 }}>
                  {session.worktreePath}
                </span>
              </div>
            </div>
          </div>

          {/* Content area */}
          <div className="session-content-area" data-layout={layout}>
            {/* Conversation panel */}
            <div className="prompt-panel">
              <div className="panel-header">
                <span className="panel-title">Conversation</span>
                <div className="msg-nav">
                  <button
                    className="nav-btn"
                    onClick={handlePrevMessage}
                    disabled={messages.length === 0 || currentMsgIndex <= 0}
                    title="Previous message"
                  >
                    &#9650;
                  </button>
                  <span className="msg-counter">
                    {messages.length > 0
                      ? `${currentMsgIndex + 1} / ${messages.length}`
                      : "0 / 0"}
                  </span>
                  <button
                    className="nav-btn"
                    onClick={handleNextMessage}
                    disabled={
                      messages.length === 0 ||
                      currentMsgIndex >= messages.length - 1
                    }
                    title="Next message"
                  >
                    &#9660;
                  </button>
                </div>
              </div>
              <div className="panel-body" ref={panelBodyRef}>
                {session.status === "running" && (
                  <div className="running-indicator">
                    <div className="spinner" />
                    Claude is working&hellip;
                  </div>
                )}
                <div className="conversation">
                  {messages.length > 0 ? (
                    messages.map((msg, i) => (
                      <div
                        key={i}
                        className={`message ${msg.role}`}
                        data-msg-index={i}
                        ref={(el) => {
                          messageRefs.current[i] = el;
                        }}
                      >
                        <div className="message-role">
                          {msg.role === "user" ? "You" : "Claude"}
                        </div>
                        <div className="message-content">{msg.content}</div>
                      </div>
                    ))
                  ) : (
                    <div
                      className="empty-state"
                      style={{ padding: "var(--space-xl) 0" }}
                    >
                      <div className="empty-state-title">No messages yet</div>
                      <div className="empty-state-desc">
                        Send a prompt to start the conversation.
                      </div>
                    </div>
                  )}
                </div>
              </div>

              {/* Prompt input */}
              <div className="prompt-input-area">
                <div className="prompt-input-wrapper">
                  <textarea
                    className="prompt-textarea"
                    placeholder="Send a prompt to Claude..."
                    rows={2}
                    value={promptText}
                    onChange={(e) => setPromptText(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        void handleSendPrompt();
                      }
                    }}
                  />
                  <button
                    className={`send-btn${sending ? " busy" : ""}`}
                    disabled={!promptText.trim() || sending}
                    onClick={() => void handleSendPrompt()}
                    title={sending ? "Session is busy" : "Send prompt"}
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

            {/* Diff panel */}
            <DiffPanel diff={diff} />
          </div>
        </div>
      </main>

      {/* Mobile bottom action bar */}
      <div className="mobile-bottom-bar">
        <div className="mobile-panel-tabs">
          <button
            className={`mobile-tab${mobilePanel === "chat" ? " active" : ""}`}
            onClick={() => setMobilePanel("chat")}
          >
            Chat
          </button>
          <button
            className={`mobile-tab${mobilePanel === "diff" ? " active" : ""}`}
            onClick={() => setMobilePanel("diff")}
          >
            Diff
          </button>
        </div>
        <div className="mobile-actions">
          <button className="btn-icon-only" onClick={() => router.refresh()}>
            &#8635;
          </button>
          <button
            className="btn-icon-only danger"
            onClick={() => setShowDeleteConfirm(true)}
          >
            &#10005;
          </button>
        </div>
      </div>

      <ConfirmDialog
        open={showDeleteConfirm}
        title="Delete Session"
        message={`This will remove the worktree and session state for "${session.sessionName}". The git branch and transcripts will be preserved. This action cannot be undone.`}
        confirmLabel="Delete"
        danger
        onConfirm={() => {
          setShowDeleteConfirm(false);
          void handleDelete();
        }}
        onCancel={() => setShowDeleteConfirm(false)}
      />
    </div>
  );
}
