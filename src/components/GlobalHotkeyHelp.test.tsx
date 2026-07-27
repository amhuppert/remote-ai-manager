// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { HotkeyProvider } from "@/components/hotkeys/HotkeyProvider";
import { createHotkeyDispatcher } from "@/lib/hotkeys/dispatcher";
import GlobalHotkeyHelp from "./GlobalHotkeyHelp";

describe("GlobalHotkeyHelp", () => {
  it("opens keyboard help with ?", () => {
    render(
      <HotkeyProvider dispatcher={createHotkeyDispatcher()}>
        <GlobalHotkeyHelp />
      </HotkeyProvider>,
    );

    fireEvent.keyDown(document, {
      key: "?",
      code: "Slash",
      shiftKey: true,
    });

    expect(
      screen.getByRole("dialog", { name: "Keyboard Shortcuts" }),
    ).toBeInTheDocument();
  });

  it("opens the searchable command launcher with .", () => {
    render(
      <HotkeyProvider dispatcher={createHotkeyDispatcher()}>
        <GlobalHotkeyHelp />
      </HotkeyProvider>,
    );

    fireEvent.keyDown(document, {
      key: ".",
      code: "Period",
    });

    expect(
      screen.getByRole("dialog", { name: "Command Launcher" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("combobox", { name: "Search commands" }),
    ).toHaveFocus();
  });

  it("restores prompt focus after closing help opened through one-shot mode", async () => {
    render(
      <HotkeyProvider dispatcher={createHotkeyDispatcher()}>
        <div
          contentEditable
          data-cc-prompt-id="prompt-a"
          data-testid="prompt"
        />
        <GlobalHotkeyHelp />
      </HotkeyProvider>,
    );
    const prompt = screen.getByTestId("prompt");
    prompt.textContent = "draft text";
    prompt.focus();
    const caret = document.createRange();
    caret.setStart(prompt.firstChild!, 5);
    caret.collapse(true);
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(caret);

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
    fireEvent.keyDown(prompt, {
      key: "?",
      code: "Slash",
      shiftKey: true,
    });

    expect(
      screen.getByRole("dialog", { name: "Keyboard Shortcuts" }),
    ).toBeInTheDocument();

    fireEvent.keyDown(document, {
      key: "Escape",
      code: "Escape",
    });

    await waitFor(() => expect(prompt).toHaveFocus());
    expect(prompt).toHaveTextContent("draft text");
    expect(window.getSelection()?.focusOffset).toBe(5);
  });
});
