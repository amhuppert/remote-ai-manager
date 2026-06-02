// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { useOverlayScope } from "./useOverlayScope";
import {
  _useOverlayScopeStore,
  isOverlayOpen,
} from "@/stores/overlay-scope.store";

function pressEscape(): void {
  document.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
  );
}

describe("useOverlayScope", () => {
  beforeEach(() => {
    _useOverlayScopeStore.setState({ openStack: [] });
  });

  it("registers the overlay while open and clears it on close", () => {
    const { rerender } = renderHook(({ open }) => useOverlayScope(open), {
      initialProps: { open: true },
    });
    expect(isOverlayOpen()).toBe(true);
    rerender({ open: false });
    expect(isOverlayOpen()).toBe(false);
  });

  it("clears the overlay on unmount while open", () => {
    const { unmount } = renderHook(() => useOverlayScope(true));
    expect(isOverlayOpen()).toBe(true);
    unmount();
    expect(isOverlayOpen()).toBe(false);
  });

  it("invokes onEscape when open and Escape is pressed", () => {
    const onEscape = vi.fn();
    renderHook(() => useOverlayScope(true, { onEscape }));
    pressEscape();
    expect(onEscape).toHaveBeenCalledTimes(1);
  });

  it("does not invoke onEscape when closed", () => {
    const onEscape = vi.fn();
    renderHook(() => useOverlayScope(false, { onEscape }));
    pressEscape();
    expect(onEscape).not.toHaveBeenCalled();
  });

  it("only the topmost overlay handles Escape", () => {
    const first = vi.fn();
    const second = vi.fn();
    renderHook(() => {
      useOverlayScope(true, { onEscape: first });
      useOverlayScope(true, { onEscape: second });
    });
    pressEscape();
    expect(second).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
  });
});
