// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, waitFor, render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderWithQuery } from "@/test/component-mocks";
import ProjectDetailView from "./ProjectDetailView";
import type { SessionListItem } from "@/lib/sessions/schemas";
import type { ConversationState } from "@/lib/conversations/schemas";
import { projectConversationKeys } from "@/lib/project-conversations-client/query-keys";
import { _useCockpitViewStore } from "./cockpit/use-cockpit-view-state";
// Shared mocks
vi.mock(
  "next/link",
  async () => (await import("@/test/component-mocks")).nextLinkMock,
);
vi.mock(
  "@/hooks/useVoiceRecorder",
  async () => (await import("@/test/component-mocks")).voiceRecorderMock,
);
vi.mock(
  "@/hooks/useAppHotkey",
  async () => (await import("@/test/component-mocks")).appHotkeyMock,
);
vi.mock(
  "@/components/VoiceRecordButton",
  async () => (await import("@/test/component-mocks")).voiceRecordButtonMock,
);

// File-specific mocks
const routerPushMock = vi.fn();
const routerReplaceMock = vi.fn();
const mockSearchParams = new URLSearchParams();
vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: routerPushMock,
    replace: routerReplaceMock,
  }),
  usePathname: vi.fn(() => "/projects/test-project"),
  useSearchParams: () => mockSearchParams,
}));

vi.mock(
  "@/components/agent-capabilities/ScopedAgentCapabilitiesConfig",
  () => ({
    __esModule: true,
    default: (props: Record<string, unknown>) => (
      <div
        data-testid="capabilities-drawer-stub"
        data-open={props.open ? "true" : "false"}
        data-level={String(props.level ?? "")}
        data-conversation-scope={String(props.conversationScope ?? "")}
        data-conversation-id={String(props.conversationId ?? "")}
        data-session-name={String(props.sessionName ?? "")}
        data-project-name={String(props.projectName ?? "")}
        data-prop-keys={Object.keys(props).sort().join("|")}
      />
    ),
  }),
);

const mockSessionsData = {
  data: undefined as SessionListItem[] | undefined,
  isPending: false,
};
vi.mock("@/lib/notifications/queries", () => ({
  useNotificationsQuery: () => ({ data: undefined }),
}));

vi.mock("@/lib/active-conversations/queries", () => ({
  useActiveConversationsQuery: () => ({ data: undefined }),
}));
vi.mock("@/lib/files/queries", () => ({
  useProjectFilesQuery: () => ({
    data: undefined,
    isLoading: false,
    error: null,
  }),
}));
vi.mock("@/lib/mcp/queries", () => ({
  useProjectMcpConfigQuery: () => ({
    data: undefined,
    isPending: true,
    isError: false,
    error: null,
  }),
}));
vi.mock("@/lib/sessions/queries", () => ({
  useSessionsQuery: () => mockSessionsData,
}));

vi.mock("@/stores/unified-panel.store", () => ({
  useUnifiedPanelOpen: () => false,
  useToggleUnifiedPanel: () => vi.fn(),
}));

const deleteMutateMock = vi.fn();
vi.mock("@/lib/mcp/mutations", () => ({
  useToggleMcpServerMutation: () => ({ mutate: vi.fn() }),
  useResetMcpServerMutation: () => ({ mutate: vi.fn() }),
  useToggleMcpToolMutation: () => ({ mutate: vi.fn() }),
  useResetMcpToolMutation: () => ({ mutate: vi.fn() }),
  useRefreshMcpToolsMutation: () => ({ mutate: vi.fn() }),
}));
vi.mock("@/lib/sessions/mutations", () => ({
  useCreateSessionMutation: () => ({ mutate: vi.fn(), isPending: false }),
  useDeleteSessionMutation: () => ({
    mutate: deleteMutateMock,
    isPending: false,
  }),
  useArchiveSessionMutation: () => ({ mutate: vi.fn(), isPending: false }),
  useGenericArchiveSessionMutation: () => ({
    mutate: vi.fn(),
    isPending: false,
  }),
  useTddToggleMutation: () => ({ mutate: vi.fn(), isPending: false }),
  useBulkSessionsMutation: () => ({ mutate: vi.fn(), isPending: false }),
}));

