"use client";

import { memo, useCallback, useState } from "react";
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

  changesAdd: number;
  changesDel: number;
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
  changesAdd,
  changesDel,
  targetBranch,
  onDelete,
}: SessionInfoStripProps): React.JSX.Element {
  const [capabilitiesOpen, setCapabilitiesOpen] = useState(false);

  const copyContext = useCallback((): boolean => {
    const text = buildContext();
    if (text === null) return false;
    void navigator.clipboard.writeText(text);
    return true;
  }, [buildContext]);

  return (
    <div className="session-info-strip">
      <div className="si-summary">
        <span
          className={`status-dot ${statusDotClass}`}
          style={{ width: 6, height: 6 }}
        />
        <span className="si-val">{session.branchName}</span>
      </div>
      <div className="si-details">
        <CopyableId
          label="worktree"
          value={session.worktreePath}
          displayValue={shortenWorktreePath(session.worktreePath)}
        />
        <span className="si-sep" />
        <div
          className={`session-status ${statusDotClass.replace("status-dot-", "")}`}
        >
          <span className="dot" aria-hidden="true" />
          {displayStatus}
        </div>
        <span className="si-sep" />
        <div className="si-item">
          <span className="si-label">Changes</span>
          <span className="si-val si-val--bright">
            +{changesAdd} −{changesDel}
          </span>
        </div>
        {contextPercent != null && (
          <>
            <span className="si-sep" />
            <ContextFillIndicator percentage={contextPercent} />
          </>
        )}
        <span className="si-sep" />
        <TddToggle
          enabled={tddEnabled}
          onChange={onTddChange}
          disabled={tddDisabled}
          compact
        />
        <div className="si-right">
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
