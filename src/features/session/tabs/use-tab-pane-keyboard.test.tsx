// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, act } from "@testing-library/react";
import { useTabPaneKeyboard } from "./use-tab-pane-keyboard";
import { _useOverlayScopeStore } from "@/stores/overlay-scope.store";
import type { SessionActiveConversation } from "@/lib/active-conversations/schemas";
import type { LayoutMode } from "@/lib/sessions/schemas";

function makeConversation(id: string): SessionActiveConversation {
  return {
    scope: "session",
    id,
    name: `Conversation ${id}`,
    status: "running",
    lastActivityAt: "2026-06-14T00:00:00.000Z",
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
    worktreePath: "/repo/.worktrees/x",
    lastActivitySummary: null,
    unread: false,
    pendingApproval: null,
    sessionName: `session-${id}`,
    branchName: `csm/${id}`,
  };
}

// react-hotkeys-hook resolves `mod` to Ctrl on non-Apple platforms, and jsdom
// reports as non-Apple, so the activation combos fire with `ctrlKey: true`.
function pressDigit(digit: string): void {
  document.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: digit,
      code: `Digit${digit}`,
      ctrlKey: true,
      bubbles: true,
    }),
  );
}

function pressEscape(): void {
  document.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: "Escape",
      code: "Escape",
      bubbles: true,
    }),
  );
}

function setOverlayOpen(open: boolean): void {
  act(() => {
    _useOverlayScopeStore.setState({ openStack: open ? ["x"] : [] });
  });
}

function Harness({
  workingSet,
  activate,
  layout,
  onExitPanes,
}: {
  workingSet: SessionActiveConversation[];
  activate: (id: string) => void;
  layout: LayoutMode;
  onExitPanes: () => void;
}): null {
  useTabPaneKeyboard({ workingSet, activate, layout, onExitPanes });
  return null;
}

describe("useTabPaneKeyboard", () => {
  beforeEach(() => {
    _useOverlayScopeStore.setState({ openStack: [] });
  });

  it("activates the Nth open conversation (8.1)", () => {
    const workingSet = ["a", "b", "c"].map(makeConversation);
    const activate = vi.fn();
    render(
      <Harness
        workingSet={workingSet}
        activate={activate}
        layout="split"
        onExitPanes={vi.fn()}
      />,
    );

    pressDigit("2");
    expect(activate).toHaveBeenCalledWith("b");

    pressDigit("1");
    expect(activate).toHaveBeenCalledWith("a");
  });

  it("does nothing when fewer than N conversations are open (8.1 guard)", () => {
    const workingSet = ["a", "b", "c"].map(makeConversation);
    const activate = vi.fn();
    render(
      <Harness
        workingSet={workingSet}
        activate={activate}
        layout="split"
        onExitPanes={vi.fn()}
      />,
    );

    pressDigit("5");
    expect(activate).not.toHaveBeenCalled();
  });

  it("exits panes on Escape only while in panes layout (8.2)", () => {
    const onExitPanes = vi.fn();
    const { rerender } = render(
      <Harness
        workingSet={["a"].map(makeConversation)}
        activate={vi.fn()}
        layout="panes"
        onExitPanes={onExitPanes}
      />,
    );

    pressEscape();
    expect(onExitPanes).toHaveBeenCalledTimes(1);

    onExitPanes.mockClear();
    rerender(
      <Harness
        workingSet={["a"].map(makeConversation)}
        activate={vi.fn()}
        layout="split"
        onExitPanes={onExitPanes}
      />,
    );

    pressEscape();
    expect(onExitPanes).not.toHaveBeenCalled();
  });

  it("suppresses both hotkeys while an overlay is open and restores them after (8.3)", () => {
    const workingSet = ["a", "b", "c"].map(makeConversation);
    const activate = vi.fn();
    const onExitPanes = vi.fn();
    render(
      <Harness
        workingSet={workingSet}
        activate={activate}
        layout="panes"
        onExitPanes={onExitPanes}
      />,
    );

    setOverlayOpen(true);
    pressDigit("2");
    pressEscape();
    expect(activate).not.toHaveBeenCalled();
    expect(onExitPanes).not.toHaveBeenCalled();

    setOverlayOpen(false);
    pressDigit("2");
    pressEscape();
    expect(activate).toHaveBeenCalledWith("b");
    expect(onExitPanes).toHaveBeenCalledTimes(1);
  });
});
