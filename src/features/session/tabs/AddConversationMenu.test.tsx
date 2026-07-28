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
import AddConversationMenu, {
  type AddConversationMenuProps,
} from "./AddConversationMenu";

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

function renderMenu(overrides: Partial<AddConversationMenuProps> = {}): {
  onAdd: ReturnType<typeof vi.fn>;
  onClose: ReturnType<typeof vi.fn>;
} {
  const onAdd = vi.fn();
  const onClose = vi.fn();
  render(
    <AddConversationMenu
      addableConversations={[convo("a"), convo("b")]}
      onAdd={onAdd}
      onClose={onClose}
      {...overrides}
    />,
  );
  return { onAdd, onClose };
}

afterEach(() => {
  cleanup();
});

describe("AddConversationMenu", () => {
  it("renders a menu with one menuitem per addable conversation, showing title and project (2.9/6.2)", () => {
    renderMenu({
      addableConversations: [
        convo("a", { status: "running" }),
        convo("b", { status: "waiting_for_input" }),
      ],
    });

    expect(screen.getByRole("menu")).toBeInTheDocument();

    const items = screen.getAllByRole("menuitem");
    expect(items).toHaveLength(2);

    expect(within(items[0]!).getByText("Conversation a")).toBeInTheDocument();
    expect(within(items[0]!).getByText("proj-a")).toBeInTheDocument();
    expect(within(items[1]!).getByText("Conversation b")).toBeInTheDocument();
    expect(within(items[1]!).getByText("proj-b")).toBeInTheDocument();
  });

  it("falls back to a placeholder title for unnamed conversations", () => {
    renderMenu({
      addableConversations: [
        convo("a", { name: null }),
        convo("b", { name: "  " }),
      ],
    });

    expect(screen.getAllByText("Untitled conversation")).toHaveLength(2);
  });

  it("adds and closes when a menuitem is chosen (2.9/6.2)", () => {
    const { onAdd, onClose } = renderMenu({
      addableConversations: [convo("a"), convo("b")],
    });

    fireEvent.click(screen.getAllByRole("menuitem")[1]!);

    expect(onAdd).toHaveBeenCalledWith("b");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("renders an empty-state message and no menuitems when there is nothing to add", () => {
    renderMenu({ addableConversations: [] });

    expect(screen.queryAllByRole("menuitem")).toHaveLength(0);
    expect(screen.getByText("No conversations to add")).toBeInTheDocument();
  });

  it("closes on Escape via the overlay scope (8.3)", () => {
    const { onClose } = renderMenu();

    fireEvent.keyDown(document, { key: "Escape" });

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes on a mousedown outside the menu", () => {
    const { onClose } = renderMenu();

    fireEvent.mouseDown(document.body);

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("does not close on a mousedown inside the menu", () => {
    const { onClose } = renderMenu();

    fireEvent.mouseDown(screen.getByRole("menu"));

    expect(onClose).not.toHaveBeenCalled();
  });
});
