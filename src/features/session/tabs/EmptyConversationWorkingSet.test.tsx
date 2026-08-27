// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import type { SessionActiveConversation } from "@/lib/active-conversations/schemas";
import EmptyConversationWorkingSet from "./EmptyConversationWorkingSet";

function conversation(id: string): SessionActiveConversation {
  return {
    id,
    scope: "session",
    name: `Conversation ${id}`,
    status: "awaiting",
    lastActivityAt: "2026-07-27T12:00:00.000Z",
    projectName: "command-center",
    projectPath: "/repo",
    agentBackend: "claude",
    summary: null,
    pendingQuestion: null,
    pendingQuestionId: null,
    pendingQuestions: null,
    forkedFrom: null,
    debugActive: false,
    role: null,
    worktreePath: "/repo/.worktrees/hotkeys",
    lastActivitySummary: null,
    unread: false,
    pendingApproval: null,
    backgroundActivity: null,
    sessionName: "hotkeys",
    branchName: "cc/hotkeys",
  };
}

describe("EmptyConversationWorkingSet", () => {
  it("shell-gates itself off the mobile notepad surface so the full-screen panel replaces it", () => {
    const { container } = render(
      <EmptyConversationWorkingSet
        addableConversations={[conversation("a")]}
        onAdd={vi.fn()}
      />,
    );

    // jsdom computes no stylesheet, so the CSS gate is pinned by its class:
    // the empty state hides when the .app shell carries
    // data-mobile-panel="notepad" at mobile width (the notepad panel is
    // full-screen there and must not be blocked by the empty working set).
    expect(container.firstElementChild?.className).toContain(
      "[.app[data-mobile-panel=notepad]_&]:hidden",
    );
  });

  it("focuses the recovery action when the final tab closes", () => {
    render(
      <EmptyConversationWorkingSet
        addableConversations={[conversation("a")]}
        onAdd={vi.fn()}
      />,
    );

    expect(
      screen.getByRole("button", { name: "Add conversation" }),
    ).toHaveFocus();
  });

  it("opens the conversation menu and restores a selected conversation", () => {
    const onAdd = vi.fn();
    render(
      <EmptyConversationWorkingSet
        addableConversations={[conversation("a")]}
        onAdd={onAdd}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Add conversation" }));
    const menu = screen.getByRole("menu");
    fireEvent.click(
      within(menu).getByRole("menuitem", { name: /Conversation a/ }),
    );

    expect(onAdd).toHaveBeenCalledWith("a");
    expect(screen.queryByRole("menu")).toBeNull();
  });
});
