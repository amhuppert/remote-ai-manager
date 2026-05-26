// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
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
});
