"use client";

import { memo, useCallback, useState } from "react";
import { cn } from "@/lib/ui/cn";
import { StatusDot } from "@/components/ui/StatusDot";
import { ContextFillIndicator } from "@/components/ContextFillIndicator";
import ScopedAgentCapabilitiesConfig from "@/components/agent-capabilities/ScopedAgentCapabilitiesConfig";
import TddToggle from "@/components/TddToggle";
import LayoutSwitcher from "@/features/session/conversation/LayoutSwitcher";
import DevServersButton from "@/features/session/conversation/DevServersButton";
import SessionActionsMenu from "@/features/session/conversation/SessionActionsMenu";
import InfoDetailsPopover from "@/features/session/conversation/InfoDetailsPopover";
import CopyableId from "@/components/CopyableId";
import { deriveSessionPromptCount } from "@/lib/sessions/derived";
import { shortenWorktreePath } from "@/lib/sessions/worktree-path";
import type { ConversationState } from "@/lib/conversations/schemas";
import type { SessionState, LayoutMode } from "@/lib/sessions/schemas";
import type { DevServerRuntimeState } from "@/lib/dev-server/schemas";
import type { UnmanagedConflictInfo } from "@/components/DevServerDrawer";

/** Status-dot appearance keyed by the session status colour token (cyan/green/
 *  amber). Any other value falls back to the neutral idle dot. */
const SESSION_STATUS_DOT: Record<string, string> = {
  cyan: "bg-cyan shadow-[0_0_6px_var(--cyan-glow)] animate-[session-status-pulse_1.5s_ease-in-out_infinite]",
  green: "bg-green shadow-[0_0_6px_var(--green-glow)]",
  amber:
    "bg-amber shadow-[0_0_6px_var(--amber-glow)] animate-[session-status-pulse_2s_ease-in-out_infinite]",
};

interface SessionInfoStripProps {
  session: SessionState;
  activeConversation: ConversationState | undefined;
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
}: SessionInfoStripProps): React.JSX.Element {
  const [capabilitiesOpen, setCapabilitiesOpen] = useState(false);
  const statusKey = statusDotClass.replace("status-dot-", "");

  const copyContext = useCallback((): boolean => {
    const text = buildContext();
    if (text === null) return false;
    void navigator.clipboard.writeText(text);
    return true;
  }, [buildContext]);

  return (
    <div className="relative z-raised overflow-visible rounded-none border-x-0 border-t-0 border-b border-solid border-border-default bg-bg-base font-mono text-[0.72rem] max-768:hidden">
      <div className="hidden">
        <StatusDot />
        <span className="text-text-secondary">{session.branchName}</span>
      </div>
      <div className="flex items-center gap-lg px-md py-[6px]">
        <CopyableId
          label="worktree"
          value={session.worktreePath}
          displayValue={shortenWorktreePath(session.worktreePath)}
        />
        <span className="inline-block h-4 w-px shrink-0 bg-border-default" />
        <div className="inline-flex shrink-0 items-center gap-[6px] font-mono text-[0.72rem] leading-none font-medium tracking-[0.05em] text-text-secondary uppercase">
          <span
            className={cn(
              "h-[6px] w-[6px] shrink-0 rounded-full",
              SESSION_STATUS_DOT[statusKey] ?? "bg-text-tertiary",
            )}
            aria-hidden="true"
          />
          {displayStatus}
        </div>
        {contextPercent != null && (
          <>
            <span className="inline-block h-4 w-px shrink-0 bg-border-default" />
            <ContextFillIndicator percentage={contextPercent} />
          </>
        )}
        <span className="inline-block h-4 w-px shrink-0 bg-border-default" />
        <TddToggle
          enabled={tddEnabled}
          onChange={onTddChange}
          disabled={tddDisabled}
          compact
        />
        <div className="ml-auto inline-flex shrink-0 items-center gap-sm">
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
          <SessionActionsMenu targetBranch={targetBranch} onDelete={onDelete} />
          <InfoDetailsPopover
            conversationId={conversationId}
            backendRef={activeConversation?.backendRef ?? null}
            createdAt={session.createdAt}
            worktreePath={session.worktreePath}
            promptCount={deriveSessionPromptCount(session)}
            onCopyContext={copyContext}
            onOpenCapabilities={() => setCapabilitiesOpen(true)}
          />
          <span className="topbar-sep" />
          <LayoutSwitcher
            activeLayout={layout}
            onLayoutChange={onLayoutChange}
          />
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
