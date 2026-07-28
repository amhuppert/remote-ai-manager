// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ActiveConversationsResponse } from "@/lib/active-conversations/schemas";
import type { ConversationListItem } from "@/lib/conversations/schemas";
import { conversationKeys } from "@/lib/conversations/query-keys";
import { useSessionDetailStore } from "@/stores/session-detail.store";
import ConversationsPage from "@/features/session/ConversationsPage";

const routerPushMock = vi.fn();
const routerReplaceMock = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: routerPushMock,
    replace: routerReplaceMock,
    back: vi.fn(),
  }),
  usePathname: () => "/conversations",
  // Reads the live URL so renders triggered by data updates observe the
  // current history state, like Next.js's native-history integration does.
  useSearchParams: () => new URLSearchParams(window.location.search),
}));

vi.mock(
  "next/link",
  async () => (await import("@/test/component-mocks")).nextLinkMock,
);

function sessionRow(
  id: string,
  overrides: Partial<{
    name: string;
    lastActivityAt: string;
    projectName: string;
    sessionName: string;
  }> = {},
) {
  return {
    scope: "session" as const,
    id,
    name: overrides.name ?? id,
    status: "awaiting" as const,
    lastActivityAt: overrides.lastActivityAt ?? "2026-06-01T00:00:00.000Z",
    projectName: overrides.projectName ?? "repo",
    projectPath: "/projects/repo",
    sessionName: overrides.sessionName ?? "fix-bug",
    branchName: "csm/fix-bug",
    worktreePath: "/projects/repo/.worktrees/fix-bug",
    agentBackend: "claude" as const,
    summary: null,
    pendingQuestion: null,
    pendingQuestionId: null,
    pendingQuestions: null,
    forkedFrom: null,
    debugActive: false,
    role: null,
    lastActivitySummary: null,
    unread: false,
    pendingApproval: null,
    backgroundActivity: null,
  };
}

function lookupItem(conversationId: string): ConversationListItem {
  return {
    projectName: "repo",
    projectPath: "/projects/repo",
    scope: "session" as const,
    sessionName: "fix-bug",
    worktreePath: "/projects/repo/.worktrees/fix-bug",
    conversationId,
    conversationName: null,
    summary: null,
    firstPromptSnippet: null,
    backend: "claude",
    backendRef: null,
    transcriptPath: null,
    debugLogPath: null,
    status: "awaiting",
    lastActivityAt: "2026-06-01T00:00:00.000Z",
    archived: false,
  };
}

function activeData(
  conversations: ActiveConversationsResponse["conversations"],
): ActiveConversationsResponse {
  return {
    conversations,
    graphWorkflowExecutions: [],
    activeCollaborationExecutions: [],
    specExecutions: [],
  };
}

function renderPage(args: {
  url: string;
  active: ActiveConversationsResponse;
  lookups?: ConversationListItem[];
  notFoundIds?: string[];
}): QueryClient {
  window.history.replaceState(null, "", args.url);
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Infinity, gcTime: Infinity },
    },
  });
  queryClient.setQueryData(conversationKeys.active(), args.active);
  for (const item of args.lookups ?? []) {
    queryClient.setQueryData(
      conversationKeys.lookup(item.conversationId),
      item,
    );
  }
  for (const id of args.notFoundIds ?? []) {
    queryClient.setQueryData(conversationKeys.lookup(id), null);
  }
  render(
    <QueryClientProvider client={queryClient}>
      <ConversationsPage
        backendDefaults={{
          claude: { modelId: "sonnet", effort: "high" },
          codex: { modelId: "gpt-5.6-sol", effort: "high" },
        }}
      />
    </QueryClientProvider>,
  );
  return queryClient;
}

