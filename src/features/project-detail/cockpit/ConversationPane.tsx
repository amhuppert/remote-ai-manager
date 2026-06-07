"use client";

import { useState, type ReactNode } from "react";
import type { AgentBackendId } from "@/lib/shared/schemas";
import type { ConversationStatus } from "@/lib/conversations/schemas";
import { presentConversationStatus } from "./conversation-status";
import DiffSlideover from "./DiffSlideover";
import "./styles/cockpit.css";

/** Live +/− summary of the main worktree, shown on the review chip. */
export interface MainWorktreeDiffStat {
  additions: number;
  deletions: number;
  fileCount: number;
}

export interface ConversationPaneProps {
  /** Drives the violet recolor for Codex conversations. */
  agentBackend: AgentBackendId;
  /** Project name — labels the diff slide-over. */
  projectName?: string;
  /** Active conversation status — surfaced as a header indicator (Req 12.2). */
  status?: ConversationStatus;
  /** ConversationTabs slot (rendered above the header). */
  tabs?: ReactNode;
  /** ProjectTranscriptHost slot. */
  transcript: ReactNode;
  /** UnifiedComposer slot, docked at the bottom. */
  composer: ReactNode;
  /** MainDiffSurface slot, hosted in the diff slide-over. */
  diffSurface?: ReactNode;
  /** Live main-worktree diff stat for the review chip (null = none/unknown). */
  diffStat?: MainWorktreeDiffStat | null;
}

function ExternalGlyph(): React.JSX.Element {
  return (
    <svg
      className="plc-worktree-view"
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="square"
      aria-hidden="true"
    >
      <path d="M4 4h7M4 4v7M20 20h-7M20 20v-7M14 10l6-6M10 14l-6 6" />
    </svg>
  );
}

/**
 * The conversation pane: tab strip, a `main · worktree` execution-context
 * header whose chip opens the read-only diff slide-over (a live +/− stat when
 * the worktree is dirty), the transcript host, and a bottom-docked composer
 * slot. The locked layout default keeps the composer at the bottom.
 */
export default function ConversationPane({
  agentBackend,
  projectName,
  status,
  tabs,
  transcript,
  composer,
  diffSurface,
  diffStat,
}: ConversationPaneProps): React.JSX.Element {
  const [diffOpen, setDiffOpen] = useState(false);
  const statusPresentation =
    status !== undefined ? presentConversationStatus(status) : null;
  const hasDiff = diffSurface !== undefined && diffSurface !== null;

  return (
    <section className="plc-pane" data-agent={agentBackend}>
      {tabs}
      <header className="plc-pane-header">
        {hasDiff ? (
          <button
            type="button"
            className="plc-worktree-btn"
            onClick={() => setDiffOpen(true)}
            aria-haspopup="dialog"
            title="Review uncommitted changes on main"
          >
            <span className="plc-pane-ctx">main</span>
            <span className="plc-pane-ctx-sep">·</span>
            <span>worktree</span>
            {diffStat && diffStat.fileCount > 0 && (
              <span className="plc-worktree-stat">
                <span className="add">+{diffStat.additions}</span>
                <span className="del">−{diffStat.deletions}</span>
              </span>
            )}
            <ExternalGlyph />
          </button>
        ) : (
          <>
            <span className="plc-pane-ctx">main</span>
            <span className="plc-pane-ctx-sep">·</span>
            <span>worktree</span>
          </>
        )}
        {statusPresentation?.badgeStatus && (
          <span
            className="cc-badge cc-badge--status plc-pane-status"
            data-status={statusPresentation.badgeStatus}
          >
            {statusPresentation.label}
          </span>
        )}
      </header>
      <div className="plc-pane-body">{transcript}</div>
      <div className="plc-pane-composer">{composer}</div>
      {hasDiff && (
        <DiffSlideover
          open={diffOpen}
          onClose={() => setDiffOpen(false)}
          {...(projectName ? { projectName } : {})}
        >
          {diffSurface}
        </DiffSlideover>
      )}
    </section>
  );
}
