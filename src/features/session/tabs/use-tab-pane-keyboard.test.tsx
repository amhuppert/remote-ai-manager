// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { useState } from "react";
import {
  render,
  act,
  fireEvent,
  screen,
  waitFor,
} from "@testing-library/react";
import { useTabPaneKeyboard } from "./use-tab-pane-keyboard";
import { HotkeyProvider } from "@/components/hotkeys/HotkeyProvider";
import GlobalHotkeyHelp from "@/components/GlobalHotkeyHelp";
import { createHotkeyDispatcher } from "@/lib/hotkeys/dispatcher";
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

function press(key: string, code: string): KeyboardEvent {
  const event = new KeyboardEvent("keydown", {
    key,
    code,
    bubbles: true,
    cancelable: true,
  });
  act(() => document.dispatchEvent(event));
  return event;
}

function pressSequence(...strokes: [key: string, code: string][]): void {
  for (const [key, code] of strokes) press(key, code);
}

function setOverlayOpen(open: boolean): void {
  act(() => {
    _useOverlayScopeStore.setState({ openStack: open ? ["x"] : [] });
  });
}

function Harness({
  workingSet,
  activeId,
  activate,
  closeTab,
  layout,
  onEnterPanes,
  onExitPanes,
}: {
  workingSet: SessionActiveConversation[];
  activeId: string | null;
  activate: (id: string) => void;
  closeTab: (id: string) => void;
  layout: LayoutMode;
  onEnterPanes: () => void;
  onExitPanes: () => void;
}): null {
  useTabPaneKeyboard({
    workingSet,
    activeId,
    activate,
    closeTab,
    layout,
    onEnterPanes,
    onExitPanes,
  });
  return null;
}

function renderHarness(input: {
  workingSet: SessionActiveConversation[];
  activeId: string | null;
  activate: (id: string) => void;
  closeTab?: (id: string) => void;
  layout?: LayoutMode;
  onEnterPanes?: () => void;
  onExitPanes?: () => void;
}) {
  const dispatcher = createHotkeyDispatcher();
  const rendered = render(
    <HotkeyProvider dispatcher={dispatcher}>
      <Harness
        workingSet={input.workingSet}
        activeId={input.activeId}
        activate={input.activate}
        closeTab={input.closeTab ?? vi.fn()}
        layout={input.layout ?? "split"}
        onEnterPanes={input.onEnterPanes ?? vi.fn()}
        onExitPanes={input.onExitPanes ?? vi.fn()}
      />
    </HotkeyProvider>,
  );
  return { ...rendered, dispatcher };
}

function CloseFocusHarness(): React.JSX.Element {
  const [activeId, setActiveId] = useState("a");
  useTabPaneKeyboard({
    workingSet: ["a", "b"].map(makeConversation),
    activeId,
    activate: setActiveId,
    closeTab: () => setActiveId("b"),
    layout: "split",
    onEnterPanes: vi.fn(),
    onExitPanes: vi.fn(),
  });
  return (
    <>
      <div
        key={activeId}
        contentEditable
        data-cc-prompt-id={`prompt-${activeId}`}
        data-testid={`prompt-${activeId}`}
      />
      <GlobalHotkeyHelp />
    </>
  );
}

