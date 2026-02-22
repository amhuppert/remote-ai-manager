// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import SessionsList from "./SessionsList";
import type { SessionState } from "@/types";

// Mock next/link
vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    className,
  }: {
    href: string;
    children: React.ReactNode;
    className?: string;
  }) => (
    <a href={href} className={className}>
      {children}
    </a>
  ),
}));

// Mock next/navigation
const routerPushMock = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: routerPushMock,
  }),
}));

// Mock queries
const mockSessionsData = {
  data: undefined as SessionState[] | undefined,
  isPending: false,
};
const mockHooksData = {
  data: undefined as
    | { installed: boolean; hasUserPromptSubmit: boolean; hasStop: boolean }
    | undefined,
  isPending: false,
};

vi.mock("@/lib/queries", () => ({
  useSessionsQuery: () => mockSessionsData,
  useHooksStatusQuery: () => mockHooksData,
  useActiveConversationsQuery: () => ({ data: undefined }),
}));

// Mock unified panel store
vi.mock("@/stores/unified-panel.store", () => ({
  useUnifiedPanelOpen: () => false,
  useToggleUnifiedPanel: () => vi.fn(),
}));

// Mock mutations
const deleteMutateMock = vi.fn();
vi.mock("@/lib/mutations", () => ({
  useCreateSessionMutation: () => ({ mutate: vi.fn(), isPending: false }),
  useDeleteSessionMutation: () => ({
    mutate: deleteMutateMock,
    isPending: false,
  }),
  useArchiveSessionMutation: () => ({ mutate: vi.fn(), isPending: false }),
}));

// Mock sessions store
let storeShowCreateModal = false;
let storeDeleteTarget: { sessionName: string; projectName: string } | null =
  null;
let storeShowArchived = false;

vi.mock("@/stores/sessions.store", () => ({
  useShowCreateModal: () => storeShowCreateModal,
  useDeleteTarget: () => storeDeleteTarget,
  useShowArchivedSessions: () => storeShowArchived,
  useOpenCreateModal: () => () => {
    storeShowCreateModal = true;
  },
  useCloseCreateModal: () => vi.fn(),
  useConfirmDeleteSession:
    () => (target: { sessionName: string; projectName: string }) => {
      storeDeleteTarget = target;
    },
  useCancelDeleteSession: () => vi.fn(),
  useToggleArchivedSessions: () => vi.fn(),
}));

beforeEach(() => {
  vi.clearAllMocks();
  storeShowCreateModal = false;
  storeDeleteTarget = null;
  storeShowArchived = false;
  mockSessionsData.data = undefined;
  mockSessionsData.isPending = false;
  mockHooksData.data = undefined;
  mockHooksData.isPending = false;
});

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------

const now = new Date().toISOString();

const makeSessions = (count: number): SessionState[] =>
  Array.from({ length: count }, (_, i) => ({
    sessionName: `session-${i + 1}`,
    worktreePath: `/project/.worktrees/session-${i + 1}`,
    branchName: `csm/session-${i + 1}`,
    createdAt: now,
    lastActivityAt: now,
    archived: false,
    finished: false,
    conversations: [
      {
        id: `conv-${i + 1}`,
        name: null,
        claudeSessionId: null,
        transcriptPath: null,
        status: i === 0 ? ("running" as const) : ("awaiting" as const),
        promptCount: i * 3,
        createdAt: now,
        lastActivityAt: now,
        source: "csm" as const,
        summary: null,
        archived: false,
      },
    ],
    source: "csm" as const,
    containerId: null,
    containerStatus: "none" as const,
    containerError: null,
    claudeHostDir: null,
  }));

function renderWithQuery(ui: React.ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>,
  );
}

// ===========================================================================
// SessionsList Tests
// ===========================================================================

describe("SessionsList", () => {
  it("renders table with session rows (Req 2.1, 2.2)", () => {
    mockSessionsData.data = makeSessions(3);
    renderWithQuery(<SessionsList projectName="my-project" />);
    expect(screen.getByText("session-1")).toBeDefined();
    expect(screen.getByText("session-2")).toBeDefined();
    expect(screen.getByText("session-3")).toBeDefined();
  });

  it("renders empty state when no sessions (Req 2.5)", () => {
    mockSessionsData.data = [];
    renderWithQuery(<SessionsList projectName="my-project" />);
    expect(screen.getByText("No sessions yet")).toBeDefined();
    expect(
      screen.getByText(
        "Create a session to start working with Claude in this project.",
      ),
    ).toBeDefined();
  });

  it("renders branch names in table (Req 2.2)", () => {
    mockSessionsData.data = makeSessions(2);
    renderWithQuery(<SessionsList projectName="my-project" />);
    expect(screen.getByText("csm/session-1")).toBeDefined();
    expect(screen.getByText("csm/session-2")).toBeDefined();
  });

  it("renders status badges (Req 2.3)", () => {
    mockSessionsData.data = makeSessions(2);
    const { container } = renderWithQuery(
      <SessionsList projectName="my-project" />,
    );
    const badges = container.querySelectorAll(".session-status");
    expect(badges.length).toBe(2);
    expect(badges[0]!.textContent).toContain("running");
    expect(badges[1]!.textContent).toContain("awaiting");
  });

  it("renders prompt counts in table (Req 2.2)", () => {
    mockSessionsData.data = makeSessions(3);
    renderWithQuery(<SessionsList projectName="my-project" />);
    expect(screen.getByText("0")).toBeDefined();
    expect(screen.getByText("3")).toBeDefined();
    expect(screen.getByText("6")).toBeDefined();
  });

  it("links session name to detail page (Req 2.4)", () => {
    mockSessionsData.data = makeSessions(1);
    renderWithQuery(<SessionsList projectName="my-project" />);
    const link = screen.getByText("session-1").closest("a");
    expect(link?.getAttribute("href")).toBe("/projects/my-project/session-1");
  });

  it("renders New Session button (Req 3.1)", () => {
    mockSessionsData.data = [];
    renderWithQuery(<SessionsList projectName="my-project" />);
    expect(screen.getByText("New Session")).toBeDefined();
  });

  it("renders table with all column headers (Req 2.1)", () => {
    mockSessionsData.data = makeSessions(1);
    renderWithQuery(<SessionsList projectName="my-project" />);
    expect(screen.getByText("Session")).toBeDefined();
    expect(screen.getByText("Branch")).toBeDefined();
    expect(screen.getByText("Status")).toBeDefined();
    expect(screen.getByText("Last Activity")).toBeDefined();
    expect(screen.getByText("Prompts")).toBeDefined();
  });

  it("shows loading state when pending", () => {
    mockSessionsData.isPending = true;
    renderWithQuery(<SessionsList projectName="my-project" />);
    expect(screen.getByText("Loading sessions...")).toBeDefined();
  });
});
