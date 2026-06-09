// @vitest-environment jsdom
import type { ComponentProps } from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
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

type ProjectActiveConversationWithOpen = ProjectActiveConversation & {
  open: boolean;
};

const currentProjectConversation: ProjectActiveConversationWithOpen = {
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
  open: true,
};

const otherProjectConversation: ProjectActiveConversationWithOpen = {
  ...currentProjectConversation,
  id: "other-project-convo",
  name: "Other project cockpit",
  projectName: "creative-ai",
  projectPath: "/home/alex/github/creative-ai",
  worktreePath: "/home/alex/github/creative-ai",
  lastActivitySummary: "Checking cross-project focus routing.",
};

const closedWaitingProjectConversation: ProjectActiveConversationWithOpen = {
  ...currentProjectConversation,
  id: "closed-waiting-project-convo",
  name: "Closed waiting project cockpit",
  status: "waiting_for_input",
  unread: true,
  open: false,
};

const openWaitingProjectConversation: ProjectActiveConversationWithOpen = {
  ...currentProjectConversation,
  id: "open-waiting-project-convo",
  name: "Open waiting project cockpit",
  status: "waiting_for_input",
  unread: false,
  open: true,
};

const activeConversations: ActiveConversationsResponse = {
  conversations: [currentProjectConversation, otherProjectConversation],
  graphWorkflowExecutions: [],
  activeCollaborationExecutions: [],
};

function renderSidebarWithActiveData(
  active: ActiveConversationsResponse,
  props: Partial<ComponentProps<typeof ConversationSidebar>> = {},
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
        {...props}
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

  it("can hide the session-scoped new conversation action for the project cockpit rail", () => {
    renderSidebarWithActiveData(activeConversations, {
      showNewConversationButton: false,
    });

    expect(screen.queryByLabelText("New conversation")).toBeNull();
  });

  it("renders its own collapse toggle by default (session page)", () => {
    renderSidebarWithActiveData(activeConversations);
    expect(document.querySelector(".convo-sidebar-toggle")).not.toBeNull();
  });

  it("omits its own collapse toggle, and never self-collapses, when the host owns rail collapse (cockpit rail)", () => {
    // Simulate a stale collapsed state persisted from the session page.
    useSessionDetailStore.getState().toggleSidebar();
    expect(useSessionDetailStore.getState().sidebarCollapsed).toBe(true);

    renderSidebarWithActiveData(activeConversations, {
      showCollapseControl: false,
    });

    // The redundant inner toggle is gone and the content stays visible — there
    // is no way to strand the panel because the host owns collapse.
    expect(document.querySelector(".convo-sidebar-toggle")).toBeNull();
    expect(screen.getByRole("tab", { name: /^All/ })).not.toBeNull();
  });

  it("marks an unread project conversation as read via the project endpoint when OK is pressed", async () => {
    const fetchMock = vi.fn<(url: RequestInfo | URL) => Promise<Response>>(
      async () =>
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    try {
      renderSidebarWithActiveData({
        conversations: [
          {
            ...currentProjectConversation,
            id: "unread-finished-project-convo",
            name: "Unread finished project cockpit",
            status: "awaiting",
            unread: true,
            open: true,
          },
        ],
        graphWorkflowExecutions: [],
        activeCollaborationExecutions: [],
      });

      // The OK button only renders when an acknowledge handler is wired — it
      // was missing for project rows before this fix.
      fireEvent.click(
        screen.getByRole("button", {
          name: /Mark "Unread finished project cockpit" as read/i,
        }),
      );

      await waitFor(() => {
        const hitMarkRead = fetchMock.mock.calls.some(([url]) =>
          String(url).includes(
            "/api/projects/remote-ai-manager/conversations/unread-finished-project-convo/mark-read",
          ),
        );
        expect(hitMarkRead).toBe(true);
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("renders closed project conversations in Closed and excludes them from Needs/Run counts", () => {
    renderSidebarWithActiveData({
      conversations: [
        openWaitingProjectConversation,
        closedWaitingProjectConversation,
        {
          ...closedWaitingProjectConversation,
          id: "closed-running-project-convo",
          name: "Closed running project cockpit",
          status: "running",
          unread: false,
        },
        {
          ...currentProjectConversation,
          id: "open-running-project-convo",
          name: "Open running project cockpit",
          status: "running",
        },
      ],
      graphWorkflowExecutions: [],
      activeCollaborationExecutions: [],
    });

    expect(screen.getByRole("tab", { name: "Needs 1" })).not.toBeNull();
    expect(screen.getByRole("tab", { name: "Run 1" })).not.toBeNull();
    expect(screen.getByText("Closed")).not.toBeNull();
    expect(screen.getByText("Closed waiting project cockpit")).not.toBeNull();
    expect(screen.getByText("Closed running project cockpit")).not.toBeNull();
  });
});
