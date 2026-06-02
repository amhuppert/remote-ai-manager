// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, act } from "@testing-library/react";
import { useAppHotkey } from "./useAppHotkey";
import { _useOverlayScopeStore } from "@/stores/overlay-scope.store";

function pressB(): void {
  document.dispatchEvent(
    new KeyboardEvent("keydown", { key: "b", code: "KeyB", bubbles: true }),
  );
}

function setOverlayOpen(open: boolean): void {
  act(() => {
    _useOverlayScopeStore.setState({ openStack: open ? ["overlay"] : [] });
  });
}

function Harness({
  cb,
  keepActiveInOverlay,
}: {
  cb: () => void;
  keepActiveInOverlay?: boolean;
}): null {
  useAppHotkey("toggleSidebar", cb, { keepActiveInOverlay });
  return null;
}

describe("useAppHotkey overlay gating", () => {
  beforeEach(() => {
    _useOverlayScopeStore.setState({ openStack: [] });
  });

  it("fires the hotkey when no overlay is open", () => {
    const cb = vi.fn();
    render(<Harness cb={cb} />);
    pressB();
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("suppresses the hotkey while an overlay is open", () => {
    const cb = vi.fn();
    render(<Harness cb={cb} />);
    setOverlayOpen(true);
    pressB();
    expect(cb).not.toHaveBeenCalled();
  });

  it("keeps the hotkey active in an overlay when keepActiveInOverlay is set", () => {
    const cb = vi.fn();
    render(<Harness cb={cb} keepActiveInOverlay />);
    setOverlayOpen(true);
    pressB();
    expect(cb).toHaveBeenCalledTimes(1);
  });
});
