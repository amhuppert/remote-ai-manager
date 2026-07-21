// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { createTestQueryClient, renderWithQuery } from "@/test/component-mocks";
import {
  installFetchFixture,
  type FetchFixture,
  type RouteReply,
} from "@/test/fetch-fixture";
import ProjectDetailView from "./ProjectDetailView";
import type { SessionListItem } from "@/lib/sessions/schemas";
import type { ConversationState } from "@/lib/conversations/schemas";
import type { TicketListItem } from "@/lib/tickets/schemas";
import { projectConversationKeys } from "@/lib/project-conversations-client/query-keys";
import { sessionKeys } from "@/lib/sessions/query-keys";
import { _useCockpitViewStore } from "./cockpit/use-cockpit-view-state";
import type { BackendSelectionDefaultsById } from "@/lib/agent-backends/conversation-policy";

const BACKEND_DEFAULTS: BackendSelectionDefaultsById = {
  claude: { modelId: "opus", effort: "high" },
  codex: { modelId: "gpt-5.4", effort: "high" },
};

function projectDetailView(): React.JSX.Element {
  return (
    <ProjectDetailView
      projectName="my-project"
      defaultAgentBackend="claude"
      backendDefaults={BACKEND_DEFAULTS}
    />
  );
}

// These are external framework/browser-integration modules, not internal seams:
// next routing and the browser voice/hotkey hooks. The sanctioned client-test
// pattern (@/test/fetch-fixture) covers only the network boundary, so these keep
// their component-mock stubs. Queries, mutations, and Zustand stores run for
// real against the fetch fixture and the real stores.
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

// The capability drawer is a deep child rendered here only to assert the props
// this view threads into it; substituting a prop-echoing stub isolates that
// wiring contract without pulling the drawer's own data dependencies. This is a
// component-boundary double, not a network mock.
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

let api: FetchFixture;

/** Serve the project's session list; unless a test seeds sessions the list is
 * empty. Every other endpoint the view or its topbar may touch is held quiet. */
function seedSessions(sessions: SessionListItem[]): void {
  api.json("GET", "/api/projects/my-project/sessions", { sessions });
}

beforeEach(() => {
  api = installFetchFixture();
  seedSessions([]);
  api.json("GET", "/api/notifications", {
    notifications: [],
    total: 0,
    unreadCount: 0,
  });
  api.json("GET", "/api/conversations/active", { conversations: [] });
  api.json("GET", "/api/projects/my-project/branch-prefix", {
    branchPrefix: "csm/",
  });
  // Files + MCP panels mount lazily; hold them in perpetual loading so a lazy
  // fetch never rejects as an unmatched route.
  api.pending("GET", "/api/projects/my-project/files");
  api.pending("GET", "/api/projects/my-project/mcp-config");

  mockSearchParams.delete("focus");
  _useCockpitViewStore.getState()._reset();
});

afterEach(() => {
  api.restore();
  vi.clearAllMocks();
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
    creationMode: "normal" as const,
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
  pendingQueue: [],
  forkedFrom: null,
  role: null,
  activeTurnSource: null,
  contextTokens: null,
  contextWindowMax: null,
  debugMode: null,
  agentBackend: "claude",
  backendRef: null,
  lastSeenAlignmentVersion: null,
  pendingAgentNotices: [],
  ...overrides,
});

/** Render the view with the project-conversation list pre-seeded in cache (the
 * PLC list query then reads the cache instead of the network). */
function renderProjectWithConversations(
  conversations: ConversationState[],
): void {
  const queryClient = createTestQueryClient();
  // Seed both caches so the view renders past its "Loading sessions..." branch
  // synchronously — these tests assert on the PLC drawer, not the fetch path.
  queryClient.setQueryData(sessionKeys.list("my-project"), []);
  queryClient.setQueryData(
    projectConversationKeys.list("my-project"),
    conversations,
  );

  renderWithQuery(projectDetailView(), queryClient);
}

// ===========================================================================
// ProjectDetailView Tests
// ===========================================================================

