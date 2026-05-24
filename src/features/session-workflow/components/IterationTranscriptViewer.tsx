"use client";

import { useEffect, useRef, useCallback, useMemo } from "react";
import { useConversationMessagesQuery } from "@/lib/conversations/queries";
import { useSessionQuery } from "@/lib/sessions/queries";
import type { TranscriptMessage } from "@/lib/conversations/schemas";
import MessageContent from "@/components/MessageContent";

interface IterationTranscriptViewerProps {
  projectName: string;
  sessionName: string;
  conversationId: string;
  isLive: boolean;
  contextTitle: string;
  taskTitle: string;
  onClose: () => void;
}

/** Find indices of user messages for prev/next navigation. */
function getUserMessageIndices(messages: TranscriptMessage[]): number[] {
  return messages.reduce<number[]>((acc, msg, i) => {
    if (msg.role === "user") acc.push(i);
    return acc;
  }, []);
}

export default function IterationTranscriptViewer({
  projectName,
  sessionName,
  conversationId,
  isLive,
  contextTitle,
  taskTitle,
  onClose,
}: IterationTranscriptViewerProps) {
  const messagesQuery = useConversationMessagesQuery(
    projectName,
    sessionName,
    conversationId,
  );
  const sessionQuery = useSessionQuery(projectName, sessionName);
  const worktreePath = sessionQuery.data?.worktreePath;

  const messages = messagesQuery.data ?? [];
  const scrollRef = useRef<HTMLDivElement>(null);
  const messageRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  const prevMessageCountRef = useRef(0);

  const userIndices = useMemo(
    () => getUserMessageIndices(messages),
    [messages],
  );

  // Auto-scroll to bottom when new messages arrive in live mode
  useEffect(() => {
    if (!isLive || !scrollRef.current) return;
    if (messages.length > prevMessageCountRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
    prevMessageCountRef.current = messages.length;
  }, [messages.length, isLive]);

  const scrollToMessage = useCallback((index: number) => {
    const el = messageRefs.current.get(index);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, []);

  const handleNavPrev = useCallback(() => {
    if (!scrollRef.current) return;
    const scrollTop = scrollRef.current.scrollTop;

    // Find the last user message above the current scroll position
    for (let i = userIndices.length - 1; i >= 0; i--) {
      const idx = userIndices[i]!;
      const el = messageRefs.current.get(idx);
      if (el && el.offsetTop < scrollTop - 4) {
        scrollToMessage(idx);
        return;
      }
    }
    // If none found, scroll to top
    scrollRef.current.scrollTo({ top: 0, behavior: "smooth" });
  }, [userIndices, scrollToMessage]);

  const handleNavNext = useCallback(() => {
    if (!scrollRef.current) return;
    const scrollTop = scrollRef.current.scrollTop;

    // Find the first user message below the current scroll position
    for (const idx of userIndices) {
      const el = messageRefs.current.get(idx);
      if (el && el.offsetTop > scrollTop + 4) {
        scrollToMessage(idx);
        return;
      }
    }
    // If none found, scroll to bottom
    scrollRef.current.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [userIndices, scrollToMessage]);

  const setMessageRef = useCallback(
    (index: number) => (el: HTMLDivElement | null) => {
      if (el) {
        messageRefs.current.set(index, el);
      } else {
        messageRefs.current.delete(index);
      }
    },
    [],
  );

  return (
    <div className="wb-transcript-viewer">
      <header className="wb-transcript-header">
        <button
          className="wb-transcript-close"
          onClick={onClose}
          type="button"
          aria-label="Close transcript"
        >
          ✕
        </button>
        <div className="wb-transcript-label">
          <span className="wb-transcript-context">{contextTitle}</span>
          <span className="wb-transcript-sep">/</span>
          <span className="wb-transcript-task">{taskTitle}</span>
        </div>
        {isLive && (
          <span className="wb-transcript-live">
            <span className="wb-transcript-live-dot" />
            Live
          </span>
        )}
      </header>

      <div className="wb-transcript-body" ref={scrollRef}>
        {messagesQuery.isLoading && (
          <div className="wb-transcript-loading">Loading transcript...</div>
        )}
        {!messagesQuery.isLoading && messages.length === 0 && (
          <div className="wb-transcript-empty">
            {isLive
              ? "Waiting for agent output..."
              : "No messages in this conversation."}
          </div>
        )}
        {messages.length > 0 && (
          <div className="conversation">
            {messages.map((msg, i) => (
              <div
                key={i}
                className={`message ${msg.role}`}
                ref={setMessageRef(i)}
              >
                <div className="message-role">{msg.role}</div>
                <div className="message-content">
                  <MessageContent
                    content={msg.content}
                    worktreePath={worktreePath}
                  />
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <footer className="wb-transcript-nav">
        <div className="msg-nav">
          <div className="msg-nav-group">
            <button
              className="nav-btn"
              onClick={handleNavPrev}
              disabled={userIndices.length === 0}
              type="button"
              aria-label="Previous message"
            >
              ◂
            </button>
            <button
              className="nav-btn"
              onClick={handleNavNext}
              disabled={userIndices.length === 0}
              type="button"
              aria-label="Next message"
            >
              ▸
            </button>
          </div>
          <span className="msg-counter">
            {messages.length} msg{messages.length !== 1 ? "s" : ""}
          </span>
        </div>
        {isLive && (
          <span className="wb-transcript-live-footer">
            <span className="wb-transcript-live-dot" />
            Streaming
          </span>
        )}
      </footer>
    </div>
  );
}
