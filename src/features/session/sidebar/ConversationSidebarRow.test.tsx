// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type {
  ProjectActiveConversation,
  SessionActiveConversation,
} from "@/lib/active-conversations/schemas";
import ConversationSidebarRow from "@/features/session/sidebar/ConversationSidebarRow";

const BASE: SessionActiveConversation = {
  scope: "session",
  id: "convo-1",
  name: "Some conversation",
  status: "running",
  lastActivityAt: "2026-05-15T12:30:00.000Z",
  projectName: "my-project",
  projectPath: "/home/user/my-project",
  sessionName: "my-session",
  agentBackend: "claude",
  summary: null,
  pendingQuestion: null,
  pendingQuestionId: null,
  pendingQuestions: null,
  forkedFrom: null,
  debugActive: false,
  role: null,
  branchName: null,
  worktreePath: "/home/user/my-project/.worktrees/my-session",
  lastActivitySummary: null,
  unread: false,
};

const PROJECT_BASE: ProjectActiveConversation = {
  scope: "project",
  id: "project-convo-1",
  name: "Project conversation",
  status: "awaiting",
  lastActivityAt: "2026-05-15T12:36:00.000Z",
  projectName: "my-project",
  projectPath: "/home/user/my-project",
  agentBackend: "claude",
  summary: null,
  pendingQuestion: null,
  pendingQuestionId: null,
  pendingQuestions: null,
  forkedFrom: null,
  debugActive: false,
  role: null,
  worktreePath: "/home/user/my-project",
  lastActivitySummary: "Checked repo root health",
  unread: true,
  open: true,
};

