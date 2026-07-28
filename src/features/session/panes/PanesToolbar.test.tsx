// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  render,
  screen,
  fireEvent,
  cleanup,
  within,
} from "@testing-library/react";
import type { SessionActiveConversation } from "@/lib/active-conversations/schemas";
import PanesToolbar, { type PanesToolbarProps } from "./PanesToolbar";

function convo(
  id: string,
  overrides: Partial<SessionActiveConversation> = {},
): SessionActiveConversation {
  return {
    scope: "session",
    id,
    name: `Conversation ${id}`,
    status: "running",
    lastActivityAt: "2026-06-14T00:00:00.000Z",
    projectName: `proj-${id}`,
    projectPath: `/tmp/proj-${id}`,
    agentBackend: "claude",
    summary: null,
    pendingQuestion: null,
    pendingQuestionId: null,
    pendingQuestions: null,
    forkedFrom: null,
    debugActive: false,
    role: null,
    worktreePath: `/tmp/proj-${id}/.worktrees/x`,
    lastActivitySummary: null,
    unread: false,
    pendingApproval: null,
    backgroundActivity: null,
    sessionName: `session-${id}`,
    branchName: `csm/${id}`,
    ...overrides,
  };
}

function renderToolbar(overrides: Partial<PanesToolbarProps> = {}): {
  onAdd: ReturnType<typeof vi.fn>;
  onExit: ReturnType<typeof vi.fn>;
} {
  const onAdd = vi.fn();
  const onExit = vi.fn();
  render(
    <PanesToolbar
      count={3}
      isAtCap={false}
      addableConversations={[convo("a"), convo("b")]}
      onAdd={onAdd}
      onExit={onExit}
      {...overrides}
    />,
  );
  return { onAdd, onExit };
}

afterEach(() => {
  cleanup();
});

describe("PanesToolbar", () => {
  it("shows the current pane count out of the maximum of 6 (6.1)", () => {
    renderToolbar({ count: 3 });
    const count = screen.getByText(/3\s*\/\s*6\s*panes/i);
    expect(count).toBeTruthy();
  });

  it("renders the focus hint", () => {
    render(
      <PanesToolbar
        count={2}
        isAtCap={false}
        addableConversations={[]}
        onAdd={vi.fn()}
        onExit={vi.fn()}
      />,
    );
    expect(
      screen.getByText("Replies go to the active pane"),
    ).toBeInTheDocument();
  });

  it("enables the add control when not at cap, opens the menu, and adds a selection (6.2)", () => {
    const { onAdd } = renderToolbar({ isAtCap: false });

    const addButton = screen.getByRole("button", { name: "Add pane" });
    expect(addButton).toBeTruthy();
    expect((addButton as HTMLButtonElement).disabled).toBe(false);

    // Menu is not open until the trigger is clicked.
    expect(screen.queryByRole("menu")).toBeNull();

    fireEvent.click(addButton);

    const menu = screen.getByRole("menu");
    const itemA = within(menu).getByText("Conversation a");
    expect(itemA).toBeTruthy();

    fireEvent.click(itemA);
    expect(onAdd).toHaveBeenCalledWith("a");

    // Menu closes after a selection.
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("disables the add control at cap with a limit tooltip and does not open the menu (6.3)", () => {
    renderToolbar({ isAtCap: true });

    const addButton = screen.getByRole("button", { name: "Add pane" });
    expect((addButton as HTMLButtonElement).disabled).toBe(true);
    expect(addButton.getAttribute("title")).toMatch(/pane limit reached/i);

    fireEvent.click(addButton);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("calls onExit when the exit control is clicked (6.4)", () => {
    const { onExit } = renderToolbar();

    const exitButton = screen.getByRole("button", { name: "Exit panes" });
    fireEvent.click(exitButton);
    expect(onExit).toHaveBeenCalledTimes(1);
  });
});
