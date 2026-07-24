// @vitest-environment jsdom
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { act, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderToString } from "react-dom/server";
import { hydrateRoot } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { createTestQueryClient, renderWithQuery } from "@/test/component-mocks";
import { installFetchFixture, type FetchFixture } from "@/test/fetch-fixture";
import { conversationKeys } from "@/lib/conversations/query-keys";
import Topbar from "./Topbar";
import type {
  ActiveConversation,
  ActiveConversationsResponse,
} from "@/lib/active-conversations/schemas";
import type { Notification } from "@/lib/notifications/schemas";
import {
  useQuickTicketStore,
  type QuickTicketStoreState,
} from "@/stores/quick-ticket.store";

// next/link is an external framework module, not an internal seam; the
// sanctioned client-test pattern (@/test/fetch-fixture) covers only the network
// boundary, so it keeps its component-mock stub. The Topbar's stores are real
// Zustand (client state we own — default closed/empty), and its queries run for
// real against the fetch fixture below.
vi.mock(
  "next/link",
  async () => (await import("@/test/component-mocks")).nextLinkMock,
);

const navigationState = vi.hoisted(() => ({ pathname: "/projects" }));
vi.mock("next/navigation", () => ({
  usePathname: () => navigationState.pathname,
}));

const RESET_QUICK_TICKET_STATE: QuickTicketStoreState = {
  open: false,
  lifecycleRevision: 0,
  bugMode: false,
  draft: null,
  draftStashed: false,
  draftRestored: false,
  contextSnapshot: null,
  conversationRegistry: [],
};

let api: FetchFixture;

function makeActiveConversationsResponse(
  conversations: ActiveConversation[],
): ActiveConversationsResponse {
  return {
    conversations,
    graphWorkflowExecutions: [],
    activeCollaborationExecutions: [],
    specExecutions: [],
  };
}

function setActiveConversations(conversations: ActiveConversation[]): void {
  api.json(
    "GET",
    "/api/conversations/active",
    makeActiveConversationsResponse(conversations),
  );
}

function setNotifications(notifications: Notification[]): void {
  api.json("GET", "/api/notifications", {
    notifications,
    total: notifications.length,
    unreadCount: notifications.filter((row) => !row.read).length,
  });
}

function makeSpecNotification(
  overrides: Partial<Extract<Notification, { source: "spec" }>> = {},
): Extract<Notification, { source: "spec" }> {
  return {
    source: "spec",
    id: "spec-notification-1",
    type: "spec-approval-requested",
    title: "Design approval requested",
    message: "Native SDD: R6",
    read: false,
    projectName: "root-tools",
    createdAt: "2026-06-10T09:03:00.000Z",
    sessionName: null,
    specId: "spec-native-sdd",
    specSlug: "native-sdd",
    specName: "Native SDD",
    gate: "design",
    gateRequestId: "gate-request-1",
    deepLinkId: "R6",
    ...overrides,
  };
}

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

function getNeedsTrigger(): HTMLButtonElement {
  const needsLabel = screen.getByText(/needs? you/);
  const trigger = needsLabel.closest("button");
  expect(trigger).not.toBeNull();
  return trigger as HTMLButtonElement;
}

/** Await the async attention trigger the active-conversations query drives. */
async function findNeedsTrigger(): Promise<HTMLButtonElement> {
  await screen.findByText(/needs? you/);
  return getNeedsTrigger();
}

