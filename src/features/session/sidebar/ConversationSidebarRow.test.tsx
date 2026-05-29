// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { ActiveConversation } from "@/lib/active-conversations/schemas";
import ConversationSidebarRow from "@/features/session/sidebar/ConversationSidebarRow";

const BASE: ActiveConversation = {
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
});