let storeShowCreateModal = false;
let storeDeleteTarget: { sessionName: string; projectName: string } | null =
  null;

vi.mock("@/stores/sessions.store", () => ({
  useShowCreateModal: () => storeShowCreateModal,
  useBranchFromParent: () => null,
  useDeleteTarget: () => storeDeleteTarget,
  useOpenCreateModal: () => () => {
    storeShowCreateModal = true;
  },
  useCloseCreateModal: () => vi.fn(),
  useConfirmDeleteSession:
    () => (target: { sessionName: string; projectName: string }) => {
      storeDeleteTarget = target;
    },
  useCancelDeleteSession: () => vi.fn(),
}));

beforeEach(() => {
  vi.clearAllMocks();
  storeShowCreateModal = false;
  storeDeleteTarget = null;
  mockSessionsData.data = undefined;
  mockSessionsData.isPending = false;
  mockSearchParams.delete("focus");
  _useCockpitViewStore.getState()._reset();
});

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------

const now = new Date().toISOString();

const makeSessions = (count: number): SessionListItem[] =>
  Array.from({ length: count }, (_, i) => ({
    sessionName: `session-${i + 1}`,
    worktreePath: `/project/.worktrees/session-${i + 1}`,
    branchName: `csm/session-${i + 1}`,
    createdAt: now,
    lastActivityAt: now,
    archived: false,
    finished: false,
    source: "cc" as const,
    objective: null,
    creationMode: "fast" as const,
    tddEnabled: true,
    targetBranch: "main",
    parentSessionName: null,
    derivedStatus: i === 0 ? ("running" as const) : ("awaiting" as const),
    promptCount: i * 3,
    derivedLastActivityAt: now,
    collabContribution: null,
    hasActiveGraphWorkflow: false,
  }));

const makeProjectConversation = (
  overrides: Partial<ConversationState> = {},
): ConversationState => ({
  id: "project-convo-1",
  scope: "project",
  name: "Project conversation",
  transcriptPath: null,
  status: "awaiting",
  promptCount: 0,
  createdAt: now,
  lastActivityAt: now,
  source: "cc",
  summary: null,
  archived: false,
  open: true,
  totalCostUsd: null,
  totalDurationMs: null,
  totalTurns: null,
  pendingQuestionId: null,
  pendingQuestions: null,
  pendingPromptText: null,
  unread: false,
  forkedFrom: null,
  role: null,
  activeTurnSource: null,
  contextTokens: null,
  contextWindowMax: null,
  debugMode: null,
  machineSnapshot: null,
  agentBackend: "claude",
  backendRef: null,
  ...overrides,
});

function renderProjectWithConversations(
  conversations: ConversationState[],
): QueryClient {
  mockSessionsData.data = [];
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  queryClient.setQueryData(
    projectConversationKeys.list("my-project"),
    conversations,
  );

  render(
    <QueryClientProvider client={queryClient}>
      <ProjectDetailView projectName="my-project" />
    </QueryClientProvider>,
  );

  return queryClient;
}