describe("useTabPaneKeyboard", () => {
  beforeEach(() => {
    _useOverlayScopeStore.setState({ openStack: [] });
  });

  it("activates an indexed conversation with G then 1 through 9", () => {
    const workingSet = ["a", "b", "c"].map(makeConversation);
    const activate = vi.fn();
    renderHarness({ workingSet, activeId: "a", activate });

    pressSequence(["g", "KeyG"], ["2", "Digit2"]);
    expect(activate).toHaveBeenCalledWith("b");

    pressSequence(["g", "KeyG"], ["1", "Digit1"]);
    expect(activate).toHaveBeenCalledWith("a");
  });

  it("does not consume an unoccupied indexed position", () => {
    const workingSet = ["a", "b", "c"].map(makeConversation);
    const activate = vi.fn();
    renderHarness({ workingSet, activeId: "a", activate });

    press("g", "KeyG");
    const unavailable = press("5", "Digit5");

    expect(activate).not.toHaveBeenCalled();
    expect(unavailable.defaultPrevented).toBe(false);
  });

  it("cycles next and previous with wrapping", () => {
    const workingSet = ["a", "b", "c"].map(makeConversation);
    const activate = vi.fn();
    const { rerender, dispatcher } = renderHarness({
      workingSet,
      activeId: "c",
      activate,
    });

    pressSequence(["g", "KeyG"], ["j", "KeyJ"]);
    expect(activate).toHaveBeenLastCalledWith("a");

    rerender(
      <HotkeyProvider dispatcher={dispatcher}>
        <Harness
          workingSet={workingSet}
          activeId="a"
          activate={activate}
          closeTab={vi.fn()}
          layout="split"
          onEnterPanes={vi.fn()}
          onExitPanes={vi.fn()}
        />
      </HotkeyProvider>,
    );

    pressSequence(["g", "KeyG"], ["k", "KeyK"]);
    expect(activate).toHaveBeenLastCalledWith("c");
  });

  it("does not consume cycling when fewer than two conversations are open", () => {
    const activate = vi.fn();
    renderHarness({
      workingSet: [makeConversation("a")],
      activeId: "a",
      activate,
    });

    press("g", "KeyG");
    const unavailable = press("j", "KeyJ");

    expect(activate).not.toHaveBeenCalled();
    expect(unavailable.defaultPrevented).toBe(false);
  });

  it("suppresses navigation while an overlay is open and restores it after", () => {
    const workingSet = ["a", "b", "c"].map(makeConversation);
    const activate = vi.fn();
    renderHarness({ workingSet, activeId: "a", activate });

    setOverlayOpen(true);
    pressSequence(["g", "KeyG"], ["2", "Digit2"]);
    expect(activate).not.toHaveBeenCalled();

    setOverlayOpen(false);
    pressSequence(["g", "KeyG"], ["2", "Digit2"]);
    expect(activate).toHaveBeenCalledWith("b");
  });

  it("closes the active working-set conversation with X", () => {
    const closeTab = vi.fn();
    renderHarness({
      workingSet: ["a", "b"].map(makeConversation),
      activeId: "b",
      activate: vi.fn(),
      closeTab,
    });

    const event = press("x", "KeyX");

    expect(event.defaultPrevented).toBe(true);
    expect(closeTab).toHaveBeenCalledWith("b");
  });

  it("moves prompt focus to the selected neighbor after one-shot X", async () => {
    render(
      <HotkeyProvider dispatcher={createHotkeyDispatcher()}>
        <CloseFocusHarness />
      </HotkeyProvider>,
    );
    const prompt = screen.getByTestId("prompt-a");
    prompt.focus();

    fireEvent.keyDown(prompt, {
      key: ";",
      code: "Semicolon",
      ctrlKey: true,
    });
    fireEvent.keyUp(prompt, {
      key: ";",
      code: "Semicolon",
      ctrlKey: true,
    });
    fireEvent.keyUp(prompt, {
      key: "Control",
      code: "ControlLeft",
    });
    fireEvent.keyDown(prompt, { key: "x", code: "KeyX" });

    await waitFor(() => expect(screen.getByTestId("prompt-b")).toHaveFocus());
  });

  it("moves prompt focus to the selected neighbor after launcher-invoked close", async () => {
    render(
      <HotkeyProvider dispatcher={createHotkeyDispatcher()}>
        <CloseFocusHarness />
      </HotkeyProvider>,
    );
    const prompt = screen.getByTestId("prompt-a");
    prompt.focus();

    fireEvent.keyDown(prompt, {
      key: ";",
      code: "Semicolon",
      ctrlKey: true,
    });
    fireEvent.keyUp(prompt, {
      key: ";",
      code: "Semicolon",
      ctrlKey: true,
    });
    fireEvent.keyUp(prompt, {
      key: "Control",
      code: "ControlLeft",
    });
    fireEvent.keyDown(prompt, { key: ".", code: "Period" });

    const search = screen.getByRole("combobox", {
      name: "Search commands",
    });
    fireEvent.change(search, {
      target: { value: "Close conversation tab" },
    });
    fireEvent.keyDown(search, { key: "Enter", code: "Enter" });

    await waitFor(() => expect(screen.getByTestId("prompt-b")).toHaveFocus());
  });

  it("does not register close when the selected conversation is not open", () => {
    const closeTab = vi.fn();
    renderHarness({
      workingSet: [makeConversation("a")],
      activeId: "missing",
      activate: vi.fn(),
      closeTab,
    });

    const event = press("x", "KeyX");

    expect(event.defaultPrevented).toBe(false);
    expect(closeTab).not.toHaveBeenCalled();
  });

  it("exits panes when X closes the final open conversation", () => {
    const closeTab = vi.fn();
    const onExitPanes = vi.fn();
    renderHarness({
      workingSet: [makeConversation("a")],
      activeId: "a",
      activate: vi.fn(),
      closeTab,
      layout: "panes",
      onExitPanes,
    });

    press("x", "KeyX");

    expect(closeTab).toHaveBeenCalledWith("a");
    expect(onExitPanes).toHaveBeenCalledOnce();
  });

  it("enters panes with V then P only when at least two tabs are open", () => {
    const onEnterPanes = vi.fn();
    renderHarness({
      workingSet: ["a", "b"].map(makeConversation),
      activeId: "a",
      activate: vi.fn(),
      onEnterPanes,
    });

    pressSequence(["v", "KeyV"], ["p", "KeyP"]);

    expect(onEnterPanes).toHaveBeenCalledOnce();
  });

  it("leaves V then P available to the page when panes cannot be entered", () => {
    const onEnterPanes = vi.fn();
    renderHarness({
      workingSet: [makeConversation("a")],
      activeId: "a",
      activate: vi.fn(),
      onEnterPanes,
    });

    press("v", "KeyV");
    const unavailable = press("p", "KeyP");

    expect(unavailable.defaultPrevented).toBe(false);
    expect(onEnterPanes).not.toHaveBeenCalled();
  });
});
