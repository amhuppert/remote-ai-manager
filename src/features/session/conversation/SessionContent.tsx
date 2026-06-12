"use client";

import { type ComponentProps, type ReactNode } from "react";
import ConversationPanelContainer from "@/features/session/conversation/ConversationPanelContainer";
import { FinishedBanner } from "@/components/conversation/ConversationBanners";
import SessionInfoStrip from "@/features/session/conversation/SessionInfoStrip";
import MobileInfoPanel from "@/features/session/mobile/MobileInfoPanel";
import RightPane from "@/features/session/conversation/RightPane";
import type { SessionState, LayoutMode } from "@/lib/sessions/schemas";
import type { ConversationState } from "@/lib/conversations/schemas";

type MobilePanel = "chat" | "diff" | "docs" | "specs" | "info";

type PanelContainerProps = ComponentProps<typeof ConversationPanelContainer>;
type RightPaneProps = ComponentProps<typeof RightPane>;
type SessionInfoStripProps = ComponentProps<typeof SessionInfoStrip>;

export interface SessionContentProps {
  session: SessionState;
  activeConversation: ConversationState | undefined;
  projectName: string;
  sessionName: string;
  conversationId: string;
  statusDotClass: string;
  displayStatus: string;
  contextPercent: number | null;
  buildContext: () => string | null;
  isFinished: boolean;
  targetBranch: string;
  layout: LayoutMode;
  mobilePanel: MobilePanel;
  diff: RightPaneProps["diff"];
  commits: RightPaneProps["commits"];
  panelContainerProps: Omit<PanelContainerProps, "promptInputSlot">;
  promptInputSlot: ReactNode;

  tddEnabled: boolean;
  onTddChange: (val: boolean) => void;
  tddDisabled: boolean;
  onLayoutChange: SessionInfoStripProps["onLayoutChange"];
  dsOpen: boolean;
  dsServers: SessionInfoStripProps["dsServers"];
  dsClose: () => void;
  dsToggle: () => void;
  dsStartServer: SessionInfoStripProps["dsStartServer"];
  dsStopServer: SessionInfoStripProps["dsStopServer"];
  dsStartAll: () => void;
  dsStopAll: () => void;
  dsUnmanagedConflict?: SessionInfoStripProps["dsUnmanagedConflict"];
  dsDismissUnmanagedConflict?: () => void;
  dsStopUnmanagedAndRetry?: () => void;
  dsIsStoppingUnmanaged?: boolean;
  onDelete: () => void;
}

export default function SessionContent({
  session,
  activeConversation,
  projectName,
  sessionName,
  conversationId,
  statusDotClass,
  displayStatus,
  contextPercent,
  buildContext,
  isFinished,
  targetBranch,
  layout,
  mobilePanel,
  diff,
  commits,
  panelContainerProps,
  promptInputSlot,
  tddEnabled,
  onTddChange,
  tddDisabled,
  onLayoutChange,
  dsOpen,
  dsServers,
  dsClose,
  dsToggle,
  dsStartServer,
  dsStopServer,
  dsStartAll,
  dsStopAll,
  dsUnmanagedConflict,
  dsDismissUnmanagedConflict,
  dsStopUnmanagedAndRetry,
  dsIsStoppingUnmanaged,
  onDelete,
}: SessionContentProps): React.JSX.Element {
  return (
    <div
      className={`session-detail-layout stagger-in${isFinished ? " finished" : ""}`}
    >
      <SessionInfoStrip
        session={session}
        activeConversation={activeConversation}
        projectName={projectName}
        sessionName={sessionName}
        conversationId={conversationId}
        statusDotClass={statusDotClass}
        displayStatus={displayStatus}
        contextPercent={contextPercent}
        buildContext={buildContext}
        tddEnabled={tddEnabled}
        onTddChange={onTddChange}
        tddDisabled={tddDisabled}
        layout={layout}
        onLayoutChange={onLayoutChange}
        dsOpen={dsOpen}
        dsServers={dsServers}
        dsClose={dsClose}
        dsToggle={dsToggle}
        dsStartServer={dsStartServer}
        dsStopServer={dsStopServer}
        dsStartAll={dsStartAll}
        dsStopAll={dsStopAll}
        dsUnmanagedConflict={dsUnmanagedConflict}
        dsDismissUnmanagedConflict={dsDismissUnmanagedConflict}
        dsStopUnmanagedAndRetry={dsStopUnmanagedAndRetry}
        dsIsStoppingUnmanaged={dsIsStoppingUnmanaged}
        changesAdd={diff.totalAdditions}
        changesDel={diff.totalDeletions}
        targetBranch={targetBranch}
        onDelete={onDelete}
      />

      {isFinished && <FinishedBanner targetBranch={targetBranch} />}

      <div className="session-content-area" data-layout={layout}>
        <ConversationPanelContainer
          {...panelContainerProps}
          promptInputSlot={promptInputSlot}
        />

        {(layout !== "conversation" ||
          mobilePanel === "diff" ||
          mobilePanel === "docs" ||
          mobilePanel === "specs") && (
          <RightPane
            diff={diff}
            commits={commits}
            projectName={projectName}
            sessionName={session.sessionName}
            targetBranch={targetBranch}
          />
        )}

        {mobilePanel === "info" && (
          <MobileInfoPanel
            session={session}
            activeConversation={activeConversation}
            conversationId={conversationId}
            statusDotClass={statusDotClass}
            displayStatus={displayStatus}
            contextPercent={contextPercent}
            buildContext={buildContext}
          />
        )}
      </div>
    </div>
  );
}
