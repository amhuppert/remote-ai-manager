"use client";

import { memo, useCallback, useMemo, useState } from "react";
import { cn } from "@/lib/ui/cn";
import { StatusDot } from "@/components/ui/StatusDot";
import { ContextFillIndicator } from "@/components/ContextFillIndicator";
import SessionTicketIndicator from "@/components/SessionTicketIndicator";
import ScopedAgentCapabilitiesConfig from "@/components/agent-capabilities/ScopedAgentCapabilitiesConfig";
import TddToggle from "@/components/TddToggle";
import LayoutSwitcher from "@/features/session/conversation/LayoutSwitcher";
import DevServersButton from "@/features/session/conversation/DevServersButton";
import SessionActionsMenu from "@/features/session/conversation/SessionActionsMenu";
import InfoDetailsPopover from "@/features/session/conversation/InfoDetailsPopover";
import AlignmentChip from "@/features/session/conversation/AlignmentChip";
import { deriveAlignmentChipState } from "@/features/session/conversation/alignment-chip-state";
import CompactionStatusChip from "@/features/session/conversation/CompactionStatusChip";
import ConversationProfileChip from "@/components/conversation/ConversationProfileChip";
import { deriveConversationProfileChipState } from "@/components/conversation/conversation-profile-chip-state";
import { deriveCompactionChipState } from "@/features/session/conversation/compaction-chip-state";
import { useAlignmentStateQuery } from "@/lib/session-alignment/queries";
import { useContextArtifacts } from "@/lib/context-artifacts/queries";
import { useCompactMutation } from "@/lib/context-artifacts/mutations";
import type { ContextArtifactTarget } from "@/lib/context-artifacts/query-keys";
import { useOpenContextArtifactPanel } from "@/stores/session-detail.store";
import CopyableId from "@/components/CopyableId";
import { deriveSessionPromptCount } from "@/lib/sessions/derived";
import { shortenWorktreePath } from "@/lib/sessions/worktree-path";
import type { PublicConversationState } from "@/lib/conversations/schemas";
import type { SessionState, LayoutMode } from "@/lib/sessions/schemas";
import type { DevServerRuntimeState } from "@/lib/dev-server/schemas";
import type { UnmanagedConflictInfo } from "@/components/DevServerDrawer";

/** Status-dot appearance keyed by the session status colour token (cyan/green/
 *  amber). Any other value falls back to the neutral idle dot. */
/** List cache tolerance; SSE `context_artifact_status` patches keep it fresh. */
const ARTIFACT_LIST_STALE_MS = 30_000;

const SESSION_STATUS_DOT: Record<string, string> = {
  cyan: "bg-cyan shadow-[0_0_6px_var(--cyan-glow)] animate-[session-status-pulse_1.5s_ease-in-out_infinite]",
  green: "bg-green shadow-[0_0_6px_var(--green-glow)]",
  amber:
    "bg-amber shadow-[0_0_6px_var(--amber-glow)] animate-[session-status-pulse_2s_ease-in-out_infinite]",
};

interface SessionInfoStripProps {
  session: SessionState;
  // The PUBLIC shape: this strip renders read-surface data, and the profile
  // chip needs the redacted snapshot that only the public projection carries.
  activeConversation: PublicConversationState | undefined;
  projectName: string;
  sessionName: string;
  conversationId: string;
  statusDotClass: string;
  displayStatus: string;
  contextPercent: number | null;
  /** Build the full conversation context string for clipboard. */
  buildContext: () => string | null;

  tddEnabled: boolean;
  onTddChange: (value: boolean) => void;
  tddDisabled: boolean;

  layout: LayoutMode;
  onLayoutChange: (mode: LayoutMode) => void;

  dsOpen: boolean;
  dsServers: DevServerRuntimeState[];
  dsClose: () => void;
  dsToggle: () => void;
  dsStartServer: (name: string) => void;
  dsStopServer: (name: string) => void;
  dsStartAll: () => void;
  dsStopAll: () => void;
  dsUnmanagedConflict?: UnmanagedConflictInfo | null;
  dsDismissUnmanagedConflict?: () => void;
  dsStopUnmanagedAndRetry?: () => void;
  dsIsStoppingUnmanaged?: boolean;

