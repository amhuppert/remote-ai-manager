// @vitest-environment jsdom
import { beforeEach, describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import Topbar from "./Topbar";
import type {
  ActiveConversation,
  ActiveConversationsResponse,
} from "@/lib/active-conversations/schemas";

const queryMockState = vi.hoisted(() => ({
  activeConversationsData: undefined as ActiveConversationsResponse | undefined,
}));

// Shared mocks
vi.mock(
  "next/link",
  async () => (await import("@/test/component-mocks")).nextLinkMock,
);

// File-specific mocks
vi.mock("@/stores/unified-panel.store", () => ({
  useUnifiedPanelOpen: () => false,
  useToggleUnifiedPanel: () => vi.fn(),
}));

vi.mock("@/lib/active-conversations/queries", () => ({
  useActiveConversationsQuery: () => ({
    data: queryMockState.activeConversationsData,
  }),
}));

vi.mock("@/lib/notifications/queries", () => ({
  useNotificationsQuery: () => ({ data: undefined }),
}));

function makeSessionConversation(
  overrides: Partial<Extract<ActiveConversation, { scope: "session" }>> = {},
): Extract<ActiveConversation, { scope: "session" }> {
  return {
    scope: "session",
    id: "session-convo-1",
    name: "Session conversation",
    status: "waiting_for_input",
    lastActivityAt: "2026-01-01T00:00:00.000Z",
    projectName: "project-a",
    projectPath: "/repos/project-a",
    sessionName: "session-a",
    branchName: "csm/session-a",
    agentBackend: "claude",
    summary: null,
    pendingQuestion: null,
    pendingQuestionId: null,
    pendingQuestions: null,
    forkedFrom: null,
    debugActive: false,
    role: null,
    worktreePath: "/repos/project-a/.worktrees/session-a",
    lastActivitySummary: null,
    unread: false,
    pendingApproval: null,
    ...overrides,
  };
}

function makeProjectConversation(
  overrides: Partial<Extract<ActiveConversation, { scope: "project" }>> = {},
): Extract<ActiveConversation, { scope: "project" }> {
  return {
    scope: "project",
    id: "project-convo-1",
    name: "Project conversation",
    status: "waiting_for_input",
    lastActivityAt: "2026-01-01T00:00:00.000Z",
    projectName: "project-a",
    projectPath: "/repos/project-a",
    agentBackend: "claude",
    summary: null,
    pendingQuestion: null,
    pendingQuestionId: null,
    pendingQuestions: null,
    forkedFrom: null,
    debugActive: false,
    role: null,
    worktreePath: "/repos/project-a",
    lastActivitySummary: null,
    unread: false,
    pendingApproval: null,
    open: overrides.open ?? true,
    ...overrides,
  };
}

function setActiveConversations(conversations: ActiveConversation[]): void {
  queryMockState.activeConversationsData = {
    conversations,
    graphWorkflowExecutions: [],
    activeCollaborationExecutions: [],
  };
}

function getNeedsLink(): HTMLAnchorElement {
  const needsLabel = screen.getByText(/needs? you/);
  const link = needsLabel.closest("a");
  expect(link).not.toBeNull();
  return link as HTMLAnchorElement;
}

describe("Topbar", () => {
  beforeEach(() => {
    queryMockState.activeConversationsData = undefined;
  });

  // =========================================================================
  // 6.2 – Topbar (Req 5.1–5.5)
  // =========================================================================

  it("renders CC logo linking to /projects (Req 5.1)", () => {
    render(<Topbar breadcrumbs={[]} page="projects" />);
    const logo = screen.getByText("CC");
    expect(logo.closest("a")?.getAttribute("href")).toBe("/projects");
  });

  it("renders breadcrumb segments with correct labels and links (Req 5.2, 5.3)", () => {
    render(
      <Topbar
        breadcrumbs={[
          { label: "projects", href: "/projects" },
          { label: "my-repo", href: "/projects/my-repo" },
          {
            label: "test-session",
            href: "/projects/my-repo/test-session",
            isSession: true,
          },
        ]}
        page="detail"
      />,
    );
    const links = screen.getAllByRole("link");
    // CC logo + 3 breadcrumb links
    expect(links.length).toBeGreaterThanOrEqual(4);
    expect(screen.getByText("projects")).toBeInTheDocument();
    expect(screen.getByText("my-repo")).toBeInTheDocument();
    expect(screen.getByText("test-session")).toBeInTheDocument();
  });

  it("renders session controls on detail page (Req 5.4)", () => {
    render(
      <Topbar
        breadcrumbs={[]}
        page="detail"
        sessionControls={<button>Delete</button>}
      />,
    );
    expect(screen.getByText("Delete")).toBeInTheDocument();
  });

  it("renders global status on non-detail pages (Req 5.5)", () => {
    render(
      <Topbar
        breadcrumbs={[]}
        page="projects"
        globalStatus={<span>3 active</span>}
      />,
    );
    expect(screen.getByText("3 active")).toBeInTheDocument();
  });

  it("does not render global status on detail page", () => {
    const { container } = render(
      <Topbar
        breadcrumbs={[]}
        page="detail"
        globalStatus={<span>3 active</span>}
      />,
    );
    const statusDefault = container.querySelector(".topbar-status-default");
    expect(statusDefault).toBeNull();
  });

  it("renders unified panel toggle button", () => {
    render(<Topbar breadcrumbs={[]} page="projects" />);
    expect(screen.getByTitle("Activity & Notifications")).toBeInTheDocument();
  });

  it("counts project waiting_for_input rows and links to the project focus URL (Req 11.2, 12.1, 12.3)", () => {
    setActiveConversations([
      makeProjectConversation({
        id: "project-question",
        projectName: "root-tools",
        status: "waiting_for_input",
      }),
    ]);

    render(<Topbar breadcrumbs={[]} page="projects" />);

    expect(screen.getByText("1")).toBeInTheDocument();
    expect(getNeedsLink().getAttribute("href")).toBe(
      "/projects/root-tools?focus=project-question",
    );
  });

  it("counts unread project awaiting rows as needing attention (Req 11.2, 11.3)", () => {
    setActiveConversations([
      makeProjectConversation({
        id: "project-unread",
        projectName: "root-tools",
        status: "awaiting",
        unread: true,
      }),
    ]);

    render(<Topbar breadcrumbs={[]} page="projects" />);

    expect(screen.getByText("1")).toBeInTheDocument();
    expect(getNeedsLink().getAttribute("href")).toBe(
      "/projects/root-tools?focus=project-unread",
    );
  });

  it("targets the conversations page when the first attention target is a session row (Req 11.2, 12.4)", () => {
    setActiveConversations([
      makeSessionConversation({
        id: "session-question",
        projectName: "root-tools",
        sessionName: "feature-a",
        status: "waiting_for_input",
      }),
      makeProjectConversation({
        id: "project-question",
        projectName: "root-tools",
        status: "waiting_for_input",
      }),
    ]);

    render(<Topbar breadcrumbs={[]} page="projects" />);

    expect(screen.getByText("2")).toBeInTheDocument();
    expect(getNeedsLink().getAttribute("href")).toBe(
      "/conversations?c=session-question",
    );
  });

  it("counts gated conversations as needing attention and calls out approvals distinctly", () => {
    setActiveConversations([
      makeSessionConversation({
        id: "session-gated",
        projectName: "root-tools",
        sessionName: "feature-a",
        status: "awaiting",
        pendingApproval: {
          contextId: "ctx-1",
          contextTitle: "api-hardening",
          requestedAt: "2026-06-10T09:00:00.000Z",
          workflowName: null,
          executionSuspended: false,
          tasksCompleted: 6,
          tasksTotal: 6,
        },
      }),
      makeSessionConversation({
        id: "session-question",
        projectName: "root-tools",
        sessionName: "feature-b",
        status: "waiting_for_input",
      }),
    ]);

    render(<Topbar breadcrumbs={[]} page="projects" />);

    expect(screen.getByText("2")).toBeInTheDocument();
    expect(screen.getByText("need you")).toBeInTheDocument();
    expect(screen.getByText("· 1 approval")).toBeInTheDocument();
  });
});
