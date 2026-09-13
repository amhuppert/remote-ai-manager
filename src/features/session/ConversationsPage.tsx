"use client";

import { Suspense, useCallback, useEffect, useMemo } from "react";
import { useSearchParams } from "next/navigation";
import Topbar from "@/components/Topbar";
import ConversationWorkspace from "@/features/session/ConversationWorkspace";
import ConversationSidebar from "@/components/session/sidebar/ConversationSidebar";
import {
  EmptyState,
  EmptyStateTitle,
  EmptyStateDesc,
} from "@/components/ui/EmptyState";
import { WithTooltip } from "@/components/ui/WithTooltip";
import { useQuickTicketConversationRegistration } from "@/components/quick-ticket/useQuickTicketConversationRegistration";
import { parseConversationsPageParams } from "@/lib/conversations/hrefs";
import { useConversationLookupQuery } from "@/lib/conversations/queries";
import {
  useMobilePanel,
  useSidebarCollapsed,
  useToggleSidebar,
  useMobileSidebarOpen,
  useCloseMobileSidebar,
  useHydrateLayout,
  useSwitchLayout,
  useLayout,
} from "@/stores/session-detail.store";
import type { BackendSelectionDefaultsById } from "@/lib/agent-backends/conversation-policy";
import { type OpenTabsApi } from "@/features/session/tabs/use-open-tabs";
import { useConversationsPageSelection } from "./hooks/use-conversations-page-selection";
import {
  resolveConversationsRenderState,
  CONVERSATIONS_LAYOUT_STORAGE_KEY,
  type ConversationsRenderState,
} from "./conversations-page-state";

interface Props {
  backendDefaults: BackendSelectionDefaultsById;
}

function StatusPanel({
  title,
  description,
}: {
  title: string;
  description?: string;
}): React.JSX.Element {
  return (
    <EmptyState role="status">
      <EmptyStateTitle>{title}</EmptyStateTitle>
      {description !== undefined && (
        <EmptyStateDesc>{description}</EmptyStateDesc>
      )}
    </EmptyState>
  );
}

function renderPanel(
  state: ConversationsRenderState,
  props: Props,
  autoFocus: boolean,
  onOpenConversation: (target: { conversationId: string }) => void,
  openTabs: OpenTabsApi,
): React.JSX.Element {
  switch (state.kind) {
    case "workspace":
      // Intentionally NOT keyed by conversationId. The page is a
      // multi-conversation surface (tabs + panes): activating a tab/pane is a
      // selection change, not a new workspace. Keying here would remount the
      // entire workspace — including the panes grid and every pane — on each
      // activation and replay the `.stagger-in` entrance animation (the
      // "flash"). Per-conversation state is instead reset reactively on
      // conversationId change (see useSessionLifecycle); the message list keeps
      // its own `key={conversationId}` inside ConversationVirtuosoList.
      return (
        <ConversationWorkspace
          projectName={state.conversation.projectName}
          sessionName={state.conversation.sessionName}
          conversationId={state.conversation.conversationId}
          backendDefaults={props.backendDefaults}
          autoFocus={autoFocus}
          onOpenConversation={onOpenConversation}
          openTabs={openTabs}
        />
      );
    case "loading":
      return <StatusPanel title="Loading conversation..." />;
    case "not-found":
      return (
        <StatusPanel
          title="Conversation not found"
          description="It may have been deleted. Pick a conversation from the list."
        />
      );
    case "error":
      return <StatusPanel title="Failed to load conversation" />;
    case "empty":
      return (
        <StatusPanel
          title="Select a conversation"
          description="Pick a conversation from the list, or start one from a session."
        />
      );
  }
}

export default function ConversationsPage(props: Props): React.JSX.Element {
  // useSearchParams() forces a CSR bailout during prerender; Next.js requires
  // a Suspense boundary above it for the /conversations static shell to build.
  return (
    <Suspense>
      <ConversationsPageInner {...props} />
    </Suspense>
  );
}