function stubProjectFetch(
  handler?: (url: string) => Response | Promise<Response>,
): ReturnType<typeof vi.fn<(input: RequestInfo | URL) => Promise<Response>>> {
  const fetchMock = vi.fn<(input: RequestInfo | URL) => Promise<Response>>(
    async (input) => {
      const url = input instanceof Request ? input.url : String(input);
      if (handler !== undefined) return handler(url);
      return new Response(null, { status: 404 });
    },
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

// ===========================================================================
// ProjectDetailView Tests
// ===========================================================================

describe("ProjectDetailView", () => {
  it("renders table with session rows (Req 2.1, 2.2)", () => {
    mockSessionsData.data = makeSessions(3);
    renderWithQuery(<ProjectDetailView projectName="my-project" />);
    expect(screen.getByText("session-1")).toBeInTheDocument();
    expect(screen.getByText("session-2")).toBeInTheDocument();
    expect(screen.getByText("session-3")).toBeInTheDocument();
  });

  it("renders empty state when no sessions (Req 2.5)", () => {
    mockSessionsData.data = [];
    renderWithQuery(<ProjectDetailView projectName="my-project" />);
    expect(screen.getByText("No sessions yet")).toBeInTheDocument();
    expect(
      screen.getByText("Create a session to start working in this project."),
    ).toBeInTheDocument();
  });

  it("renders branch names in table (Req 2.2)", () => {
    mockSessionsData.data = makeSessions(2);
    renderWithQuery(<ProjectDetailView projectName="my-project" />);
    expect(screen.getByText("csm/session-1")).toBeInTheDocument();
    expect(screen.getByText("csm/session-2")).toBeInTheDocument();
  });

  it("renders status badges (Req 2.3)", () => {
    mockSessionsData.data = makeSessions(2);
    const { container } = renderWithQuery(
      <ProjectDetailView projectName="my-project" />,
    );
    const badges = container.querySelectorAll(".s-status");
    expect(badges.length).toBe(2);
    expect(badges[0]!.textContent).toContain("running");
    expect(badges[1]!.textContent).toContain("awaiting");
  });

  it("renders prompt counts in table (Req 2.2)", () => {
    mockSessionsData.data = makeSessions(3);
    const { container } = renderWithQuery(
      <ProjectDetailView projectName="my-project" />,
    );
    const promptCells = container.querySelectorAll(".v3-prompts");
    const counts = Array.from(promptCells).map((c) => c.textContent);
    expect(counts).toEqual(["0", "3", "6"]);
  });

  it("links session name to detail page (Req 2.4)", () => {
    mockSessionsData.data = makeSessions(1);
    renderWithQuery(<ProjectDetailView projectName="my-project" />);
    const link = screen.getByText("session-1").closest("a");
    expect(link?.getAttribute("href")).toBe("/projects/my-project/session-1");
  });

  it("renders primary New session CTA in page header (Req 3.1)", () => {
    mockSessionsData.data = [];
    const { container } = renderWithQuery(
      <ProjectDetailView projectName="my-project" />,
    );
    const primary = container.querySelector(".cc-page-header .cc-primary");
    expect(primary).not.toBeNull();
    expect(primary?.textContent).toContain("New session");
  });

  it("renders the shared prompt composer in place of the legacy command console", async () => {
    mockSessionsData.data = [];
    const { container } = renderWithQuery(
      <ProjectDetailView projectName="my-project" />,
    );
    await waitFor(() =>
      expect(container.querySelector(".prompt-input-area")).not.toBeNull(),
    );
    expect(container.querySelector(".console-bar")).toBeNull();
    expect(screen.queryByLabelText("Project composer")).toBeNull();
  });

  it("renders table with all column headers (Req 2.1)", () => {
    mockSessionsData.data = makeSessions(1);
    renderWithQuery(<ProjectDetailView projectName="my-project" />);
    expect(
      screen.getByRole("button", { name: /^Session/ }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Branch/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Status/ })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /^Last Activity/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /^Prompts/ }),
    ).toBeInTheDocument();
  });

  it("shows loading state when pending", () => {
    mockSessionsData.isPending = true;
    renderWithQuery(<ProjectDetailView projectName="my-project" />);
    expect(screen.getByText("Loading sessions...")).toBeInTheDocument();
  });

  it("renders optimistic mode indicator for optimistic mode sessions", () => {
    mockSessionsData.data = [
      {
        ...makeSessions(1)[0]!,
        creationMode: "optimistic",
      },
    ];
    const { container } = renderWithQuery(
      <ProjectDetailView projectName="my-project" />,
    );
    const dot = container.querySelector('.s-mode-dot[data-mode="optimistic"]');
    expect(dot).not.toBeNull();
  });

  it("focuses an already-open project conversation from the focus query param (Req 12.1)", async () => {
    mockSearchParams.set("focus", "open-convo");
    const fetchMock = stubProjectFetch();

    renderProjectWithConversations([
      makeProjectConversation({
        id: "open-convo",
        name: "Open project focus",
        open: true,
      }),
    ]);

    await waitFor(() =>
      expect(_useCockpitViewStore.getState().activeTabId).toBe("open-convo"),
    );
    expect(fetchMock).not.toHaveBeenCalledWith(
      "/api/projects/my-project/conversations/open-convo/open",
      expect.objectContaining({ method: "PATCH" }),
    );
  });

  it("reopens and focuses a closed but unarchived project conversation from the focus query param (Req 12.2)", async () => {
    mockSearchParams.set("focus", "closed-convo");
    let reopened = false;
    const fetchMock = stubProjectFetch((url) => {
      if (url === "/api/projects/my-project/conversations/closed-convo/open") {
        reopened = true;
        return new Response(JSON.stringify({}), { status: 200 });
      }
      if (url === "/api/projects/my-project/conversations") {
        return new Response(
          JSON.stringify([
            makeProjectConversation({
              id: "closed-convo",
              name: "Closed project focus",
              open: reopened,
            }),
          ]),
          { status: 200 },
        );
      }
      return new Response(null, { status: 404 });
    });

    renderProjectWithConversations([
      makeProjectConversation({
        id: "closed-convo",
        name: "Closed project focus",
        open: false,
      }),
    ]);

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/projects/my-project/conversations/closed-convo/open",
        expect.objectContaining({
          method: "PATCH",
          body: JSON.stringify({ open: true }),
        }),
      ),
    );
    await waitFor(() =>
      expect(_useCockpitViewStore.getState().activeTabId).toBe("closed-convo"),
    );
  });

  it("shows an unavailable focus state without navigating to a session conversation route when the focused project conversation cannot be opened (Req 12.4)", async () => {
    mockSearchParams.set("focus", "missing-convo");
    stubProjectFetch((url) => {
      if (url === "/api/projects/my-project/conversations/missing-convo/open") {
        return new Response(JSON.stringify({ error: "Not found" }), {
          status: 404,
        });
      }
      return new Response(null, { status: 404 });
    });

    renderProjectWithConversations([]);

    expect(
      await screen.findByText("Project conversation unavailable"),
    ).toBeInTheDocument();
    expect(screen.getByText("missing-convo")).toBeInTheDocument();
    expect(_useCockpitViewStore.getState().activeTabId).not.toBe(
      "missing-convo",
    );
    expect(routerPushMock).not.toHaveBeenCalledWith(
      expect.stringMatching(/^\/projects\/my-project\/[^?]+\/missing-convo$/),
    );
  });
});

