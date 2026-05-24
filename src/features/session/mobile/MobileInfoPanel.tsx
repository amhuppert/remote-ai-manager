"use client";

import { memo, useCallback, useState } from "react";
import { ContextFillIndicator } from "@/components/ContextFillIndicator";
import { deriveSessionPromptCount } from "@/lib/sessions/derived";
import type { ConversationState } from "@/lib/conversations/schemas";
import type { SessionState } from "@/lib/sessions/schemas";
function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function MobileInfoCopyRow({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div
      className="mobile-info-row mobile-info-copyable"
      onClick={() => {
        void navigator.clipboard.writeText(value).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
      role="button"
      tabIndex={0}
    >
      <span className="mobile-info-label">{label}</span>
      <span className="mobile-info-value">{value}</span>
      <span className="mobile-info-copy-icon">
        {copied ? "\u2713" : "\u2398"}
      </span>
    </div>
  );
}

interface MobileInfoPanelProps {
  session: SessionState;
  activeConversation: ConversationState | undefined;
  conversationId: string;
  statusDotClass: string;
  displayStatus: string;
  contextPercent: number | null;
  /** Build the full conversation context string for clipboard. */
  buildContext: () => string | null;
}

function MobileInfoPanel({
  session,
  activeConversation,
  conversationId,
  statusDotClass,
  displayStatus,
  contextPercent,
  buildContext,
}: MobileInfoPanelProps): React.JSX.Element {
  const [contextCopied, setContextCopied] = useState(false);

  const handleCopyContext = useCallback(() => {
    const text = buildContext();
    if (text === null) return;
    void navigator.clipboard.writeText(text).then(() => {
      setContextCopied(true);
      setTimeout(() => setContextCopied(false), 1500);
    });
  }, [buildContext]);

  const backendRefDisplay = activeConversation?.backendRef
    ? activeConversation.backendRef.backend === "claude"
      ? activeConversation.backendRef.sessionId
      : activeConversation.backendRef.backend === "codex"
        ? activeConversation.backendRef.threadId
        : "\u2014"
    : "\u2014";

  return (
    <div className="mobile-info-panel">
      <div className="mobile-info-row">
        <span className="mobile-info-label">Status</span>
        <span className="mobile-info-value">
          <span
            className={`status-dot ${statusDotClass}`}
            style={{
              width: 6,
              height: 6,
              display: "inline-block",
              marginRight: 6,
            }}
          />
          {displayStatus}
        </span>
      </div>
      <MobileInfoCopyRow label="Branch" value={session.branchName} />
      <div className="mobile-info-row">
        <span className="mobile-info-label">Created</span>
        <span className="mobile-info-value">
          {formatDate(session.createdAt)}
        </span>
      </div>
      <div className="mobile-info-row">
        <span className="mobile-info-label">Prompts</span>
        <span className="mobile-info-value">
          {deriveSessionPromptCount(session)}
        </span>
      </div>
      <MobileInfoCopyRow label="Worktree" value={session.worktreePath} />
      <MobileInfoCopyRow label="Conv ID" value={conversationId} />
      {activeConversation && (
        <>
          <MobileInfoCopyRow
            label="Backend"
            value={activeConversation.agentBackend}
          />
          <MobileInfoCopyRow label="Session Ref" value={backendRefDisplay} />
        </>
      )}
      {contextPercent != null && (
        <div className="mobile-info-row">
          <span className="mobile-info-label">Context</span>
          <span className="mobile-info-value">
            <ContextFillIndicator percentage={contextPercent} />
          </span>
        </div>
      )}
      <div className="mobile-info-actions">
        <button className="btn btn-sm" onClick={handleCopyContext}>
          {contextCopied ? "\u2713 Copied" : "\u2398 Copy Context"}
        </button>
      </div>
    </div>
  );
}

export default memo(MobileInfoPanel);