function ConversationsPageInner(props: Props): React.JSX.Element {
  const searchParams = useSearchParams();
  const params = useMemo(
    () => parseConversationsPageParams(searchParams),
    [searchParams],
  );

  // Layout is page-level for /conversations: hydrate once on mount from the
  // single page-level key, not per active conversation, so activating a pane
  // from a different session can't re-hydrate that session's layout (§3.5).
  const hydrateLayout = useHydrateLayout();
  useEffect(() => {
    hydrateLayout(CONVERSATIONS_LAYOUT_STORAGE_KEY);
  }, [hydrateLayout]);

  const lookupQuery = useConversationLookupQuery(params.conversationId);
  const { openConversation, autoOpen, openTabs } =
    useConversationsPageSelection(params, lookupQuery.data);
  const renderState = resolveConversationsRenderState({
    conversationId: params.conversationId,
    lookup: {
      isPending: lookupQuery.isPending,
      isError: lookupQuery.isError,
      data: lookupQuery.data,
    },
    autoOpen,
  });

  const mobilePanel = useMobilePanel();
  const sidebarCollapsed = useSidebarCollapsed();
  const toggleSidebar = useToggleSidebar();
  const mobileSidebarOpen = useMobileSidebarOpen();
  const closeMobileSidebar = useCloseMobileSidebar();
  const layout = useLayout();
  const switchLayout = useSwitchLayout();

  // Context-menu "Open in New Tab": the tab strip is shown in every non-panes
  // layout, so only drop out of panes; never disturb an already tab-showing
  // layout. Then open the conversation (which adds it to the working set).
  const handleOpenInTab = useCallback(
    (target: { conversationId: string }) => {
      if (layout === "panes") {
        switchLayout("conversation", CONVERSATIONS_LAYOUT_STORAGE_KEY);
      }
      openConversation({ conversationId: target.conversationId });
    },
    [layout, switchLayout, openConversation],
  );

  // Context-menu "Open in New Pane": switch into the split-screen panes layout
  // unless already there, then open the conversation as a pane.
  const handleOpenInPane = useCallback(
    (target: { conversationId: string }) => {
      if (layout !== "panes") {
        switchLayout("panes", CONVERSATIONS_LAYOUT_STORAGE_KEY);
      }
      openConversation({ conversationId: target.conversationId });
    },
    [layout, switchLayout, openConversation],
  );

  const resolved =
    renderState.kind === "workspace" ? renderState.conversation : null;
  useQuickTicketConversationRegistration(
    resolved === null
      ? null
      : {
          projectName: resolved.projectName,
          sessionName: resolved.sessionName,
          conversationId: resolved.conversationId,
          title:
            resolved.conversationName ?? resolved.summary ?? "Conversation",
        },
  );

  return (
    <div className="app" data-page="detail" data-mobile-panel={mobilePanel}>
      <Topbar
        page="detail"
        breadcrumbs={
          resolved
            ? [
                { label: "projects", href: "/projects" },
                {
                  label: resolved.projectName,
                  href: `/projects/${encodeURIComponent(resolved.projectName)}`,
                  isProject: true,
                },
                {
                  label: resolved.sessionName,
                  href: `/projects/${encodeURIComponent(resolved.projectName)}/${encodeURIComponent(resolved.sessionName)}`,
                  isSession: true,
                },
              ]
            : [
                { label: "projects", href: "/projects" },
                { label: "conversations" },
              ]
        }
      />
      <main
        className="main"
        data-with-sidebar="on"
        data-sidebar-collapsed={sidebarCollapsed ? "true" : "false"}
      >
        <ConversationSidebar
          projectName={resolved?.projectName ?? ""}
          sessionName={resolved?.sessionName ?? ""}
          activeConversationId={params.conversationId ?? ""}
          backendDefaults={props.backendDefaults}
          mobileOpen={mobileSidebarOpen}
          onMobileClose={closeMobileSidebar}
          showNewConversationButton={resolved !== null}
          onOpenConversation={openConversation}
          onOpenInTab={handleOpenInTab}
          onOpenInPane={handleOpenInPane}
        />

        {sidebarCollapsed && (
          <WithTooltip label="Expand sidebar" side="right">
            <button
              className="fixed left-0 top-1/2 z-sticky flex h-[48px] w-[20px] -translate-y-1/2 items-center justify-center rounded-l-none rounded-r-sm border-y border-r border-l-0 border-solid border-border-default bg-bg-raised p-0 text-[0.7rem] text-cyan cursor-pointer transition-[color,background-color,border-color,box-shadow] duration-150 ease-[ease] hover:border-cyan-dim hover:bg-bg-elevated hover:text-cyan hover:shadow-[0_0_8px_var(--color-cyan-glow)] max-768:hidden"
              onClick={toggleSidebar}
              aria-label="Expand sidebar"
            >
              {"▶"}
            </button>
          </WithTooltip>
        )}

        {renderPanel(
          renderState,
          props,
          params.autoFocus,
          openConversation,
          openTabs,
        )}
      </main>
    </div>
  );
}
