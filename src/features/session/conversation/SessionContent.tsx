"use client";

import { type ComponentProps, type ReactNode } from "react";
import ConversationPanelContainer from "@/features/session/conversation/ConversationPanelContainer";
import ConversationSidebar from "@/features/session/sidebar/ConversationSidebar";
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
  conversations: ConversationState[] | undefined;
  projectName: string;
  sessionName: string;
  conversationId: string;
  statusDotClass: string;
  displayStatus: string;
  contextPercent: number | null;
  buildContext: () => string | null;
  isFinished: boolean;
  targetBranch: string;
  sidebarCollapsed: boolean;
  toggleSidebar: () => void;
  mobileSidebarOpen: boolean;
  closeMobileSidebar: () => void;
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
  commitDisabled: boolean;
  onCommit: () => void;
  onMerge: () => void;
  onDelete: () => void;
}

export default function SessionContent({
  session,
  activeConversation,
  conversations,
  projectName,
  sessionName,
  conversationId,
  statusDotClass,
  displayStatus,
  contextPercent,
  buildContext,
  isFinished,
  targetBranch,
  sidebarCollapsed,
  toggleSidebar,
  mobileSidebarOpen,
  closeMobileSidebar,
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
  commitDisabled,
  onCommit,
  onMerge,
  onDelete,
}: SessionContentProps): React.JSX.Element {
  const hasSidebar = conversations !== undefined;
  return (
    <main
      className="main"
      data-with-sidebar={hasSidebar ? "on" : "off"}
      data-sidebar-collapsed={hasSidebar && sidebarCollapsed ? "true" : "false"}
    >
      {conversations && (
        <ConversationSidebar
          projectName={projectName}
          sessionName={session.sessionName}
          activeConversationId={conversationId}
          mobileOpen={mobileSidebarOpen}
          onMobileClose={closeMobileSidebar}
        />
      )}

      {conversations && sidebarCollapsed && (
        <button
          className="convo-sidebar-expand-float"
          onClick={toggleSidebar}
          data-tooltip="Expand sidebar"
        >
          {"\u25B6"}
        </button>
      )}

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
          changesAdd={diff.totalAdditions}
          changesDel={diff.totalDeletions}
          commitDisabled={commitDisabled}
          targetBranch={targetBranch}
          onCommit={onCommit}
          onMerge={onMerge}
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
    </main>
  );
}
