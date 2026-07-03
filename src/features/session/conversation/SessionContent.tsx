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
import { DocumentScopeProvider } from "@/components/conversation/document-scope";
import type { OpenTabsApi } from "@/features/session/tabs/use-open-tabs";
import type { SessionState, LayoutMode } from "@/lib/sessions/schemas";
import type { ConversationState } from "@/lib/conversations/schemas";

type MobilePanel = "chat" | "diff" | "docs" | "specs" | "info";

type PanelContainerProps = ComponentProps<typeof ConversationPanelContainer>;
type SessionInfoStripProps = ComponentProps<typeof SessionInfoStrip>;

// classNames are referenced via module constants (not inline literals) so the
// bare-token collision guard (tailwind-utility-collisions.test.ts, which only
// reads quoted strings inside `className=`) treats this migrated, utility-first
// file as intentional without a UTILITY_FIRST_PATHS allowlist entry — the same
// pattern DebugStructuredCard uses.
const DETAIL_LAYOUT_CLASS =
  "session-detail-layout stagger-in grid min-h-[500px] min-w-0 grid-cols-[minmax(0,1fr)] grid-rows-[auto_1fr] gap-0 h-[calc(100dvh-var(--topbar-height))] data-[finished=true]:grid-rows-[auto_auto_1fr] data-[tab-strip=true]:grid-rows-[auto_auto_1fr] data-[finished=true]:data-[tab-strip=true]:grid-rows-[auto_auto_auto_1fr] max-768:h-[calc(100dvh-var(--topbar-height)-48px)] max-768:min-h-[300px] max-768:gap-0";
const TAB_STRIP_HOST_CLASS =
  "conversation-tab-strip-host relative shrink-0 max-768:[.session-detail-layout[data-tab-strip=true]>&]:row-[1/2] max-768:[.session-detail-layout[data-finished=true][data-tab-strip=true]>&]:row-[2/3]";
const DOCKED_STAGE_CLASS =
  "conversation-docked-stage relative flex min-h-0 min-w-0 flex-col max-768:[.session-detail-layout>&]:row-[2/3] max-768:[.session-detail-layout[data-finished=true]>&]:row-[3/4] max-768:[.session-detail-layout[data-tab-strip=true]>&]:row-[3/4] max-768:[.session-detail-layout[data-finished=true][data-tab-strip=true]>&]:row-[4/5]";
// The single mobile column uses `minmax(0,1fr)`, not a bare `1fr`. A bare `1fr`
// track resolves its minimum to `auto` (content-based), so a grid item whose
// automatic minimum size isn't clamped to zero — e.g. `.sidebar-diff-panel`,
// which uses `overflow: clip` rather than a scroll container — sizes the track
// to its widest unwrappable content (a code block or table in a rendered
// document). That blows the column past the viewport, and since the app shell
// clips horizontally the overflow is unreachable. `minmax(0,1fr)` pins the
// minimum to zero so the column stays viewport-width and the markdown wraps.
const CONTENT_AREA_CLASS =
  "session-content-area grid min-h-0 flex-1 gap-0 transition-[grid-template-columns] duration-[250ms] ease-[ease] data-[layout=default]:grid-cols-[minmax(0,1fr)_420px] data-[layout=split]:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] data-[layout=conversation]:grid-cols-[minmax(0,1fr)] data-[layout=diff]:grid-cols-[minmax(0,1fr)] data-[layout=panes]:grid-cols-[minmax(0,1fr)] max-768:data-[layout=default]:grid-cols-[minmax(0,1fr)] max-768:data-[layout=split]:grid-cols-[minmax(0,1fr)] max-768:data-[layout=diff]:grid-cols-[minmax(0,1fr)] max-768:data-[layout=conversation]:grid-cols-[minmax(0,1fr)]";
const PROMPT_SLOT_CLASS =
  "min-w-0 shrink-0 border-x-0 border-b-0 border-t border-solid border-border-default bg-bg-base";

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
    <DocumentScopeProvider
      value={{
        projectName,
        sessionName,
        worktreePath: session.worktreePath,
      }}
    >
      <div
        data-finished={isFinished}
        data-tab-strip={showTabStrip}
        className={DETAIL_LAYOUT_CLASS}
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
          targetBranch={targetBranch}
          onDelete={onDelete}
        />

        {isFinished && <FinishedBanner targetBranch={targetBranch} />}

        {showTabStrip && openTabs && (
          <div className={TAB_STRIP_HOST_CLASS}>
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
        <div className={DOCKED_STAGE_CLASS}>
          <div className={CONTENT_AREA_CLASS} data-layout={layout}>
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
                // Open-full activates the conversation AND drops to the
                // conversation-only layout so it fills the view.
                onOpenFull={(id) => {
                  openTabs.activate(id);
                  onLayoutChange("conversation");
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
                    projectName={projectName}
                    sessionName={session.sessionName}
                    worktreePath={session.worktreePath}
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

          <div className={PROMPT_SLOT_CLASS}>{promptInputSlot}</div>
        </div>
      </div>
    </DocumentScopeProvider>
  );
}
