// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type {
  ActiveConversationsResponse,
  ProjectActiveConversation,
} from "@/lib/active-conversations/schemas";
import { conversationKeys } from "@/lib/conversations/query-keys";
import { useSessionDetailStore } from "@/stores/session-detail.store";
import ConversationSidebar from "@/features/session/sidebar/ConversationSidebar";

const routerPushMock = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: routerPushMock,
  }),
}));

const currentProjectConversation: ProjectActiveConversation = {
  scope: "project",
  id: "current-project-convo",
  name: "Current project cockpit",
  status: "running",
  lastActivityAt: "2026-05-15T12:36:00.000Z",
  projectName: "remote-ai-manager",
  projectPath: "/home/alex/github/remote-ai-manager",
  agentBackend: "claude",
  summary: null,
  pendingQuestion: null,
  pendingQuestionId: null,
  pendingQuestions: null,
  forkedFrom: null,
  debugActive: false,
  role: null,
  worktreePath: "/home/alex/github/remote-ai-manager",
  lastActivitySummary: "Checking current project focus routing.",
  unread: false,
};

const otherProjectConversation: ProjectActiveConversation = {
  ...currentProjectConversation,
  id: "other-project-convo",
  name: "Other project cockpit",
  projectName: "creative-ai",
  projectPath: "/home/alex/github/creative-ai",
  worktreePath: "/home/alex/github/creative-ai",
  lastActivitySummary: "Checking cross-project focus routing.",
};

const activeConversations: ActiveConversationsResponse = {
  conversations: [currentProjectConversation, otherProjectConversation],
  graphWorkflowExecutions: [],
  activeCollaborationExecutions: [],
};

function renderSidebarWithActiveData(
  active: ActiveConversationsResponse,
): void {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Infinity, gcTime: Infinity },
    },
  });
  queryClient.setQueryData(conversationKeys.active(), active);

  render(
    <QueryClientProvider client={queryClient}>
      <ConversationSidebar
        projectName="remote-ai-manager"
        sessionName="conversation-ui-overhaul"
        activeConversationId="session-convo"
      />
    </QueryClientProvider>,
  );
}

describe("ConversationSidebar", () => {
  beforeEach(() => {
    routerPushMock.mockClear();
    window.localStorage.clear();
    window.sessionStorage.clear();
    useSessionDetailStore.getState().resetStore();
  });

  afterEach(() => {
    cleanup();
    window.localStorage.clear();
    window.sessionStorage.clear();
    useSessionDetailStore.getState().resetStore();
  });

  it("pushes production-derived project focus URLs for current-project and other-project active rows", () => {
    renderSidebarWithActiveData(activeConversations);

    fireEvent.click(screen.getByLabelText("Current project cockpit — running"));
    fireEvent.click(screen.getByLabelText("Other project cockpit — running"));

    expect(routerPushMock).toHaveBeenNthCalledWith(
      1,
      "/projects/remote-ai-manager?focus=current-project-convo",
    );
    expect(routerPushMock).toHaveBeenNthCalledWith(
      2,
      "/projects/creative-ai?focus=other-project-convo",
    );
  });
});