describe("ConversationsPage", () => {
  let pushStateSpy: ReturnType<typeof vi.spyOn>;
  let replaceStateSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    routerPushMock.mockClear();
    routerReplaceMock.mockClear();
    window.localStorage.clear();
    window.sessionStorage.clear();
    useSessionDetailStore.getState().resetStore();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify([]), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
      ),
    );
    pushStateSpy = vi.spyOn(window.history, "pushState");
    replaceStateSpy = vi.spyOn(window.history, "replaceState");
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    pushStateSpy.mockRestore();
    replaceStateSpy.mockRestore();
    window.history.replaceState(null, "", "/conversations");
    useSessionDetailStore.getState().resetStore();
  });

  describe("page-level layout hydration (§3.5, §3.6, §5.2)", () => {
    it("hydrates the layout once on mount from the page-level key", () => {
      window.localStorage.setItem("cc-conversations-layout", "panes");
      renderPage({
        url: "/conversations?c=conv-1",
        active: activeData([sessionRow("conv-1", { name: "Alpha" })]),
        lookups: [lookupItem("conv-1")],
      });

      expect(useSessionDetailStore.getState().layout).toBe("panes");
    });
  });

  describe("switching (§6.3, §1.2)", () => {
    it("switches via history.pushState, strips autoFocus, and never calls router navigation", async () => {
      renderPage({
        url: "/conversations?c=conv-1&autoFocus=true",
        active: activeData([
          sessionRow("conv-1", { name: "Alpha" }),
          sessionRow("conv-2", { name: "Beta" }),
        ]),
        lookups: [lookupItem("conv-1"), lookupItem("conv-2")],
      });
      pushStateSpy.mockClear();
      replaceStateSpy.mockClear();

      fireEvent.click(screen.getByLabelText("Beta — awaiting"));
      fireEvent.click(
        await screen.findByRole("button", { name: "Open conversation" }),
      );

      expect(pushStateSpy).toHaveBeenCalledTimes(1);
      expect(window.location.pathname).toBe("/conversations");
      expect(window.location.search).toBe("?c=conv-2");
      expect(routerPushMock).not.toHaveBeenCalled();
      expect(routerReplaceMock).not.toHaveBeenCalled();
      expect(replaceStateSpy).not.toHaveBeenCalled();
    });
  });

  describe("auto-open (§6.4)", () => {
    it("replaceStates to the most recent session-scoped conversation when c is absent", async () => {
      renderPage({
        url: "/conversations",
        active: activeData([
          sessionRow("conv-old", {
            name: "Old",
            lastActivityAt: "2026-06-01T00:00:00.000Z",
          }),
          sessionRow("conv-new", {
            name: "New",
            lastActivityAt: "2026-06-05T00:00:00.000Z",
          }),
        ]),
      });

      await waitFor(() => expect(window.location.search).toBe("?c=conv-new"));
      expect(replaceStateSpy).toHaveBeenCalled();
      expect(pushStateSpy).not.toHaveBeenCalled();
      expect(routerPushMock).not.toHaveBeenCalled();
      expect(routerReplaceMock).not.toHaveBeenCalled();
    });

    it("restricts auto-open to the rail session filter when one is active", async () => {
      useSessionDetailStore.getState().setSidebarSessionFilter({
        projectName: "repo",
        sessionName: "side-quest",
      });
      renderPage({
        url: "/conversations",
        active: activeData([
          sessionRow("conv-main", {
            name: "Main",
            lastActivityAt: "2026-06-09T00:00:00.000Z",
          }),
          sessionRow("conv-side", {
            name: "Side",
            sessionName: "side-quest",
            lastActivityAt: "2026-06-01T00:00:00.000Z",
          }),
        ]),
      });

      await waitFor(() => expect(window.location.search).toBe("?c=conv-side"));
    });

    it("shows the empty-state panel with the rail mounted when no candidate exists", () => {
      renderPage({ url: "/conversations", active: activeData([]) });

      expect(screen.getByText("Select a conversation")).toBeInTheDocument();
      expect(
        document.querySelector('[aria-label="Collapse sidebar"]'),
      ).not.toBeNull();
      expect(window.location.search).toBe("");
      expect(routerPushMock).not.toHaveBeenCalled();
      expect(routerReplaceMock).not.toHaveBeenCalled();
    });
  });

  describe("not-found and disappearance (§6.5)", () => {
    it("renders the not-found panel with the rail usable and stays on the bad URL", () => {
      renderPage({
        url: "/conversations?c=ghost",
        active: activeData([sessionRow("conv-1", { name: "Alpha" })]),
        notFoundIds: ["ghost"],
      });

      expect(screen.getByText("Conversation not found")).toBeInTheDocument();
      expect(
        document.querySelector('[aria-label="Collapse sidebar"]'),
      ).not.toBeNull();
      expect(window.location.search).toBe("?c=ghost");
      expect(routerPushMock).not.toHaveBeenCalled();
      expect(routerReplaceMock).not.toHaveBeenCalled();
    });

    it("clears c via replaceState when the open conversation disappears from the rail data", async () => {
      const queryClient = renderPage({
        url: "/conversations?c=conv-1",
        active: activeData([sessionRow("conv-1", { name: "Alpha" })]),
        lookups: [lookupItem("conv-1")],
      });
      pushStateSpy.mockClear();
      replaceStateSpy.mockClear();

      queryClient.setQueryData(conversationKeys.active(), activeData([]));

      await waitFor(() => expect(window.location.search).toBe(""));
      expect(window.location.pathname).toBe("/conversations");
      expect(replaceStateSpy).toHaveBeenCalled();
      expect(pushStateSpy).not.toHaveBeenCalled();
      expect(routerPushMock).not.toHaveBeenCalled();
    });

    it("does not clear a deep link that was never present in the rail data", async () => {
      renderPage({
        url: "/conversations?c=archived-1",
        active: activeData([sessionRow("conv-1", { name: "Alpha" })]),
        lookups: [lookupItem("archived-1")],
      });

      // Effects have run; an archived deep link must keep rendering.
      await waitFor(() => expect(window.location.search).toBe("?c=archived-1"));
      expect(routerPushMock).not.toHaveBeenCalled();
    });
  });

  describe("session-filter seeding (§6.6)", () => {
    it("seeds the rail session filter from project+session params and strips them, preserving c, autoFocus, and unknown params", async () => {
      renderPage({
        url: "/conversations?project=repo&session=side-quest&c=conv-1&autoFocus=true&debug=1",
        active: activeData([sessionRow("conv-1", { name: "Alpha" })]),
        lookups: [lookupItem("conv-1")],
      });

      await waitFor(() =>
        expect(window.location.search).toBe("?c=conv-1&autoFocus=true&debug=1"),
      );
      expect(useSessionDetailStore.getState().sidebarSessionFilter).toEqual({
        projectName: "repo",
        sessionName: "side-quest",
      });
      expect(replaceStateSpy).toHaveBeenCalled();
      expect(pushStateSpy).not.toHaveBeenCalled();
      expect(routerPushMock).not.toHaveBeenCalled();
      expect(routerReplaceMock).not.toHaveBeenCalled();
    });

    it("auto-opens from the seeded session when only filter params are present", async () => {
      renderPage({
        url: "/conversations?project=repo&session=side-quest",
        active: activeData([
          sessionRow("conv-main", {
            name: "Main",
            lastActivityAt: "2026-06-09T00:00:00.000Z",
          }),
          sessionRow("conv-side", {
            name: "Side",
            sessionName: "side-quest",
            lastActivityAt: "2026-06-01T00:00:00.000Z",
          }),
        ]),
      });

      await waitFor(() => expect(window.location.search).toBe("?c=conv-side"));
      expect(useSessionDetailStore.getState().sidebarSessionFilter).toEqual({
        projectName: "repo",
        sessionName: "side-quest",
      });
      expect(routerPushMock).not.toHaveBeenCalled();
      expect(routerReplaceMock).not.toHaveBeenCalled();
    });

    it("activates the rail's Session list filter so only the seeded session's rows show", async () => {
      renderPage({
        url: "/conversations?project=repo&session=side-quest",
        active: activeData([
          sessionRow("conv-main", {
            name: "Main",
            lastActivityAt: "2026-06-09T00:00:00.000Z",
          }),
          sessionRow("conv-side", {
            name: "Side",
            sessionName: "side-quest",
            lastActivityAt: "2026-06-01T00:00:00.000Z",
          }),
        ]),
      });

      await waitFor(() =>
        expect(screen.queryByLabelText("Main — awaiting")).toBeNull(),
      );
      expect(screen.getByLabelText("Side — awaiting")).toBeInTheDocument();
    });
  });
});
