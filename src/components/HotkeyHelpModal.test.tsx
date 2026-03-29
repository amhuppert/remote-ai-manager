// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";
import HotkeyHelpModal from "./HotkeyHelpModal";

describe("HotkeyHelpModal", () => {
  it("stops Escape propagation so other document-level listeners don't fire", () => {
    const onClose = vi.fn();
    render(<HotkeyHelpModal open={true} onClose={onClose} />);

    // Simulate what react-hotkeys-hook does: a bubble-phase document listener
    const bubbleListener = vi.fn();
    document.addEventListener("keydown", bubbleListener);

    const event = new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
    });
    document.dispatchEvent(event);

    expect(onClose).toHaveBeenCalledOnce();
    // The bubble-phase listener should NOT have been reached
    expect(bubbleListener).not.toHaveBeenCalled();

    document.removeEventListener("keydown", bubbleListener);
  });

  it("does not stop propagation for non-Escape keys", () => {
    const onClose = vi.fn();
    render(<HotkeyHelpModal open={true} onClose={onClose} />);

    const bubbleListener = vi.fn();
    document.addEventListener("keydown", bubbleListener);

    const event = new KeyboardEvent("keydown", {
      key: "a",
      bubbles: true,
    });
    document.dispatchEvent(event);

    expect(onClose).not.toHaveBeenCalled();
    expect(bubbleListener).toHaveBeenCalledOnce();

    document.removeEventListener("keydown", bubbleListener);
  });
});
