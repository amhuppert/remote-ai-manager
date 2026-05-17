"use client";

import { memo, useCallback, useState } from "react";
import CopyableId from "@/components/CopyableId";
import { ContextFillIndicator } from "@/components/ContextFillIndicator";
import SessionMcpChip from "@/components/mcp/SessionMcpChip";
import SessionMcpModal from "@/components/mcp/SessionMcpModal";
import {
  useInfoExpanded,
  useToggleInfoStrip,
} from "@/stores/session-detail.store";
import { deriveSessionPromptCount } from "@/lib/session-derived";
import type { ConversationState, SessionState } from "@/types";
import InfoDetailsPopover from "./InfoDetailsPopover";

/** Extract directory name after `.worktrees/` for compact display. */
function shortenWorktreePath(fullPath: string): string {
  const marker = ".worktrees/";
  const idx = fullPath.indexOf(marker);
  if (idx === -1) return fullPath;
  return fullPath.slice(idx + marker.length);
}

interface SessionInfoStripProps {
  session: SessionState;
  activeConversation: ConversationState | undefined;
  projectName: string;
  sessionName: string;
  conversationId: string;
  statusDotClass: string;
  contextPercent: number | null;
  /** Build the full conversation context string for clipboard. */
  buildContext: () => string | null;
}

function SessionInfoStrip({
  session,
  activeConversation,
  projectName,
  sessionName,
  conversationId,
  statusDotClass,
  contextPercent,
  buildContext,
}: SessionInfoStripProps): React.JSX.Element {
  const infoExpanded = useInfoExpanded();
  const toggleInfoStrip = useToggleInfoStrip();
  const [mcpModalOpen, setMcpModalOpen] = useState(false);
  const [contextCopied, setContextCopied] = useState(false);

  const handleCopyContext = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      const text = buildContext();
      if (text === null) return;
      void navigator.clipboard.writeText(text).then(() => {
        setContextCopied(true);
        setTimeout(() => setContextCopied(false), 1500);
      });
    },
    [buildContext],
  );

  const openMcpModal = useCallback(() => setMcpModalOpen(true), []);
  const closeMcpModal = useCallback(() => setMcpModalOpen(false), []);

  return (
    <>
      <div
        className={`session-info-strip${infoExpanded ? " expanded" : ""}`}
        onClick={toggleInfoStrip}
      >
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
        <div className="si-details">
          <CopyableId
            label="Branch"
            value={session.branchName}
            truncateAt={999}
          />
          {activeConversation && (
            <span
              className="cc-badge"
              data-backend={activeConversation.agentBackend}
            >
              {activeConversation.agentBackend}
            </span>
          )}
          <div className="si-item">
            <span className="si-label">Prompts</span>
            <span className="si-val si-val--bright">
              {deriveSessionPromptCount(session)}
            </span>
          </div>
          <CopyableId
            label="Worktree"
            value={session.worktreePath}
            displayValue={shortenWorktreePath(session.worktreePath)}
          />
          {contextPercent != null && (
            <ContextFillIndicator percentage={contextPercent} />
          )}
          <button
            className="si-copy-context-btn"
            onClick={handleCopyContext}
            data-tooltip={
              contextCopied ? "Copied!" : "Copy context to clipboard"
            }
          >
            {contextCopied ? "\u2713" : "\u2398"} Context
          </button>
          <SessionMcpChip
            projectName={projectName}
            sessionName={sessionName}
            onClick={openMcpModal}
          />
          <InfoDetailsPopover
            conversationId={conversationId}
            backendRef={activeConversation?.backendRef ?? null}
            createdAt={session.createdAt}
            worktreePath={session.worktreePath}
            onOpenMcpServers={openMcpModal}
          />
        </div>
      </div>

      <SessionMcpModal
        projectName={projectName}
        sessionName={sessionName}
        open={mcpModalOpen}
        onClose={closeMcpModal}
      />
    </>
  );
}

export default memo(SessionInfoStrip);
