// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { HotkeyProvider } from "@/components/hotkeys/HotkeyProvider";
import { createHotkeyDispatcher } from "@/lib/hotkeys/dispatcher";
import { HOTKEY_REGISTRY, type HotkeyId } from "@/lib/shared/hotkeys";
import type { HotkeyCommandView } from "@/lib/hotkeys/dispatcher";
import { CommandLauncher } from "./CommandLauncher";

function command(id: HotkeyId, available: boolean): HotkeyCommandView {
  return {
    definition: HOTKEY_REGISTRY[id],
    registered: available,
    available,
  };
}

describe("CommandLauncher", () => {
  it("shows only available commands and searches labels and descriptions", () => {
    render(
      <CommandLauncher
        open
        onClose={vi.fn()}
        onRun={vi.fn()}
        commands={[
          command("switchProject", true),
          command("clearInput", true),
          command("newSession", false),
        ]}
      />,
    );

    expect(screen.getByText("Switch project")).toBeInTheDocument();
    expect(screen.getByText("Clear prompt")).toBeInTheDocument();
    expect(screen.queryByText("New session")).not.toBeInTheDocument();

    fireEvent.change(
      screen.getByRole("combobox", { name: "Search commands" }),
      { target: { value: "attachments" } },
    );

    expect(screen.getByText("Clear prompt")).toBeInTheDocument();
    expect(screen.queryByText("Switch project")).not.toBeInTheDocument();
  });

  it("runs the selected command with Enter and closes", () => {
    const onRun = vi.fn();
    const onClose = vi.fn();
    render(
      <CommandLauncher
        open
        onClose={onClose}
        onRun={onRun}
        commands={[command("switchProject", true), command("clearInput", true)]}
      />,
    );
    const input = screen.getByRole("combobox", {
      name: "Search commands",
    });

    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onRun).toHaveBeenCalledWith("clearInput");
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("exposes the keyboard-selected option through the combobox active descendant", () => {
    render(
      <CommandLauncher
        open
        onClose={vi.fn()}
        onRun={vi.fn()}
        commands={[command("switchProject", true), command("clearInput", true)]}
      />,
    );
    const input = screen.getByRole("combobox", {
      name: "Search commands",
    });
    const firstOption = screen.getByRole("option", {
      name: /Switch project/,
    });
    const secondOption = screen.getByRole("option", {
      name: /Clear prompt/,
    });

    expect(input).toHaveAttribute(
      "aria-activedescendant",
      firstOption.getAttribute("id"),
    );

    fireEvent.keyDown(input, { key: "ArrowDown" });

    expect(input).toHaveAttribute(
      "aria-activedescendant",
      secondOption.getAttribute("id"),
    );
    expect(secondOption).toHaveAttribute("aria-selected", "true");
  });

  it("keeps listbox options free of nested interactive controls", () => {
    render(
      <CommandLauncher
        open
        onClose={vi.fn()}
        onRun={vi.fn()}
        commands={[command("switchProject", true)]}
      />,
    );

    const option = screen.getByRole("option", {
      name: /Switch project/,
    });
    expect(option.querySelector("button")).toBeNull();
  });

  it("runs a registered command after the launcher overlay closes", async () => {
    const dispatcher = createHotkeyDispatcher();
    const execute = vi.fn();
    const onClose = vi.fn();
    dispatcher.register("goTickets", execute);

    render(
      <HotkeyProvider dispatcher={dispatcher}>
        <CommandLauncher
          open
          onClose={onClose}
          commands={[command("goTickets", true)]}
        />
      </HotkeyProvider>,
    );

    fireEvent.keyDown(
      screen.getByRole("combobox", { name: "Search commands" }),
      { key: "Enter" },
    );

    expect(onClose).toHaveBeenCalledOnce();
    await waitFor(() => expect(execute).toHaveBeenCalledOnce());
  });
});