describe("Topbar", () => {
  beforeEach(() => {
    navigationState.pathname = "/projects";
    window.history.replaceState({}, "", "/projects");
    useQuickTicketStore.setState(RESET_QUICK_TICKET_STATE);
    api = installFetchFixture();
    // Topbar always issues these two GETs; default them to empty so tests that
    // don't care about attention state render a quiet bar.
    api.json("GET", "/api/notifications", {
      notifications: [],
      total: 0,
      unreadCount: 0,
    });
    setActiveConversations([]);
  });

  afterEach(() => {
    api.restore();
  });

  // =========================================================================
  // 6.2 – Topbar (Req 5.1–5.5)
  // =========================================================================

  it("renders CC logo linking to /projects (Req 5.1)", () => {
    renderWithQuery(<Topbar breadcrumbs={[]} page="projects" />);
    const logo = screen.getByText("CC");
    expect(logo.closest("a")?.getAttribute("href")).toBe("/projects");
  });

  it("renders breadcrumb segments with correct labels and links (Req 5.2, 5.3)", () => {
    renderWithQuery(
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
    renderWithQuery(
      <Topbar
        breadcrumbs={[]}
        page="detail"
        sessionControls={<button>Delete</button>}
      />,
    );
    expect(screen.getByText("Delete")).toBeInTheDocument();
  });

  it("renders global status on non-detail pages (Req 5.5)", () => {
    renderWithQuery(
      <Topbar
        breadcrumbs={[]}
        page="projects"
        globalStatus={<span>3 active</span>}
      />,
    );
    expect(screen.getByText("3 active")).toBeInTheDocument();
  });

  it("does not render global status on detail page", () => {
    renderWithQuery(
      <Topbar
        breadcrumbs={[]}
        page="detail"
        globalStatus={<span>3 active</span>}
      />,
    );
    expect(screen.queryByText("3 active")).toBeNull();
  });

  it("renders a global Tickets destination linking to /tickets (ticket-system Req 9.1)", () => {
    renderWithQuery(<Topbar breadcrumbs={[]} page="projects" />);
    const link = screen.getByTitle("Tickets");
    expect(link.getAttribute("href")).toBe("/tickets");
    expect(link).toHaveTextContent("Tickets");
  });

  it("scopes the Tickets destination to the active project breadcrumb", () => {
    renderWithQuery(
      <Topbar
        breadcrumbs={[{ label: "command-center", isProject: true }]}
        page="detail"
      />,
    );
    expect(screen.getByTitle("Tickets").getAttribute("href")).toBe(
      "/tickets?project=command-center",
    );
  });

  it("renders Quick ticket before Tickets and opens a route-context draft", async () => {
    navigationState.pathname = "/projects/command-center";
    window.history.replaceState({}, "", "/projects/command-center");
    const user = userEvent.setup();
    renderWithQuery(<Topbar breadcrumbs={[]} page="projects" />);

    const quickTicket = screen.getByRole("button", { name: "Quick ticket" });
    const tickets = screen.getByTitle("Tickets");
    expect(
      quickTicket.compareDocumentPosition(tickets) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    await user.click(quickTicket);
    expect(useQuickTicketStore.getState()).toMatchObject({
      open: true,
      contextSnapshot: { projectName: "command-center" },
    });
  });

  it("renders Specs as a global navigation peer", () => {
    renderWithQuery(<Topbar breadcrumbs={[]} page="specs" />);
    const link = screen.getByTitle("Specs");
    expect(link.getAttribute("href")).toBe("/specs");
    expect(link).toHaveTextContent("Specs");
  });

  it("points the Specs button at the active project when a project breadcrumb is present", () => {
    renderWithQuery(
      <Topbar
        breadcrumbs={[
          { label: "projects", href: "/projects" },
          {
            label: "command-center",
            href: "/projects/command-center",
            isProject: true,
          },
        ]}
        page="sessions"
      />,
    );
    const link = screen.getByTitle("Specs");
    expect(link.getAttribute("href")).toBe("/specs?project=command-center");
  });

  it("points the mobile Specs menu item at the active project", async () => {
    const user = userEvent.setup();
    renderWithQuery(
      <Topbar
        breadcrumbs={[
          { label: "projects", href: "/projects" },
          {
            label: "command-center",
            href: "/projects/command-center",
            isProject: true,
          },
        ]}
        page="sessions"
      />,
    );

    await user.click(screen.getByRole("button", { name: "More destinations" }));
    expect(screen.getByRole("menuitem", { name: "Specs" })).toHaveAttribute(
      "href",
      "/specs?project=command-center",
    );
  });

  it("does not expose the workflow atlas as a global destination", async () => {
    const user = userEvent.setup();
    renderWithQuery(
      <Topbar breadcrumbs={[{ label: "tickets" }]} page="tickets" />,
    );

    expect(screen.queryByTitle("Workflow Atlas")).toBeNull();

    await user.click(screen.getByRole("button", { name: "More destinations" }));
    expect(
      screen.queryByRole("menuitem", { name: "Workflow Atlas" }),
    ).toBeNull();
  });

  it("keeps every global destination reachable without overflowing a 320px topbar", async () => {
    renderWithQuery(
      <Topbar breadcrumbs={[{ label: "tickets" }]} page="tickets" />,
    );
    const user = userEvent.setup();

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
      screen.getByRole("menuitem", { name: /Quick ticket/ }),
    ).toBeInTheDocument();

    expect(
      screen.getByRole("menuitem", { name: "Workflow Templates" }),
    ).toHaveAttribute("href", "/templates");
    expect(
      screen.getByRole("menuitem", { name: "System Configuration" }),
    ).toHaveAttribute("href", "/config");

    expect(screen.getByRole("navigation")).toHaveClass("max-[360px]:hidden");
  });

  it("opens Quick ticket from the mobile destinations menu", async () => {
    navigationState.pathname = "/tickets";
    window.history.replaceState({}, "", "/tickets?project=command-center");
    const user = userEvent.setup();
    renderWithQuery(<Topbar breadcrumbs={[]} page="tickets" />);

    await user.click(screen.getByRole("button", { name: "More destinations" }));
    await user.click(screen.getByRole("menuitem", { name: /Quick ticket/ }));

    expect(useQuickTicketStore.getState()).toMatchObject({
      open: true,
      contextSnapshot: { projectName: "command-center" },
    });
  });

  it("gates both Quick ticket affordances on the configuration route", async () => {
    navigationState.pathname = "/config";
    window.history.replaceState({}, "", "/config");
    const user = userEvent.setup();
    renderWithQuery(<Topbar breadcrumbs={[]} page="projects" />);

    expect(screen.queryByRole("button", { name: "Quick ticket" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "More destinations" }));
    expect(screen.queryByRole("menuitem", { name: /Quick ticket/ })).toBeNull();
  });

  it("hydrates without replacing the tree when attention data is already cached on the client", async () => {
    // Server render sees the ready gate as false and produces a quiet bar.
    const serverClient = createTestQueryClient();
    const serverHtml = renderToString(
      <QueryClientProvider client={serverClient}>
        <Topbar breadcrumbs={[]} page="projects" />
      </QueryClientProvider>,
    );

    // "Already cached on the client": seed the query cache so the client render
    // has attention data without a network round-trip.
    const clientClient = createTestQueryClient();
    clientClient.setQueryData(
      conversationKeys.active(),
      makeActiveConversationsResponse([
        makeProjectConversation({
          id: "project-unread",
          projectName: "root-tools",
          status: "awaiting",
          unread: true,
        }),
      ]),
    );

    const container = document.createElement("div");
    container.innerHTML = serverHtml;
    document.body.append(container);
    const recoverableErrors: Error[] = [];

    const root = hydrateRoot(
      container,
      <QueryClientProvider client={clientClient}>
        <Topbar breadcrumbs={[]} page="projects" />
      </QueryClientProvider>,
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

  it("counts project waiting_for_input rows and links to the project focus URL (Req 11.2, 12.1, 12.3)", async () => {
    const user = userEvent.setup();
    setActiveConversations([
      makeProjectConversation({
        id: "project-question",
        projectName: "root-tools",
        status: "waiting_for_input",
      }),
    ]);

    renderWithQuery(<Topbar breadcrumbs={[]} page="projects" />);

    const trigger = await findNeedsTrigger();
    expect(within(trigger).getByText("1")).toBeInTheDocument();
    await user.click(trigger);
    expect(
      screen
        .getByRole("menuitem", {
          name: /Input requested.*Project conversation/i,
        })
        .getAttribute("href"),
    ).toBe("/projects/root-tools?focus=project-question");
    expect(
      trigger.querySelector<HTMLElement>("[aria-hidden='true']"),
    ).toHaveClass("motion-reduce:[animation:none]");
  });

  it("counts unread project awaiting rows as needing attention (Req 11.2, 11.3)", async () => {
    const user = userEvent.setup();
    setActiveConversations([
      makeProjectConversation({
        id: "project-unread",
        projectName: "root-tools",
        status: "awaiting",
        unread: true,
      }),
    ]);

    renderWithQuery(<Topbar breadcrumbs={[]} page="projects" />);

    const trigger = await findNeedsTrigger();
    expect(within(trigger).getByText("1")).toBeInTheDocument();
    await user.click(trigger);
    expect(
      screen
        .getByRole("menuitem", {
          name: /Unread update.*Project conversation/i,
        })
        .getAttribute("href"),
    ).toBe("/projects/root-tools?focus=project-unread");
  });

  it("targets the conversations page when the first attention target is a session row (Req 11.2, 12.4)", async () => {
    const user = userEvent.setup();
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

    renderWithQuery(<Topbar breadcrumbs={[]} page="projects" />);

    const trigger = await findNeedsTrigger();
    expect(within(trigger).getByText("2")).toBeInTheDocument();
    await user.click(trigger);
    expect(screen.getAllByRole("menuitem")[0]?.getAttribute("href")).toBe(
      "/conversations?c=session-question",
    );
  });

  it("counts gated conversations as needing attention and calls out approvals distinctly", async () => {
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

    renderWithQuery(<Topbar breadcrumbs={[]} page="projects" />);

    const trigger = await findNeedsTrigger();
    expect(within(trigger).getByText("2")).toBeInTheDocument();
    expect(screen.getByText("need you")).toBeInTheDocument();
    expect(screen.getByText("· 1 approval")).toBeInTheDocument();
  });

  it("opens one Needs You menu containing conversation and durable spec decisions", async () => {
    const user = userEvent.setup();
    setActiveConversations([
      makeProjectConversation({
        id: "project-question",
        name: "Release notes",
        projectName: "root-tools",
        status: "waiting_for_input",
        pendingQuestion: "Which release should this target?",
        lastActivityAt: "2026-06-10T09:01:00.000Z",
      }),
    ]);
    setNotifications([
      makeSpecNotification({
        id: "waiver-request",
        type: "spec-waiver-requested",
        title: "Delivery waiver requested",
        message: "Native SDD: criterion cannot be proven in this execution",
        gate: "delivery",
        gateRequestId: "waiver-1",
        deepLinkId: "R3.2",
        createdAt: "2026-06-10T09:02:00.000Z",
      }),
      makeSpecNotification(),
    ]);

    renderWithQuery(<Topbar breadcrumbs={[]} page="projects" />);

    const trigger = await screen.findByRole("button", {
      name: /3 items need/i,
    });
    await user.click(trigger);

    expect(
      screen.getByRole("menu", { name: /Needs you/i }),
    ).toBeInTheDocument();
    expect(screen.getByText("Design approval required")).toBeInTheDocument();
    expect(screen.getByText("Waiver decision required")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Native SDD: criterion cannot be proven in this execution",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Which release should this target?"),
    ).toBeInTheDocument();
    expect(
      screen.getAllByRole("menuitem").map((row) => row.textContent),
    ).toEqual([
      expect.stringContaining("Design approval required"),
      expect.stringContaining("Waiver decision required"),
      expect.stringContaining("Input requested"),
    ]);
    expect(
      screen
        .getByRole("menuitem", {
          name: /Design approval required.*Native SDD/i,
        })
        .getAttribute("href"),
    ).toBe("/specs/root-tools/native-sdd?el=R6");
    expect(
      screen
        .getByRole("menuitem", { name: /input requested.*Release notes/i })
        .getAttribute("href"),
    ).toBe("/projects/root-tools?focus=project-question");
  });
});
