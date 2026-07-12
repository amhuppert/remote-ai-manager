// @vitest-environment jsdom
import { act } from "react";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { beforeEach, describe, it, expect, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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
vi.mock("@/lib/active-conversations/queries", () => ({
  useActiveConversationsQuery: () => ({
    data: queryMockState.activeConversationsData,
  }),
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
    render(
      <Topbar
        breadcrumbs={[]}
        page="detail"
        globalStatus={<span>3 active</span>}
      />,
    );
    expect(screen.queryByText("3 active")).toBeNull();
  });

  it("renders a global Tickets destination linking to /tickets (ticket-system Req 9.1)", () => {
    render(<Topbar breadcrumbs={[]} page="projects" />);
    const link = screen.getByTitle("Tickets");
    expect(link.getAttribute("href")).toBe("/tickets");
    expect(link).toHaveTextContent("Tickets");
  });

  it("keeps every global destination reachable without overflowing a 320px topbar", async () => {
    render(<Topbar breadcrumbs={[{ label: "tickets" }]} page="tickets" />);
    const user = userEvent.setup();

    expect(screen.getByTitle("Workflow Atlas")).toHaveClass("max-768:hidden");
    expect(screen.getByTitle("Global Workflow Templates")).toHaveClass(
      "max-768:hidden",
    );
    expect(screen.getByTitle("System Configuration")).toHaveClass(
      "max-768:hidden",
    );

    const more = screen.getByRole("button", { name: "More destinations" });
    expect(more).toHaveClass("max-768:flex");
    await user.click(more);

    expect(
      screen.getByRole("menuitem", { name: "Workflow Atlas" }),
    ).toHaveAttribute("href", "/workflows");
    expect(
      screen.getByRole("menuitem", { name: "Workflow Templates" }),
    ).toHaveAttribute("href", "/templates");
    expect(
      screen.getByRole("menuitem", { name: "System Configuration" }),
    ).toHaveAttribute("href", "/config");

    expect(screen.getByRole("navigation")).toHaveClass("max-[360px]:hidden");
  });

  it("hydrates when attention data reaches the client before the server markup", async () => {
    const container = document.createElement("div");
    container.innerHTML = renderToString(
      <Topbar breadcrumbs={[]} page="tickets" />,
    );
    document.body.append(container);

    setActiveConversations([
      makeProjectConversation({
        id: "client-cached-question",
        status: "waiting_for_input",
      }),
    ]);
    const hydrationErrors: unknown[][] = [];
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation((...args: unknown[]) => hydrationErrors.push(args));

    const root = hydrateRoot(
      container,
      <Topbar breadcrumbs={[]} page="tickets" />,
    );
    await waitFor(() =>
      expect(within(container).getByText("needs you")).toBeInTheDocument(),
    );

    expect(
      hydrationErrors.some((args) =>
        args.some(
          (value) =>
            typeof value === "string" &&
            value.toLowerCase().includes("hydration"),
        ),
      ),
    ).toBe(false);

    await act(async () => root.unmount());
    consoleError.mockRestore();
    container.remove();
  });

  it("hydrates without replacing the tree when attention data is already cached on the client", async () => {
    const serverHtml = renderToString(
      <Topbar breadcrumbs={[]} page="projects" />,
    );
    setActiveConversations([
      makeProjectConversation({
        id: "project-unread",
        projectName: "root-tools",
        status: "awaiting",
        unread: true,
      }),
    ]);

    const container = document.createElement("div");
    container.innerHTML = serverHtml;
    document.body.append(container);
    const recoverableErrors: Error[] = [];

    const root = hydrateRoot(
      container,
      <Topbar breadcrumbs={[]} page="projects" />,
      {
        onRecoverableError(error) {
          recoverableErrors.push(
            error instanceof Error ? error : new Error(String(error)),
          );
        },
      },
    );
    let renderedNeedsLink = false;
    try {
      await act(async () => undefined);
      renderedNeedsLink = within(container).queryByText("needs you") !== null;
    } finally {
      act(() => root.unmount());
      container.remove();
    }

    expect(recoverableErrors).toEqual([]);
    expect(renderedNeedsLink).toBe(true);
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
    expect(
      getNeedsLink().querySelector<HTMLElement>("[aria-hidden='true']"),
    ).toHaveClass("motion-reduce:[animation:none]");
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
