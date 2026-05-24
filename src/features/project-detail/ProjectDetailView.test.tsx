// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen } from "@testing-library/react";
import { renderWithQuery } from "@/test/component-mocks";
import ProjectDetailView from "./ProjectDetailView";
import type { SessionListItem } from "@/lib/sessions/schemas";
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
    default: ({ open }: { open?: boolean }) =>
      open ? <div data-testid="capabilities-drawer-stub" /> : null,
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
vi.mock("@/lib/dev-server/queries", () => ({
  usePresetsQuery: () => ({ data: undefined }),
}));
vi.mock("@/lib/dev-server/mutations", () => ({
  useInstallPresetMutation: () => ({ mutate: vi.fn(), isPending: false }),
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
      screen.getByText(
        "Create a session to start working with Claude in this project.",
      ),
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

  it("renders command console", () => {
    mockSessionsData.data = [];
    const { container } = renderWithQuery(
      <ProjectDetailView projectName="my-project" />,
    );
    expect(container.querySelector(".v2-console")).not.toBeNull();
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
});
