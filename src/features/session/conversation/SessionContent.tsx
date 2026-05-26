"use client";

import { type ComponentProps, type ReactNode } from "react";
import ConversationPanel from "@/components/conversation/ConversationPanel";
import ConversationSidebar from "@/features/session/sidebar/ConversationSidebar";
import { FinishedBanner } from "@/components/conversation/ConversationBanners";
import SessionInfoStrip from "@/features/session/conversation/SessionInfoStrip";
import MobileInfoPanel from "@/features/session/mobile/MobileInfoPanel";
import RightPane from "@/features/session/conversation/RightPane";
import type { SessionState, LayoutMode } from "@/lib/sessions/schemas";
import type { ConversationState } from "@/lib/conversations/schemas";

type MobilePanel = "chat" | "diff" | "docs" | "specs" | "info";

type ConversationPanelProps = ComponentProps<typeof ConversationPanel>;
type RightPaneProps = ComponentProps<typeof RightPane>;

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
  conversationPanelProps: Omit<ConversationPanelProps, "promptInputSlot">;
  promptInputSlot: ReactNode;
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
  conversationPanelProps,
  promptInputSlot,
}: SessionContentProps): React.JSX.Element {
  return (
    <main className="main">
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
          contextPercent={contextPercent}
          buildContext={buildContext}
        />

        {isFinished && <FinishedBanner targetBranch={targetBranch} />}

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
          className={`session-content-area${conversations ? " with-sidebar" : ""}`}
          data-layout={layout}
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

          <ConversationPanel
            {...conversationPanelProps}
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
