"use client";

import { useState, type ReactNode } from "react";
import type { AgentBackendId } from "@/lib/shared/schemas";
import type { ConversationStatus } from "@/lib/conversations/schemas";
import { presentConversationStatus } from "./conversation-status";
import "./styles/cockpit.css";

export interface ConversationPaneProps {
  /** Drives the violet recolor for Codex conversations. */
  agentBackend: AgentBackendId;
  /** Active conversation status — surfaced as a header indicator (Req 12.2). */
  status?: ConversationStatus;
  /** ConversationTabs slot (rendered above the header). */
  tabs?: ReactNode;
  /** ProjectTranscriptHost slot. */
  transcript: ReactNode;
  /** UnifiedComposer slot, docked at the bottom. */
  composer: ReactNode;
  /** MainDiffSurface slot, revealed by the diff/review toggle. */
  diffSurface?: ReactNode;
}

/**
 * The conversation pane: tab strip, a `main · worktree` execution-context
 * header with a diff/review toggle, the transcript host (or the main-worktree
 * diff surface when toggled), and a bottom-docked composer slot. The locked
 * layout default keeps the composer at the bottom.
 */
export default function ConversationPane({
  agentBackend,
  status,
  tabs,
  transcript,
  composer,
  diffSurface,
}: ConversationPaneProps): React.JSX.Element {
  const [showDiff, setShowDiff] = useState(false);
  const statusPresentation =
    status !== undefined ? presentConversationStatus(status) : null;

  return (
    <section className="plc-pane" data-agent={agentBackend}>
      {tabs}
      <header className="plc-pane-header">
        <span className="plc-pane-ctx">main</span>
        <span className="plc-pane-ctx-sep">·</span>
        <span>worktree</span>
        {statusPresentation?.badgeStatus && (
          <span
            className="cc-badge cc-badge--status plc-pane-status"
            data-status={statusPresentation.badgeStatus}
          >
            {statusPresentation.label}
          </span>
        )}
        {diffSurface && (
          <div className="plc-pane-header-actions">
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              aria-pressed={showDiff}
              onClick={() => setShowDiff((v) => !v)}
            >
              {showDiff ? "Conversation" : "Diff / review"}
            </button>
          </div>
        )}
      </header>
      <div className="plc-pane-body">
        {showDiff && diffSurface ? diffSurface : transcript}
      </div>
      <div className="plc-pane-composer">{composer}</div>
    </section>
  );
}
