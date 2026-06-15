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
  pendingApproval: null,
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

  const gatedSessionConversation = {
    scope: "session" as const,
    id: "gated-session-convo",
    name: "Gated session conversation",
    status: "awaiting" as const,
    lastActivityAt: "2026-05-15T12:36:00.000Z",
    projectName: "remote-ai-manager",
    projectPath: "/home/alex/github/remote-ai-manager",
    sessionName: "gated-session",
    branchName: "csm/gated-session",
    worktreePath: "/home/alex/github/remote-ai-manager/.worktrees/gated",
    agentBackend: "claude" as const,
    summary: null,
    pendingQuestion: null,
    pendingQuestionId: null,
    pendingQuestions: null,
    forkedFrom: null,
    debugActive: false,
    role: "iteration" as const,
    lastActivitySummary: "Awaiting your review.",
    unread: false,
    pendingApproval: {
      contextId: "ctx-1",
      contextTitle: "Implement feature",
      requestedAt: "2026-05-15T12:30:00.000Z",
      workflowName: null,
      executionSuspended: false,
      tasksCompleted: 6,
      tasksTotal: 6,
    },
  };

  it("hides the archive affordance in the context menu while an approval gate is pending", () => {
    renderSidebarWithActiveData({
      conversations: [gatedSessionConversation, currentProjectConversation],
      graphWorkflowExecutions: [],
      activeCollaborationExecutions: [],
    });

    fireEvent.contextMenu(
      screen.getByLabelText("Gated session conversation — awaiting"),
    );
    expect(screen.queryByText("Archive conversation")).toBeNull();
    expect(screen.getByText("Rename…")).not.toBeNull();
    fireEvent.keyDown(document, { key: "Escape" });

    fireEvent.contextMenu(
      screen.getByLabelText("Current project cockpit — running"),
    );
    expect(screen.getByText("Archive conversation")).not.toBeNull();
  });

  it("shows the suspended hint in the peek for a gated row whose execution is halted", async () => {
    const fetchMock = vi.fn<(url: RequestInfo | URL) => Promise<Response>>(
      async () =>
        new Response(JSON.stringify({ messages: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    try {
      renderSidebarWithActiveData({
        conversations: [
          {
            ...gatedSessionConversation,
            pendingApproval: {
              ...gatedSessionConversation.pendingApproval,
              executionSuspended: true,
            },
          },
        ],
        // A halted execution is excluded from the active execution list, so
        // the suspended flag must come from the row's standing payload.
        graphWorkflowExecutions: [],
        activeCollaborationExecutions: [],
      });

      fireEvent.click(
        screen.getByLabelText("Gated session conversation — awaiting"),
      );

      expect(
        await screen.findByText(/Execution suspended/),
      ).toBeInTheDocument();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  describe("onOpenConversation seam", () => {
    const sessionScopedConversation = {
      scope: "session" as const,
      id: "session-convo-1",
      name: "Session conversation one",
      status: "awaiting" as const,
      lastActivityAt: "2026-05-15T12:36:00.000Z",
      projectName: "remote-ai-manager",
      projectPath: "/home/alex/github/remote-ai-manager",
      sessionName: "conversation-ui-overhaul",
      branchName: "csm/conversation-ui-overhaul",
      worktreePath: "/home/alex/github/remote-ai-manager/.worktrees/overhaul",
      agentBackend: "claude" as const,
      summary: null,
      pendingQuestion: null,
      pendingQuestionId: null,
      pendingQuestions: null,
      forkedFrom: null,
      debugActive: false,
      role: null,
      lastActivitySummary: "Awaiting your review.",
      unread: false,
      pendingApproval: null,
    };

    const sessionRowHref = "/conversations?c=session-convo-1";

    const createdConversationState = {
      id: "created-convo-1",
      scope: "session",
      name: null,
      transcriptPath: null,
      status: "new",
      promptCount: 0,
      createdAt: "2026-05-15T12:40:00.000Z",
      lastActivityAt: "2026-05-15T12:40:00.000Z",
      source: "cc",
      summary: null,
      archived: false,
      totalCostUsd: null,
      totalDurationMs: null,
      totalTurns: null,
      pendingQuestionId: null,
      pendingQuestions: null,
      pendingPromptText: null,
      forkedFrom: null,
      role: null,
      activeTurnSource: null,
      contextTokens: null,
      contextWindowMax: null,
      debugMode: null,
      machineSnapshot: null,
      agentBackend: "claude",
      backendRef: null,
      unread: false,
      pendingQueue: [],
    };

    const sessionActiveData: ActiveConversationsResponse = {
      conversations: [sessionScopedConversation, currentProjectConversation],
      graphWorkflowExecutions: [],
      activeCollaborationExecutions: [],
    };

    function jsonResponse(body: unknown): Response {
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    function stubApiFetch(): void {
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: RequestInfo | URL) => {
          const target = String(url);
          if (target.includes("/fork")) {
            return jsonResponse({
              conversationId: "forked-convo-1",
              name: "Forked conversation",
              forkMode: "native",
            });
          }
          if (target.endsWith("/conversations")) {
            return jsonResponse(createdConversationState);
          }
          return jsonResponse([]);
        }),
      );
    }

    beforeEach(stubApiFetch);
    afterEach(() => vi.unstubAllGlobals());

    async function openPeek(): Promise<void> {
      fireEvent.click(
        screen.getByLabelText("Session conversation one — awaiting"),
      );
      await screen.findByLabelText("Conversation peek");
    }

    it("keeps rendering the real session href on the row anchor when the prop is provided", () => {
      renderSidebarWithActiveData(sessionActiveData, {
        onOpenConversation: vi.fn(),
      });

      const anchor = screen.getByLabelText(
        "Session conversation one — awaiting",
      );
      expect(anchor.getAttribute("href")).toBe(sessionRowHref);
    });

    it("opens a session conversation from the peek through onOpenConversation when provided", async () => {
      const onOpenConversation = vi.fn();
      renderSidebarWithActiveData(sessionActiveData, { onOpenConversation });

      await openPeek();
      fireEvent.click(
        screen.getByRole("button", { name: "Open conversation" }),
      );

      expect(onOpenConversation).toHaveBeenCalledTimes(1);
      expect(onOpenConversation).toHaveBeenCalledWith({
        conversationId: "session-convo-1",
        projectName: "remote-ai-manager",
        sessionName: "conversation-ui-overhaul",
      });
      expect(routerPushMock).not.toHaveBeenCalled();
    });

    it("falls back to router.push for the peek open when the prop is absent", async () => {
      renderSidebarWithActiveData(sessionActiveData);

      await openPeek();
      fireEvent.click(
        screen.getByRole("button", { name: "Open conversation" }),
      );

      expect(routerPushMock).toHaveBeenCalledTimes(1);
      expect(routerPushMock).toHaveBeenCalledWith(sessionRowHref);
    });

    it("routes the new-conversation open through onOpenConversation when provided", async () => {
      const onOpenConversation = vi.fn();
      renderSidebarWithActiveData(sessionActiveData, { onOpenConversation });

      fireEvent.click(screen.getByLabelText("New conversation"));

      await waitFor(() => {
        expect(onOpenConversation).toHaveBeenCalledWith({
          conversationId: "created-convo-1",
          projectName: "remote-ai-manager",
          sessionName: "conversation-ui-overhaul",
        });
      });
      expect(routerPushMock).not.toHaveBeenCalled();
    });

    it("falls back to router.push after create when the prop is absent", async () => {
      renderSidebarWithActiveData(sessionActiveData);

      fireEvent.click(screen.getByLabelText("New conversation"));

      await waitFor(() => {
        expect(routerPushMock).toHaveBeenCalledWith(
          "/conversations?c=created-convo-1",
        );
      });
    });

    it("routes the fork open from the peek through onOpenConversation when provided", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: RequestInfo | URL) => {
          const target = String(url);
          if (target.includes("/fork")) {
            return jsonResponse({
              conversationId: "forked-convo-1",
              name: "Forked conversation",
              forkMode: "native",
            });
          }
          return jsonResponse([
            {
              role: "user",
              content: [{ type: "text", text: "Hello from the transcript" }],
              timestamp: "2026-05-15T12:30:00.000Z",
              seq: 0,
            },
          ]);
        }),
      );
      const onOpenConversation = vi.fn();
      renderSidebarWithActiveData(sessionActiveData, { onOpenConversation });

      await openPeek();
      fireEvent.click(
        await screen.findByTitle("Fork conversation from this message"),
      );

      await waitFor(() => {
        expect(onOpenConversation).toHaveBeenCalledWith({
          conversationId: "forked-convo-1",
          projectName: "remote-ai-manager",
          sessionName: "conversation-ui-overhaul",
        });
      });
      expect(routerPushMock).not.toHaveBeenCalled();
    });

    it("opens a session conversation from the context menu through onOpenConversation when provided", async () => {
      const onOpenConversation = vi.fn();
      renderSidebarWithActiveData(sessionActiveData, { onOpenConversation });

      fireEvent.contextMenu(
        screen.getByLabelText("Session conversation one — awaiting"),
      );
      fireEvent.click(screen.getByText("Open conversation"));

      expect(onOpenConversation).toHaveBeenCalledWith({
        conversationId: "session-convo-1",
        projectName: "remote-ai-manager",
        sessionName: "conversation-ui-overhaul",
      });
      expect(routerPushMock).not.toHaveBeenCalled();
    });

    it("always router.pushes project-scoped rows, even when the prop is provided", () => {
      const onOpenConversation = vi.fn();
      renderSidebarWithActiveData(sessionActiveData, { onOpenConversation });

      fireEvent.click(
        screen.getByLabelText("Current project cockpit — running"),
      );

      expect(routerPushMock).toHaveBeenCalledWith(
        "/projects/remote-ai-manager?focus=current-project-convo",
      );
      expect(onOpenConversation).not.toHaveBeenCalled();
    });

    it("opens a session conversation in a new tab through onOpenInTab from the context menu", () => {
      const onOpenInTab = vi.fn();
      renderSidebarWithActiveData(sessionActiveData, { onOpenInTab });

      fireEvent.contextMenu(
        screen.getByLabelText("Session conversation one — awaiting"),
      );
      fireEvent.click(screen.getByText("Open in New Tab"));

      expect(onOpenInTab).toHaveBeenCalledWith({
        conversationId: "session-convo-1",
        projectName: "remote-ai-manager",
        sessionName: "conversation-ui-overhaul",
      });
    });

    it("opens a session conversation in a new pane through onOpenInPane from the context menu", () => {
      const onOpenInPane = vi.fn();
      renderSidebarWithActiveData(sessionActiveData, { onOpenInPane });

      fireEvent.contextMenu(
        screen.getByLabelText("Session conversation one — awaiting"),
      );
      fireEvent.click(screen.getByText("Open in New Pane"));

      expect(onOpenInPane).toHaveBeenCalledWith({
        conversationId: "session-convo-1",
        projectName: "remote-ai-manager",
        sessionName: "conversation-ui-overhaul",
      });
    });

    it("omits the tab/pane actions for project-scoped rows", () => {
      renderSidebarWithActiveData(sessionActiveData, {
        onOpenInTab: vi.fn(),
        onOpenInPane: vi.fn(),
      });

      fireEvent.contextMenu(
        screen.getByLabelText("Current project cockpit — running"),
      );

      expect(screen.queryByText("Open in New Tab")).toBeNull();
      expect(screen.queryByText("Open in New Pane")).toBeNull();
    });

    it("omits the tab/pane actions when the host does not provide the callbacks", () => {
      renderSidebarWithActiveData(sessionActiveData);

      fireEvent.contextMenu(
        screen.getByLabelText("Session conversation one — awaiting"),
      );

      expect(screen.queryByText("Open in New Tab")).toBeNull();
      expect(screen.queryByText("Open in New Pane")).toBeNull();
    });
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
