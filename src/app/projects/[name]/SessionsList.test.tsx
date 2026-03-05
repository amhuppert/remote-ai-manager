// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen } from "@testing-library/react";
import { renderWithQuery } from "@/test/component-mocks";
import SessionsList from "./SessionsList";
import type { SessionState } from "@/types";

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
vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: routerPushMock,
  }),
}));

const mockSessionsData = {
  data: undefined as SessionState[] | undefined,
  isPending: false,
};
vi.mock("@/lib/queries", () => ({
  useSessionsQuery: () => mockSessionsData,
  usePresetsQuery: () => ({ data: undefined }),
  useActiveConversationsQuery: () => ({ data: undefined }),
  useNotificationsQuery: () => ({ data: undefined }),
  useProjectFilesQuery: () => ({
    data: undefined,
    isLoading: false,
    error: null,
  }),
  useRoadmapItemsQuery: () => ({ data: [] }),
}));

vi.mock("@/stores/roadmap-items.store", () => ({
  useShowArchivedRoadmapItems: () => false,
  useToggleArchivedRoadmapItems: () => vi.fn(),
}));

vi.mock("@/stores/unified-panel.store", () => ({
  useUnifiedPanelOpen: () => false,
  useToggleUnifiedPanel: () => vi.fn(),
}));

const deleteMutateMock = vi.fn();
vi.mock("@/lib/mutations", () => ({
  useCreateSessionMutation: () => ({ mutate: vi.fn(), isPending: false }),
  useDeleteSessionMutation: () => ({
    mutate: deleteMutateMock,
    isPending: false,
  }),
  useArchiveSessionMutation: () => ({ mutate: vi.fn(), isPending: false }),
  useInstallPresetMutation: () => ({ mutate: vi.fn(), isPending: false }),
  useCreateRoadmapItemMutation: () => ({ mutate: vi.fn(), isPending: false }),
  useUpdateRoadmapItemMutation: () => ({ mutate: vi.fn(), isPending: false }),
  useDeleteRoadmapItemMutation: () => ({ mutate: vi.fn(), isPending: false }),
  useStartRoadmapFocusMutation: () => ({ mutate: vi.fn(), isPending: false }),
}));

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
        source: "cc" as const,
        summary: null,
        archived: false,
        totalCostUsd: null,
        totalDurationMs: null,
        totalTurns: null,
        pendingQuestionId: null,
        pendingQuestions: null,
        forkedFrom: null,
        role: null,
      },
    ],
    source: "cc" as const,
    objective: null,
    creationMode: "fast" as const,
    workflow: null,
  }));

// ===========================================================================
// SessionsList Tests
// ===========================================================================

describe("SessionsList", () => {
  it("renders table with session rows (Req 2.1, 2.2)", () => {
    mockSessionsData.data = makeSessions(3);
    renderWithQuery(<SessionsList projectName="my-project" />);
    expect(screen.getByText("session-1")).toBeInTheDocument();
    expect(screen.getByText("session-2")).toBeInTheDocument();
    expect(screen.getByText("session-3")).toBeInTheDocument();
  });

  it("renders empty state when no sessions (Req 2.5)", () => {
    mockSessionsData.data = [];
    renderWithQuery(<SessionsList projectName="my-project" />);
    expect(screen.getByText("No sessions yet")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Create a session to start working with Claude in this project.",
      ),
    ).toBeInTheDocument();
  });

  it("renders branch names in table (Req 2.2)", () => {
    mockSessionsData.data = makeSessions(2);
    renderWithQuery(<SessionsList projectName="my-project" />);
    expect(screen.getByText("csm/session-1")).toBeInTheDocument();
    expect(screen.getByText("csm/session-2")).toBeInTheDocument();
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
    expect(screen.getByText("0")).toBeInTheDocument();
    expect(screen.getByText("3")).toBeInTheDocument();
    expect(screen.getByText("6")).toBeInTheDocument();
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
    expect(screen.getByText("New Session")).toBeInTheDocument();
  });

  it("renders table with all column headers (Req 2.1)", () => {
    mockSessionsData.data = makeSessions(1);
    renderWithQuery(<SessionsList projectName="my-project" />);
    expect(screen.getByText("Session")).toBeInTheDocument();
    expect(screen.getByText("Branch")).toBeInTheDocument();
    expect(screen.getByText("Status")).toBeInTheDocument();
    expect(screen.getByText("Last Activity")).toBeInTheDocument();
    expect(screen.getByText("Prompts")).toBeInTheDocument();
  });

  it("shows loading state when pending", () => {
    mockSessionsData.isPending = true;
    renderWithQuery(<SessionsList projectName="my-project" />);
    expect(screen.getByText("Loading sessions...")).toBeInTheDocument();
  });

  it("renders optimistic badge for optimistic mode sessions", () => {
    mockSessionsData.data = [
      {
        ...makeSessions(1)[0]!,
        creationMode: "optimistic",
      },
    ];
    const { container } = renderWithQuery(
      <SessionsList projectName="my-project" />,
    );
    const badge = container.querySelector(".session-badge.optimistic");
    expect(badge).not.toBeNull();
    expect(badge?.textContent?.trim()).toBe("optimistic");
  });

  it("renders Quick Task button for standalone optimistic dialog", () => {
    mockSessionsData.data = [];
    renderWithQuery(<SessionsList projectName="my-project" />);
    expect(screen.getByText("Quick Task")).toBeInTheDocument();
  });
});
