// @vitest-environment jsdom
import { act, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  HotkeyProvider,
  useHotkeySnapshot,
} from "@/components/hotkeys/HotkeyProvider";
import { createHotkeyDispatcher } from "@/lib/hotkeys/dispatcher";
import { _useOverlayScopeStore } from "@/stores/overlay-scope.store";
import { useAppHotkey } from "./useAppHotkey";

function dispatchKey(
  target: EventTarget,
  type: "keydown" | "keyup",
  init: KeyboardEventInit,
): KeyboardEvent {
  const event = new KeyboardEvent(type, {
    bubbles: true,
    cancelable: true,
    ...init,
  });
  act(() => {
    target.dispatchEvent(event);
  });
  return event;
}

function Harness({
  callback,
  enabled = true,
}: {
  callback: () => void;
  enabled?: boolean;
}): React.JSX.Element {
  useAppHotkey("toggleSidebar", callback, { enabled });
  const snapshot = useHotkeySnapshot();

  return (
    <>
      <button type="button">Page target</button>
      <div
        contentEditable
        data-cc-prompt-id="prompt-a"
        data-testid="prompt"
        suppressContentEditableWarning
      />
      <output data-testid="mode">{snapshot.mode}</output>
    </>
  );
}

describe("useAppHotkey with HotkeyProvider", () => {
  beforeEach(() => {
    _useOverlayScopeStore.setState({ openStack: [] });
  });

  it("dispatches a page shortcut through the single provider listener", () => {
    const callback = vi.fn();
    const dispatcher = createHotkeyDispatcher();
    render(
      <HotkeyProvider dispatcher={dispatcher}>
        <Harness callback={callback} />
      </HotkeyProvider>,
    );

    const event = dispatchKey(screen.getByRole("button"), "keydown", {
      key: "b",
      code: "KeyB",
    });

    expect(callback).toHaveBeenCalledOnce();
    expect(event.defaultPrevented).toBe(true);
  });

  it("uses the latest callback without creating duplicate registrations", () => {
    const first = vi.fn();
    const second = vi.fn();
    const dispatcher = createHotkeyDispatcher();
    const rendered = render(
      <HotkeyProvider dispatcher={dispatcher}>
        <Harness callback={first} />
      </HotkeyProvider>,
    );
    rendered.rerender(
      <HotkeyProvider dispatcher={dispatcher}>
        <Harness callback={second} />
      </HotkeyProvider>,
    );

    dispatchKey(screen.getByRole("button"), "keydown", {
      key: "b",
      code: "KeyB",
    });

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledOnce();
  });

  it("arms one shortcut from a focused prompt and preserves invalid input", () => {
    const callback = vi.fn();
    const dispatcher = createHotkeyDispatcher();
    render(
      <HotkeyProvider dispatcher={dispatcher}>
        <Harness callback={callback} />
      </HotkeyProvider>,
    );
    const prompt = screen.getByTestId("prompt");
    prompt.focus();

    dispatchKey(prompt, "keydown", {
      key: ";",
      code: "Semicolon",
      ctrlKey: true,
    });
    dispatchKey(prompt, "keyup", {
      key: ";",
      code: "Semicolon",
      ctrlKey: true,
    });
    dispatchKey(prompt, "keyup", {
      key: "Control",
      code: "ControlLeft",
    });
    expect(screen.getByTestId("mode")).toHaveTextContent("one-shot");

    const invalid = dispatchKey(prompt, "keydown", {
      key: "z",
      code: "KeyZ",
    });

    expect(invalid.defaultPrevented).toBe(false);
    expect(callback).not.toHaveBeenCalled();
    expect(screen.getByTestId("mode")).toHaveTextContent("idle");
  });

  it("invokes an app command from the prompt after one-shot activation", () => {
    const callback = vi.fn();
    const dispatcher = createHotkeyDispatcher();
    render(
      <HotkeyProvider dispatcher={dispatcher}>
        <Harness callback={callback} />
      </HotkeyProvider>,
    );
    const prompt = screen.getByTestId("prompt");
    prompt.focus();

    dispatchKey(prompt, "keydown", {
      key: ";",
      code: "Semicolon",
      ctrlKey: true,
    });
    dispatchKey(prompt, "keyup", {
      key: ";",
      code: "Semicolon",
      ctrlKey: true,
    });
    dispatchKey(prompt, "keyup", {
      key: "Control",
      code: "ControlLeft",
    });
    const command = dispatchKey(prompt, "keydown", {
      key: "b",
      code: "KeyB",
    });

    expect(callback).toHaveBeenCalledOnce();
    expect(command.defaultPrevented).toBe(true);
  });

  it("cancels pending state on pointer interaction", () => {
    const dispatcher = createHotkeyDispatcher();
    render(
      <HotkeyProvider dispatcher={dispatcher}>
        <Harness callback={vi.fn()} />
      </HotkeyProvider>,
    );
    const prompt = screen.getByTestId("prompt");

    dispatchKey(prompt, "keydown", {
      key: ";",
      code: "Semicolon",
      ctrlKey: true,
    });
    expect(screen.getByTestId("mode")).toHaveTextContent("one-shot");

    act(() => {
      document.dispatchEvent(
        new PointerEvent("pointerdown", { bubbles: true }),
      );
    });

    expect(screen.getByTestId("mode")).toHaveTextContent("idle");
  });

  it("suppresses shortcuts while an overlay is open", () => {
    const callback = vi.fn();
    const dispatcher = createHotkeyDispatcher();
    render(
      <HotkeyProvider dispatcher={dispatcher}>
        <Harness callback={callback} />
      </HotkeyProvider>,
    );
    act(() => {
      _useOverlayScopeStore.setState({ openStack: ["dialog"] });
    });

    const event = dispatchKey(screen.getByRole("button"), "keydown", {
      key: "b",
      code: "KeyB",
    });

    expect(callback).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });
});
