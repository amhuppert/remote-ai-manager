"use client";

import { Suspense, useEffect, useMemo } from "react";
import { useSearchParams } from "next/navigation";
import Topbar from "@/components/Topbar";
import ConversationWorkspace from "@/features/session/ConversationWorkspace";
import ConversationSidebar from "@/features/session/sidebar/ConversationSidebar";
import { parseConversationsPageParams } from "@/lib/conversations/hrefs";
import { useConversationLookupQuery } from "@/lib/conversations/queries";
import {
  useMobilePanel,
  useSidebarCollapsed,
  useToggleSidebar,
  useMobileSidebarOpen,
  useCloseMobileSidebar,
  useHydrateLayout,
} from "@/stores/session-detail.store";
import { type EffortLevel } from "@/lib/agent-backends/schemas";
import { type OpenTabsApi } from "@/features/session/tabs/use-open-tabs";
import { useConversationsPageSelection } from "./hooks/use-conversations-page-selection";
import {
  resolveConversationsRenderState,
  CONVERSATIONS_LAYOUT_STORAGE_KEY,
  type ConversationsRenderState,
} from "./conversations-page-state";

interface Props {
  defaultModel: string;
  defaultEffort?: EffortLevel;
}

function StatusPanel({
  title,
  description,
}: {
  title: string;
  description?: string;
}): React.JSX.Element {
  return (
    <div className="empty-state" role="status">
      <div className="empty-state-title">{title}</div>
      {description !== undefined && (
        <div className="empty-state-desc">{description}</div>
      )}
    </div>
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
      return (
        <ConversationWorkspace
          key={state.conversation.conversationId}
          projectName={state.conversation.projectName}
          sessionName={state.conversation.sessionName}
          conversationId={state.conversation.conversationId}
          defaultModel={props.defaultModel}
          defaultEffort={props.defaultEffort}
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
    useConversationsPageSelection(params);
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

  const resolved =
    renderState.kind === "workspace" ? renderState.conversation : null;

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
          mobileOpen={mobileSidebarOpen}
          onMobileClose={closeMobileSidebar}
          showNewConversationButton={resolved !== null}
          onOpenConversation={openConversation}
        />

        {sidebarCollapsed && (
          <button
            className="convo-sidebar-expand-float"
            onClick={toggleSidebar}
            data-tooltip="Expand sidebar"
          >
            {"▶"}
          </button>
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