  targetBranch: string;
  onDelete: () => void;
  /** Rebase the session branch onto its target; absent while busy/read-only. */
  onRebase?: () => void;

  /** Invoked when the alignment chip's add affordance (the `none` state) is
   *  activated. Connecting this to the `/align` flow is completed in task 7.4. */
  onActivateAlignment?: () => void;
}

function SessionInfoStrip({
  session,
  activeConversation,
  projectName,
  sessionName,
  conversationId,
  statusDotClass,
  displayStatus,
  contextPercent,
  buildContext,
  tddEnabled,
  onTddChange,
  tddDisabled,
  layout,
  onLayoutChange,
  dsOpen,
  dsServers,
  dsClose,
  dsToggle,
  dsStartServer,
  dsStopServer,
  dsStartAll,
  dsStopAll,
  dsUnmanagedConflict = null,
  dsDismissUnmanagedConflict,
  dsStopUnmanagedAndRetry,
  dsIsStoppingUnmanaged = false,
  targetBranch,
  onDelete,
  onRebase,
  onActivateAlignment,
}: SessionInfoStripProps): React.JSX.Element {
  const [capabilitiesOpen, setCapabilitiesOpen] = useState(false);
  const statusKey = statusDotClass.replace("status-dot-", "");

  const { data: alignmentState } = useAlignmentStateQuery(
    projectName,
    sessionName,
  );
  const alignmentChipState = deriveAlignmentChipState(
    alignmentState,
    activeConversation?.lastSeenAlignmentVersion ?? null,
  );

  const copyContext = useCallback((): boolean => {
    const text = buildContext();
    if (text === null) return false;
    void navigator.clipboard.writeText(text);
    return true;
  }, [buildContext]);

  // Per-conversation compaction (design §12.2): the list query drives the
  // status chip and the actions-menu compaction items; the SSE
  // `context_artifact_status` handler keeps the cache live.
  const compactionTarget = useMemo<ContextArtifactTarget>(
    () => ({ scope: "session", projectName, sessionName, conversationId }),
    [projectName, sessionName, conversationId],
  );
  const { data: artifacts } = useContextArtifacts(compactionTarget, {
    staleTime: ARTIFACT_LIST_STALE_MS,
  });
  const compactionState = deriveCompactionChipState(artifacts);
  const { mutate: compactMutate } = useCompactMutation(compactionTarget);
  const openContextArtifactPanel = useOpenContextArtifactPanel();

  const handleCompactConversation = useCallback(() => {
    compactMutate({ kind: "conversation_compaction" });
  }, [compactMutate]);

  const artifactOutdated = compactionState.kind === "outdated";
  const handleRefreshArtifact = useCallback(() => {
    compactMutate({
      kind: "conversation_compaction",
      force: artifactOutdated || undefined,
    });
  }, [compactMutate, artifactOutdated]);

  const conversationName = activeConversation?.name ?? null;
  const handleCopyReference = useCallback(() => {
    void navigator.clipboard.writeText(
      `#${conversationName ?? conversationId}`,
    );
  }, [conversationName, conversationId]);

  return (
    <div
      data-session-info-strip
      className="@container relative z-raised overflow-visible rounded-none border-x-0 border-t-0 border-b border-solid border-border-default bg-bg-base font-mono text-[0.72rem]"
    >
      <div className="hidden">
        <StatusDot />
        <span className="text-text-secondary">{session.branchName}</span>
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-x-lg gap-y-xs px-md py-[6px] max-768:block max-768:px-0 max-768:py-0">
        <div className="flex min-w-0 flex-1 items-center gap-lg @max-[760px]:basis-full max-768:block">
          <div className="inline-flex min-w-0 items-center gap-lg @max-[1100px]:hidden max-768:hidden">
            <CopyableId
              label="worktree"
              value={session.worktreePath}
              displayValue={shortenWorktreePath(session.worktreePath)}
              className="max-w-[300px] min-w-0"
              valueClassName="min-w-0 flex-1 truncate whitespace-nowrap"
            />
            <span className="inline-block h-4 w-px shrink-0 bg-border-default" />
          </div>
          <div className="inline-flex shrink-0 items-center gap-[6px] font-mono text-[0.72rem] leading-none font-medium tracking-[0.05em] text-text-secondary uppercase max-768:hidden">
            <span
              className={cn(
                "h-[6px] w-[6px] shrink-0 rounded-full",
                SESSION_STATUS_DOT[statusKey] ?? "bg-text-tertiary",
              )}
              aria-hidden="true"
            />
            {displayStatus}
          </div>
          <div
            data-session-ticket-region
            className="inline-flex max-w-[160px] shrink-0 items-center @max-[760px]:max-w-[120px] max-768:flex max-768:min-h-[32px] max-768:px-md max-768:py-[6px] max-768:empty:hidden"
          >
            <SessionTicketIndicator
              projectName={projectName}
              sessionName={sessionName}
              layoutClassName="max-w-full"
            />
          </div>
          {contextPercent != null && (
            <div
              data-session-context-region
              className="inline-flex shrink-0 items-center gap-lg max-768:hidden"
            >
              <span className="inline-block h-4 w-px shrink-0 bg-border-default" />
              <ContextFillIndicator
                percentage={contextPercent}
                condenseAtNarrow
              />
            </div>
          )}
        </div>
        <div className="inline-flex shrink-0 items-center gap-lg max-768:hidden">
          <span className="inline-block h-4 w-px shrink-0 bg-border-default @max-[760px]:hidden" />
          <TddToggle
            enabled={tddEnabled}
            onChange={onTddChange}
            disabled={tddDisabled}
            compact
          />
          <span className="inline-block h-4 w-px shrink-0 bg-border-default" />
          <AlignmentChip
            state={alignmentChipState}
            activeVersion={alignmentState?.active?.version ?? null}
            onActivate={onActivateAlignment}
          />
        </div>
        <div className="ml-auto inline-flex shrink-0 items-center justify-end gap-sm @min-[760px]:@max-[1440px]:basis-full max-768:hidden">
          <DevServersButton
            open={dsOpen}
            servers={dsServers}
            onClose={dsClose}
            onToggle={dsToggle}
            onStart={dsStartServer}
            onStop={dsStopServer}
            onStartAll={dsStartAll}
            onStopAll={dsStopAll}
            unmanagedConflict={dsUnmanagedConflict}
            onDismissUnmanagedConflict={dsDismissUnmanagedConflict}
            onStopUnmanagedAndRetry={dsStopUnmanagedAndRetry}
            isStoppingUnmanaged={dsIsStoppingUnmanaged}
          />
          <div className="@max-[760px]:hidden">
            <ConversationProfileChip
              state={deriveConversationProfileChipState(
                activeConversation?.redactedProfileSnapshot,
              )}
            />
          </div>
          <div className="@max-[760px]:hidden">
            <CompactionStatusChip
              state={compactionState}
              onOpen={openContextArtifactPanel}
            />
          </div>
          <SessionActionsMenu
            targetBranch={targetBranch}
            activeLayout={layout}
            onLayoutChange={onLayoutChange}
            onDelete={onDelete}
            onRebase={onRebase}
            compaction={compactionState}
            onCompactConversation={handleCompactConversation}
            onViewArtifact={openContextArtifactPanel}
            onRefreshArtifact={handleRefreshArtifact}
            onCopyReference={handleCopyReference}
          />
          <InfoDetailsPopover
            conversationId={conversationId}
            backendRef={activeConversation?.backendRef ?? null}
            createdAt={session.createdAt}
            worktreePath={session.worktreePath}
            promptCount={deriveSessionPromptCount(session)}
            onCopyContext={copyContext}
            onOpenCapabilities={() => setCapabilitiesOpen(true)}
          />
          <div className="inline-flex shrink-0 items-center gap-sm @max-[760px]:hidden">
            <span className="topbar-sep" />
            <LayoutSwitcher
              activeLayout={layout}
              onLayoutChange={onLayoutChange}
            />
          </div>
        </div>
      </div>
      <ScopedAgentCapabilitiesConfig
        level="session"
        projectName={projectName}
        sessionName={sessionName}
        renderTrigger={false}
        open={capabilitiesOpen}
        onOpenChange={setCapabilitiesOpen}
      />
    </div>
  );
}

export default memo(SessionInfoStrip);
