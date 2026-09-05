"use client";

import { useState, type ReactNode } from "react";
import { Badge } from "@/components/ui/Badge";
import { StopIcon } from "@/components/icons";
import type { AgentBackendId } from "@/lib/shared/schemas";
import type { ConversationStatus } from "@/lib/conversations/schemas";
import type { RedactedAgentProfileSnapshot } from "@/lib/agent-profiles/schemas";
import ConversationProfileChip from "@/components/conversation/ConversationProfileChip";
import { deriveConversationProfileChipState } from "@/components/conversation/conversation-profile-chip-state";
import { presentConversationStatus } from "./conversation-status";
import DiffSlideover from "./DiffSlideover";

export interface ConversationPaneProps {
  /** Drives the violet recolor for Codex conversations. */
  agentBackend: AgentBackendId;
  /** Project name — labels the diff slide-over. */
  projectName?: string;
  /** Active conversation status — surfaced as a header indicator (Req 12.2). */
  status?: ConversationStatus;
  /**
   * The active conversation's agent profile as a read surface carries it —
   * null for a conversation that predates the library, which the header states
   * as `No profile` rather than omitting (R6.5). Undefined only while there is
   * no active conversation to describe.
   */
  redactedProfileSnapshot?: RedactedAgentProfileSnapshot | null;
  /** Whether the conversation on screen has a turn the user can stop (R5.1). */
  canStop?: boolean;
  /** Stop the turn running in the conversation on screen. */
  onStop?: () => void;
  /** ConversationTabs slot (rendered above the header). */
  tabs?: ReactNode;
  /** ProjectTranscriptHost slot. */
  transcript: ReactNode;
  /** UnifiedComposer slot, docked at the bottom. */
  composer: ReactNode;
  /** MainDiffSurface slot, hosted in the diff slide-over. */
  diffSurface?: ReactNode;
}

// The pane fills the workspace column (legacy `.plc-workspace-pane > .plc-pane`
// flex:1). data-agent is retained for the composer's Codex identity; the legacy
// codex border-bottom-color rule was inert (the pane carries no border width).
const PANE_CLASS =
  "flex-1 flex flex-col min-h-0 min-w-0 h-full bg-bg-surface overflow-hidden";

const PANE_HEADER_CLASS =
  "flex items-center gap-sm h-[36px] max-768:h-auto max-768:min-h-[44px] max-768:flex-wrap max-768:py-xs px-md border-x-0 border-t-0 border-b border-solid border-border-dim " +
  "font-mono text-[0.72rem] text-text-secondary shrink-0";

const WORKTREE_BTN_CLASS =
  "group inline-flex items-center gap-xs px-sm py-2xs border border-solid border-border-subtle rounded-sm " +
  "bg-bg-base text-text-secondary font-mono text-[0.72rem] cursor-pointer " +
  "transition-[border-color,background,color] duration-150 ease-[ease] " +
  "hover:border-border-strong hover:bg-bg-surface hover:text-text-primary";

// The session conversation header's Stop pill, unchanged: stopping a turn is
// the same action at either scope, so it reads the same. `ml-auto` parks it at
// the far end of the cockpit's execution-context header.
const STOP_BTN_CLASS =
  "ml-auto inline-flex h-[24px] cursor-pointer items-center gap-[6px] rounded-full " +
  "border border-solid border-[var(--cc-red-soft-a45)] bg-[var(--cc-red-soft-a08)] px-[10px] " +
  "font-mono text-[0.66rem] font-bold tracking-[0.08em] text-red uppercase " +
  "transition-all duration-150 ease-[ease] hover:border-red hover:bg-[var(--cc-red-soft-a14)] " +
  "hover:shadow-[0_0_12px_var(--cc-red-soft-a25)] max-768:px-[8px] max-768:min-h-[44px] shrink-0";

function ExternalGlyph(): React.JSX.Element {
  return (
    <svg
      className="inline-flex text-text-tertiary group-hover:text-cyan"
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
  redactedProfileSnapshot,
  canStop = false,
  onStop,
  tabs,
  transcript,
  composer,
  diffSurface,
}: ConversationPaneProps): React.JSX.Element {
  const [diffOpen, setDiffOpen] = useState(false);
  const statusPresentation =
    status !== undefined ? presentConversationStatus(status) : null;
  const hasDiff = diffSurface !== undefined && diffSurface !== null;

  return (
    <section className={PANE_CLASS} data-agent={agentBackend}>
      {tabs}
      <header className={PANE_HEADER_CLASS}>
        {hasDiff ? (
          <button
            type="button"
            className={WORKTREE_BTN_CLASS}
            onClick={() => setDiffOpen(true)}
            aria-haspopup="dialog"
            title="Review uncommitted changes on main"
          >
            <span className="text-text-primary">main</span>
            <span className="text-text-tertiary">·</span>
            <span>worktree</span>
            <ExternalGlyph />
          </button>
        ) : (
          <>
            <span className="text-text-primary">main</span>
            <span className="text-text-tertiary">·</span>
            <span>worktree</span>
          </>
        )}
        {statusPresentation?.badgeStatus && (
          <Badge
            tier="status"
            status={statusPresentation.badgeStatus}
            layoutClassName="ml-sm"
          >
            {statusPresentation.label}
          </Badge>
        )}
        {redactedProfileSnapshot !== undefined && (
          <ConversationProfileChip
            state={deriveConversationProfileChipState(redactedProfileSnapshot)}
            className="ml-auto"
          />
        )}
        {canStop && (
          <button
            type="button"
            className={STOP_BTN_CLASS}
            onClick={onStop}
            title="Stop agent"
            aria-label="Stop agent"
          >
            <StopIcon size={11} />
            <span className="leading-none max-768:hidden">Stop</span>
          </button>
        )}
      </header>
      <div className="flex min-h-0 flex-1 flex-col">{transcript}</div>
      <div className="shrink-0 border-x-0 border-t border-b-0 border-solid border-border-dim bg-bg-base px-md py-md max-768:py-sm">
        {composer}
      </div>
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
