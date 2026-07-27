// @vitest-environment jsdom
import { act, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { createHotkeyDispatcher } from "@/lib/hotkeys/dispatcher";
import { HotkeyProvider } from "./HotkeyProvider";
import { GlobalHotkeyHUD, HotkeyAwaitingHUD } from "./HotkeyAwaitingHUD";

function activationEvent(): KeyboardEvent {
  return new KeyboardEvent("keydown", {
    key: ";",
    code: "Semicolon",
    ctrlKey: true,
    cancelable: true,
  });
}

describe("HotkeyAwaitingHUD", () => {
  it("renders the persistent one-shot status only for its prompt", () => {
    const dispatcher = createHotkeyDispatcher();
    render(
      <HotkeyProvider dispatcher={dispatcher}>
        <HotkeyAwaitingHUD promptId="prompt-a" />
        <HotkeyAwaitingHUD promptId="prompt-b" />
      </HotkeyProvider>,
    );

    act(() => {
      dispatcher.handleKeyDown(activationEvent(), {
        editable: true,
        overlayOpen: false,
        promptId: "prompt-a",
      });
    });

    expect(screen.getAllByRole("status")).toHaveLength(1);
    expect(screen.getByRole("status")).toHaveTextContent(
      "APP SHORTCUT · awaiting key",
    );
    expect(screen.getByRole("status")).toHaveTextContent("Esc cancels");
  });

  it("shows the pending leader inside one-shot mode", () => {
    const dispatcher = createHotkeyDispatcher();
    dispatcher.register("switchProject", () => undefined);
    render(
      <HotkeyProvider dispatcher={dispatcher}>
        <HotkeyAwaitingHUD promptId="prompt-a" />
      </HotkeyProvider>,
    );
    act(() => {
      dispatcher.handleKeyDown(activationEvent(), {
        editable: true,
        overlayOpen: false,
        promptId: "prompt-a",
      });
      dispatcher.handleKeyUp(
        new KeyboardEvent("keyup", {
          key: ";",
          code: "Semicolon",
          ctrlKey: true,
        }),
      );
      dispatcher.handleKeyUp(
        new KeyboardEvent("keyup", {
          key: "Control",
          code: "ControlLeft",
        }),
      );
      dispatcher.handleKeyDown(
        new KeyboardEvent("keydown", {
          key: "g",
          code: "KeyG",
          cancelable: true,
        }),
        {
          editable: true,
          overlayOpen: false,
          promptId: "prompt-a",
        },
      );
    });

    expect(screen.getByRole("status")).toHaveTextContent(
      "APP SHORTCUT · G · awaiting key",
    );
  });

  it("shows a transient global HUD for a normal leader", () => {
    const dispatcher = createHotkeyDispatcher();
    dispatcher.register("switchProject", () => undefined);
    render(
      <HotkeyProvider dispatcher={dispatcher}>
        <GlobalHotkeyHUD />
      </HotkeyProvider>,
    );

    act(() => {
      dispatcher.handleKeyDown(
        new KeyboardEvent("keydown", {
          key: "g",
          code: "KeyG",
          cancelable: true,
        }),
        {
          editable: false,
          overlayOpen: false,
          promptId: null,
        },
      );
    });

    expect(screen.getByRole("status")).toHaveTextContent(
      "APP SHORTCUT · G · awaiting key",
    );
  });
});