// ===========================================================================
// Project conversation capability drawer wiring (Req 18.1, 18.5, 20.3, 20.4)
// ===========================================================================

describe("ProjectDetailView — capability drawer PLC wiring", () => {
  it("targets the active PLC at the conversation layer (Req 18.1)", () => {
    _useCockpitViewStore.getState().focusTab("project-convo-1");

    renderProjectWithConversations([
      makeProjectConversation({ id: "project-convo-1" }),
    ]);

    const drawer = screen.getByTestId("capabilities-drawer-stub");
    expect(drawer).toHaveAttribute("data-level", "conversation");
    expect(drawer).toHaveAttribute("data-conversation-scope", "project");
    expect(drawer).toHaveAttribute("data-conversation-id", "project-convo-1");
    expect(drawer).toHaveAttribute("data-project-name", "my-project");
  });

  it("does not leak a conversationId when no PLC is active (Req 18.5)", () => {
    renderProjectWithConversations([]);

    const drawer = screen.getByTestId("capabilities-drawer-stub");
    expect(_useCockpitViewStore.getState().activeTabId).toBeNull();
    expect(drawer).toHaveAttribute("data-level", "conversation");
    expect(drawer).toHaveAttribute("data-conversation-scope", "project");
    expect(drawer).toHaveAttribute("data-conversation-id", "");
  });

  it("threads no backend-change control through the drawer (Req 20.3)", () => {
    _useCockpitViewStore.getState().focusTab("project-convo-1");

    renderProjectWithConversations([
      makeProjectConversation({ id: "project-convo-1" }),
    ]);

    const drawer = screen.getByTestId("capabilities-drawer-stub");
    const propKeys = (drawer.getAttribute("data-prop-keys") ?? "").split("|");
    expect(propKeys).not.toContain("agentBackend");
    expect(propKeys).not.toContain("selectedBackend");
    expect(propKeys).not.toContain("onSelectedBackendChange");
    expect(propKeys).not.toContain("onBackendChange");
  });
});
