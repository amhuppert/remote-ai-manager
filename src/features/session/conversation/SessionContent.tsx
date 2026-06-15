"use client";

import { useState, type ComponentProps, type ReactNode } from "react";
import ConversationPanelContainer from "@/features/session/conversation/ConversationPanelContainer";
import { FinishedBanner } from "@/components/conversation/ConversationBanners";
import SessionInfoStrip from "@/features/session/conversation/SessionInfoStrip";
import MobileInfoPanel from "@/features/session/mobile/MobileInfoPanel";
import RightPane from "@/features/session/conversation/RightPane";
import ConversationTabStrip from "@/features/session/tabs/ConversationTabStrip";
import AddConversationMenu from "@/features/session/tabs/AddConversationMenu";
import PanesGrid from "@/features/session/panes/PanesGrid";
import type { OpenTabsApi } from "@/features/session/tabs/use-open-tabs";
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
  panelContainerProps: PanelContainerProps;
  promptInputSlot: ReactNode;
  /**
   * Page-level open-tabs working set + operations, provided only on
   * /conversations. Drives the tab strip (non-panes layouts) and the panes
   * grid (panes layout). Absent on the per-conversation route, which has no
   * working set — strip and grid are then never rendered.
   */
  openTabs?: OpenTabsApi;

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
  openTabs,
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
  const isPanes = layout === "panes";
  const workingSet = openTabs?.workingSet ?? [];
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const showTabStrip = !isPanes && !!openTabs && workingSet.length > 0;

  return (
    <div
      className={`session-detail-layout stagger-in${isFinished ? " finished" : ""}${
        showTabStrip ? " has-tab-strip" : ""
      }`}
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

      {showTabStrip && openTabs && (
        <div className="conversation-tab-strip-host">
          <ConversationTabStrip
            workingSet={workingSet}
            activeId={openTabs.activeId}
            isAtCap={openTabs.isAtCap}
            onActivate={openTabs.activate}
            onClose={openTabs.closeTab}
            onAddClick={() => setAddMenuOpen((o) => !o)}
          />
          {addMenuOpen && (
            <AddConversationMenu
              addableConversations={openTabs.addableConversations}
              onAdd={(id) => {
                openTabs.addTab(id);
                setAddMenuOpen(false);
              }}
              onClose={() => setAddMenuOpen(false)}
            />
          )}
        </div>
      )}

      {/* Positioned stage spanning the conversation content + composer. The
          AskUserQuestion overlay is rendered (absolutely positioned) inside the
          composer slot and anchors to this stage so its scrim covers the
          conversation while its banner sits where the composer is — matching
          the peek (`.peek__stage`) and per-panel (`.conversation-stage`)
          stages. Without it the overlay has no positioned ancestor. */}
      <div className="conversation-docked-stage">
        <div className="session-content-area" data-layout={layout}>
          {isPanes && openTabs ? (
            // Panes replaces the single-conversation panel + diff with a
            // full-width grid of every open conversation.
            <PanesGrid
              workingSet={workingSet}
              activeId={openTabs.activeId}
              isAtCap={openTabs.isAtCap}
              addableConversations={openTabs.addableConversations}
              onActivate={openTabs.activate}
              onClose={openTabs.closeTab}
              onAdd={openTabs.addTab}
              // Open-full activates the conversation AND drops back to the
              // single-conversation layout so it fills the view.
              onOpenFull={(id) => {
                openTabs.activate(id);
                onLayoutChange("default");
              }}
              onExit={() => onLayoutChange("default")}
            />
          ) : (
            <>
              <ConversationPanelContainer {...panelContainerProps} />

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
            </>
          )}
        </div>

        <div className="pinned-composer-row">{promptInputSlot}</div>
      </div>
    </div>
  );
}
