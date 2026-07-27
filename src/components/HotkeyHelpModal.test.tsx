// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import HotkeyHelpModal from "./HotkeyHelpModal";
import { HOTKEY_REGISTRY, type HotkeyId } from "@/lib/shared/hotkeys";
import type { HotkeyCommandView } from "@/lib/hotkeys/dispatcher";

function command(id: HotkeyId, available: boolean): HotkeyCommandView {
  return {
    definition: HOTKEY_REGISTRY[id],
    registered: available,
    available,
  };
}

describe("HotkeyHelpModal", () => {
  it("renders a labelled shortcuts dialog when open", () => {
    render(<HotkeyHelpModal open onClose={vi.fn()} />);
    expect(
      screen.getByRole("dialog", { name: "Keyboard Shortcuts" }),
    ).toBeInTheDocument();
  });

  it("keeps the preserved scroll-cap id and mobile-sheet hooks on the card", () => {
    // The scroll cap (max-height/overflow) lives in keyboard-shortcuts-modal.css
    // keyed on #hotkey-help-modal — not expressible as layoutClassName utilities —
    // and `mobileSheet` restores the ≤768px bottom-sheet treatment. Both are the
    // only hooks for the preserved mobile/scroll behaviour, so pin them here.
    render(<HotkeyHelpModal open onClose={vi.fn()} />);
    const dialog = screen.getByRole("dialog", { name: "Keyboard Shortcuts" });
    expect(dialog).toHaveAttribute("id", "hotkey-help-modal");
    expect(dialog.className).toContain("max-768:max-w-full");
  });

  it("renders nothing when closed", () => {
    render(<HotkeyHelpModal open={false} onClose={vi.fn()} />);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("closes on Escape", () => {
    // Radix's DismissableLayer owns Escape now (replacing the hand-rolled
    // capture-phase listener); background page hotkeys are suppressed while the
    // dialog is open via the Dialog root's useOverlayScope registration, not by
    // stopping propagation.
    const onClose = vi.fn();
    render(<HotkeyHelpModal open onClose={onClose} />);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("shows available commands first with descriptions and structured keycaps", () => {
    render(
      <HotkeyHelpModal
        open
        onClose={vi.fn()}
        commands={[
          command("switchProject", true),
          command("newSession", false),
        ]}
      />,
    );

    expect(screen.getByText("Switch project")).toBeInTheDocument();
    expect(screen.getByText("Open the project switcher")).toBeInTheDocument();
    expect(screen.queryByText("New session")).not.toBeInTheDocument();
    expect(screen.getAllByText("then")).toHaveLength(1);
    expect(screen.getByText("G").tagName).toBe("KBD");
    expect(screen.getByText("P").tagName).toBe("KBD");
  });

  it("can reveal unavailable commands", () => {
    render(
      <HotkeyHelpModal
        open
        onClose={vi.fn()}
        commands={[
          command("switchProject", true),
          command("newSession", false),
        ]}
      />,
    );

    fireEvent.click(screen.getByRole("radio", { name: "All commands" }));

    expect(screen.getByText("New session")).toBeInTheDocument();
    expect(screen.getByText("Unavailable here")).toBeInTheDocument();
  });

  it("includes prompt activation and readline-style editing bindings in the complete reference", () => {
    render(
      <HotkeyHelpModal
        open
        onClose={vi.fn()}
        commands={[command("switchProject", true)]}
      />,
    );

    fireEvent.click(screen.getByRole("radio", { name: "All commands" }));

    expect(
      screen.getByRole("heading", { name: "Prompt editing" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Activate one app shortcut")).toBeInTheDocument();
    expect(screen.getByText("Move to line start")).toBeInTheDocument();
    expect(screen.getByText("Delete next word")).toBeInTheDocument();
    expect(screen.getByLabelText("Ctrl ;")).toBeInTheDocument();
    expect(screen.getByLabelText("Alt D")).toBeInTheDocument();
  });
});