describe("ProjectDetailView", () => {
  it("renders complete session rows and their independent destinations", async () => {
    const sessions = makeSessions(3);
    sessions[0] = { ...sessions[0]!, creationMode: "optimistic" };
    seedSessions(sessions);
    renderWithQuery(projectDetailView());

    const titleLink = (await screen.findByText("session-1")).closest("a");
    expect(titleLink?.getAttribute("href")).toBe(
      "/projects/my-project/session-1",
    );
    expect(screen.getByText("session-2")).toBeInTheDocument();
    expect(screen.getByText("session-3")).toBeInTheDocument();
    expect(screen.getByText("csm/session-1")).toBeInTheDocument();
    expect(screen.getByText("csm/session-2")).toBeInTheDocument();
    expect(screen.getByText("running")).toBeInTheDocument();
    expect(screen.getAllByText("awaiting")).toHaveLength(2);

    const quickLink = screen.getAllByLabelText("Open in Conversations")[0]!;
    expect(quickLink.getAttribute("href")).toBe(
      "/conversations?project=my-project&session=session-1",
    );
    expect(quickLink).toHaveAttribute("data-state");
    expect(quickLink).not.toBe(titleLink);
    expect(titleLink!.contains(quickLink)).toBe(false);
    expect(quickLink.contains(titleLink!)).toBe(false);
    fireEvent.click(quickLink);
    expect(routerPushMock).not.toHaveBeenCalled();

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
    expect(screen.getByTitle("Optimistic session")).toBeInTheDocument();
  });

  it("renders empty state when no sessions (Req 2.5)", async () => {
    seedSessions([]);
    renderWithQuery(projectDetailView());
    expect(await screen.findByText("No sessions yet")).toBeInTheDocument();
    expect(
      screen.getByText("Create a session to start working in this project."),
    ).toBeInTheDocument();
  });

  it("renders the project header as a compact single-row summary", async () => {
    seedSessions(makeSessions(2));
    renderWithQuery(projectDetailView());

    const summary = await screen.findByLabelText("Project summary");
    expect(summary.textContent).toContain("my-project");
    expect(summary.textContent).toContain("2 sessions");
    expect(summary.textContent).toContain("0 archived");
    expect(
      screen.getByRole("button", { name: /New session/ }),
    ).toBeInTheDocument();
    expect(screen.getByTitle("Open the Workflow Builder")).toBeInTheDocument();
  });

  it("renders a Tickets entry opening /tickets pre-filtered to the project (ticket-system Req 9.5)", async () => {
    seedSessions(makeSessions(1));
    const makeTicket = (
      number: number,
      status: TicketListItem["status"],
    ): TicketListItem => ({
      id: `ticket-${number}`,
      projectPath: "/repos/my-project",
      projectName: "my-project",
      number,
      title: `Ticket ${number}`,
      workType: "feature",
      status,
      attachmentCount: 0,
      activeSessionName: null,
      createdAt: now,
      updatedAt: now,
    });
    api.json("GET", "/api/projects/my-project/tickets", [
      makeTicket(1, "not_started"),
      makeTicket(2, "in_progress"),
      makeTicket(3, "done"),
    ]);
    renderWithQuery(projectDetailView());

    const link = await screen.findByTitle("Tickets for this project");
    expect(link.getAttribute("href")).toBe("/tickets?project=my-project");
    expect(link).toHaveTextContent("Tickets");
    // Badge counts open tickets only (done/closed excluded).
    await waitFor(() =>
      expect(within(link as HTMLElement).getByText("2")).toBeInTheDocument(),
    );
  });

  it("renders the shared prompt composer in place of the legacy command console", async () => {
    seedSessions([]);
    const { container } = renderWithQuery(projectDetailView());
    const viewTabs = await screen.findByRole("tablist", {
      name: "Project view",
    });
    fireEvent.click(
      within(viewTabs).getByRole("tab", { name: /Conversations/ }),
    );
    await waitFor(() =>
      expect(container.querySelector(".prompt-input-area")).not.toBeNull(),
    );
    expect(screen.queryByLabelText("Project composer")).toBeNull();
  });

  it("shows loading state when pending", () => {
    // Hold the session list unresolved so the loading branch renders.
    api.pending("GET", "/api/projects/my-project/sessions");
    renderWithQuery(projectDetailView());
    expect(screen.getByText("Loading sessions...")).toBeInTheDocument();
  });

  it("focuses an already-open project conversation from the focus query param (Req 12.1)", async () => {
    mockSearchParams.set("focus", "open-convo");

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
    // An already-open conversation is not re-opened over the wire (the reopen
    // mutation PATCHes .../open).
    expect(
      api.requestsTo(
        "PATCH",
        "/api/projects/my-project/conversations/open-convo/open",
      ),
    ).toHaveLength(0);
  });

  it("reopens and focuses a closed but unarchived project conversation from the focus query param (Req 12.2)", async () => {
    mockSearchParams.set("focus", "closed-convo");
    let reopened = false;
    api.reply(
      "PATCH",
      "/api/projects/my-project/conversations/closed-convo/open",
      (): RouteReply => {
        reopened = true;
        return { json: {} };
      },
    );
    api.reply(
      "GET",
      "/api/projects/my-project/conversations",
      (): RouteReply => ({
        json: [
          makeProjectConversation({
            id: "closed-convo",
            name: "Closed project focus",
            open: reopened,
          }),
        ],
      }),
    );

    renderProjectWithConversations([
      makeProjectConversation({
        id: "closed-convo",
        name: "Closed project focus",
        open: false,
      }),
    ]);

    await waitFor(() => {
      const opens = api.requestsTo(
        "PATCH",
        "/api/projects/my-project/conversations/closed-convo/open",
      );
      expect(opens).toHaveLength(1);
      expect(opens[0]?.jsonBody).toEqual({ open: true });
    });
    await waitFor(() =>
      expect(_useCockpitViewStore.getState().activeTabId).toBe("closed-convo"),
    );
  });

  it("shows an unavailable focus state without navigating to a session conversation route when the focused project conversation cannot be opened (Req 12.4)", async () => {
    mockSearchParams.set("focus", "missing-convo");
    api.reply(
      "PATCH",
      "/api/projects/my-project/conversations/missing-convo/open",
      (): RouteReply => ({ status: 404, json: { error: "Not found" } }),
    );

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
