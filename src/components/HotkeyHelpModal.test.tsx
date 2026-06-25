// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import HotkeyHelpModal from "./HotkeyHelpModal";

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
});