describe("ConversationSidebarRow", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-15T12:42:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not render a branch chip when branchName is non-null", () => {
    render(
      <ConversationSidebarRow
        conversation={{ ...BASE, branchName: "cc/feat-foo" }}
      />,
    );
    expect(screen.queryByLabelText("branch: cc/feat-foo")).toBeNull();
    expect(screen.queryByText("cc/feat-foo")).toBeNull();
  });

  it("renders a compact last-activity time", () => {
    render(
      <ConversationSidebarRow
        conversation={{ ...BASE, lastActivityAt: "2026-05-15T12:30:00.000Z" }}
      />,
    );
    expect(screen.getByText("12m")).toBeDefined();
  });

  it("keeps the status dot in the title line", () => {
    const { container } = render(
      <ConversationSidebarRow conversation={BASE} />,
    );

    const titleLine = container.querySelector(
      ".conversation-sidebar-row__title-line",
    );
    expect(
      titleLine?.querySelector(".conversation-sidebar-row__dot"),
    ).toBeDefined();
  });

  it("labels only waiting_for_input activity as asking for input", () => {
    const { rerender } = render(
      <ConversationSidebarRow
        conversation={{
          ...BASE,
          status: "awaiting",
          lastActivitySummary: "Waiting for the next worker step",
        }}
      />,
    );

    expect(screen.queryByText(/Asks/)).toBeNull();

    rerender(
      <ConversationSidebarRow
        conversation={{
          ...BASE,
          status: "waiting_for_input",
          pendingQuestion: "Would you like me to run the workflow?",
        }}
      />,
    );

    expect(screen.getByText(/Asks/)).toBeDefined();
  });

  it("calls onPeek with the row element and conversation id for non-current left-clicks", () => {
    const onPeek = vi.fn();

    render(
      <ConversationSidebarRow
        conversation={BASE}
        currentConversationId="convo-current"
        onPeek={onPeek}
      />,
    );

    const row = screen.getByLabelText("Some conversation — running");
    fireEvent.click(row);

    expect(onPeek).toHaveBeenCalledWith(row, "convo-1");
  });

  it("does not peek or navigate for current-row left-clicks", () => {
    const onPeek = vi.fn();
    const onClick = vi.fn();

    render(
      <ConversationSidebarRow
        conversation={BASE}
        currentConversationId="convo-1"
        onPeek={onPeek}
        onClick={onClick}
      />,
    );

    fireEvent.click(screen.getByLabelText("Some conversation — running"));

    expect(onPeek).not.toHaveBeenCalled();
    expect(onClick).not.toHaveBeenCalled();
  });

  it("opens the context menu on right-click for non-current rows", () => {
    const onOpenMenu = vi.fn();

    render(
      <ConversationSidebarRow
        conversation={BASE}
        currentConversationId="convo-current"
        onOpenMenu={onOpenMenu}
      />,
    );

    fireEvent.contextMenu(
      screen.getByLabelText("Some conversation — running"),
      {
        clientX: 14,
        clientY: 28,
      },
    );

    expect(onOpenMenu).toHaveBeenCalledWith({ x: 14, y: 28 });
  });

  it("opens the context menu on right-click for current rows", () => {
    const onOpenMenu = vi.fn();

    render(
      <ConversationSidebarRow
        conversation={BASE}
        currentConversationId="convo-1"
        onOpenMenu={onOpenMenu}
      />,
    );

    fireEvent.contextMenu(
      screen.getByLabelText("Some conversation — running"),
      {
        clientX: 40,
        clientY: 52,
      },
    );

    expect(onOpenMenu).toHaveBeenCalledWith({ x: 40, y: 52 });
  });

  it("marks unread finished rows with the unread class and a Done prefix, and shows the acknowledge button", () => {
    const onAcknowledge = vi.fn();
    const { container } = render(
      <ConversationSidebarRow
        conversation={{
          ...BASE,
          status: "awaiting",
          unread: true,
          lastActivitySummary: "Built hotkeys help modal",
        }}
        onAcknowledge={onAcknowledge}
      />,
    );

    const row = container.querySelector(".conversation-sidebar-row");
    expect(row?.classList.contains("is-unread")).toBe(true);
    expect(
      container.querySelector(".conversation-sidebar-row__unread-dot"),
    ).not.toBeNull();
    expect(screen.getByText(/Done/)).toBeDefined();

    const ack = screen.getByRole("button", { name: /Mark .* as read/i });
    fireEvent.click(ack);
    expect(onAcknowledge).toHaveBeenCalledTimes(1);
  });

  it("does not render the acknowledge button on rows that aren't unread finishes", () => {
    render(
      <ConversationSidebarRow
        conversation={{
          ...BASE,
          status: "waiting_for_input",
          pendingQuestion: "Approve this?",
        }}
        onAcknowledge={vi.fn()}
      />,
    );
    expect(
      screen.queryByRole("button", { name: /Mark .* as read/i }),
    ).toBeNull();
  });

  it("does not call onClick or onPeek when the acknowledge button is clicked", () => {
    const onAcknowledge = vi.fn();
    const onClick = vi.fn();
    const onPeek = vi.fn();
    render(
      <ConversationSidebarRow
        conversation={{
          ...BASE,
          status: "awaiting",
          unread: true,
        }}
        onAcknowledge={onAcknowledge}
        onClick={onClick}
        onPeek={onPeek}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Mark .* as read/i }));
    expect(onAcknowledge).toHaveBeenCalledTimes(1);
    expect(onClick).not.toHaveBeenCalled();
    expect(onPeek).not.toHaveBeenCalled();
  });

  it("renders project rows with main context, backend, status, unread, and focus href", () => {
    const { container } = render(
      <ConversationSidebarRow
        conversation={PROJECT_BASE}
        href="/projects/my-project?focus=project-convo-1"
      />,
    );

    const row = screen.getByLabelText("Project conversation — awaiting");
    expect(row.getAttribute("href")).toBe(
      "/projects/my-project?focus=project-convo-1",
    );
    expect(screen.getByText("main")).toBeDefined();
    expect(screen.queryByText("my-session")).toBeNull();
    expect(screen.getByLabelText("agent: claude")).toBeDefined();
    expect(
      container.querySelector(
        '.conversation-sidebar-row__dot[data-status="awaiting"]',
      ),
    ).not.toBeNull();
    expect(
      container.querySelector(".conversation-sidebar-row__unread-dot"),
    ).not.toBeNull();
    expect(screen.getByText(/Done/)).toBeDefined();
  });

  it("renders project row breadcrumbs and activity without a synthetic session crumb", () => {
    render(
      <ConversationSidebarRow
        conversation={{
          ...PROJECT_BASE,
          projectName: "root-tools",
          lastActivitySummary: "Checked repo root health",
        }}
        href="/projects/root-tools?focus=project-convo-1"
      />,
    );

    const breadcrumb = document.querySelector(
      ".conversation-sidebar-row__breadcrumb",
    );
    expect(breadcrumb).not.toBeNull();
    expect(breadcrumb?.textContent).toContain("root-tools");
    expect(breadcrumb?.textContent).toContain("main");
    expect(breadcrumb?.textContent).not.toContain("my-session");
    expect(screen.getByText("Checked repo root health")).toBeDefined();
  });

  it("does not invoke session peek behavior for project rows", () => {
    const onPeek = vi.fn();
    const onClick = vi.fn();

    render(
      <ConversationSidebarRow
        conversation={PROJECT_BASE}
        href="/projects/my-project?focus=project-convo-1"
        currentConversationId="other-convo"
        onPeek={onPeek}
        onClick={onClick}
      />,
    );

    fireEvent.click(screen.getByLabelText("Project conversation — awaiting"));

    expect(onPeek).not.toHaveBeenCalled();
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("intercepts plain left-clicks on project rows so the anchor never triggers a full-page navigation (client-side only)", () => {
    const onClick = vi.fn();

    render(
      <ConversationSidebarRow
        conversation={PROJECT_BASE}
        href="/projects/my-project?focus=project-convo-1"
        currentConversationId="other-convo"
        onClick={onClick}
      />,
    );

    // fireEvent.click returns false when the event's default was prevented.
    const notCancelled = fireEvent.click(
      screen.getByLabelText("Project conversation — awaiting"),
    );

    expect(onClick).toHaveBeenCalledTimes(1);
    expect(notCancelled).toBe(false);
  });

  it("lets modifier-clicks on project rows fall through to the anchor so they open in a new tab", () => {
    const onClick = vi.fn();

    render(
      <ConversationSidebarRow
        conversation={PROJECT_BASE}
        href="/projects/my-project?focus=project-convo-1"
        currentConversationId="other-convo"
        onClick={onClick}
      />,
    );

    const notCancelled = fireEvent.click(
      screen.getByLabelText("Project conversation — awaiting"),
      { metaKey: true },
    );

    // The native anchor handles the modified click (new tab); no client-side nav.
    expect(onClick).not.toHaveBeenCalled();
    expect(notCancelled).toBe(true);
  });
});
