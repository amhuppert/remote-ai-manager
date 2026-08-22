// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { usePanelBackGesture } from "./usePanelBackGesture";

/**
 * jsdom's session history does not run `go()`, so the entries the panel owns
 * are counted here instead: what the hook is answerable for is pushing exactly
 * one entry per drill level, unwinding exactly the ones it pushed, and treating
 * a pop as one level back — never two, and never one it does not own.
 */
function historySpies() {
  const pushState = vi.spyOn(window.history, "pushState");
  const go = vi.spyOn(window.history, "go").mockImplementation(() => {});
  return { pushState, go };
}

let spies: ReturnType<typeof historySpies>;

beforeEach(() => {
  spies = historySpies();
});

afterEach(() => {
  vi.restoreAllMocks();
});

function pop() {
  act(() => {
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
}

describe("usePanelBackGesture", () => {
  it("pushes one history entry per drill level", () => {
    const onBack = vi.fn();
    const { rerender } = renderHook(
      ({ depth }: { depth: number }) =>
        usePanelBackGesture({ enabled: true, depth, onBack }),
      { initialProps: { depth: 0 } },
    );

    expect(spies.pushState).not.toHaveBeenCalled();

    rerender({ depth: 1 });
    expect(spies.pushState).toHaveBeenCalledTimes(1);

    rerender({ depth: 2 });
    expect(spies.pushState).toHaveBeenCalledTimes(2);
  });

  it("keeps the URL the panel was opened at", () => {
    const before = window.location.href;
    const { rerender } = renderHook(
      ({ depth }: { depth: number }) =>
        usePanelBackGesture({ enabled: true, depth, onBack: vi.fn() }),
      { initialProps: { depth: 0 } },
    );

    rerender({ depth: 1 });

    expect(spies.pushState.mock.calls[0]?.[2]).toBe(before);
  });

  it("pops exactly one level per back gesture", () => {
    const onBack = vi.fn();
    const { rerender } = renderHook(
      ({ depth }: { depth: number }) =>
        usePanelBackGesture({ enabled: true, depth, onBack }),
      { initialProps: { depth: 0 } },
    );
    rerender({ depth: 1 });
    rerender({ depth: 2 });

    pop();

    expect(onBack).toHaveBeenCalledTimes(1);
  });

  // Two entries pushed, two gestures, two levels — the panel must not swallow
  // the gesture that should finally leave the page.
  it("stops answering once its own entries are spent", () => {
    const onBack = vi.fn();
    const { rerender } = renderHook(
      ({ depth }: { depth: number }) =>
        usePanelBackGesture({ enabled: true, depth, onBack }),
      { initialProps: { depth: 0 } },
    );
    rerender({ depth: 1 });

    pop();
    rerender({ depth: 0 });
    pop();

    expect(onBack).toHaveBeenCalledTimes(1);
  });

  // The back row lowers the depth itself, so the entry it left behind has to go
  // with it — otherwise the next gesture would be a press that does nothing.
  it("unwinds the entries a back row already stepped out of", () => {
    const { rerender } = renderHook(
      ({ depth }: { depth: number }) =>
        usePanelBackGesture({ enabled: true, depth, onBack: vi.fn() }),
      { initialProps: { depth: 0 } },
    );
    rerender({ depth: 2 });

    rerender({ depth: 1 });
    expect(spies.go).toHaveBeenCalledWith(-1);

    // A scope switch drops the whole stack at once.
    rerender({ depth: 0 });
    expect(spies.go).toHaveBeenLastCalledWith(-1);
  });

  // `go(-n)` is one traversal and fires one `popstate`, however many entries it
  // skips. Counting the entries instead would leave a pop owed forever, and the
  // next real gesture would pay it off instead of stepping back a level.
  it("owes exactly one pop for a multi-level release", () => {
    const onBack = vi.fn();
    const { rerender } = renderHook(
      ({ enabled, depth }: { enabled: boolean; depth: number }) =>
        usePanelBackGesture({ enabled, depth, onBack }),
      { initialProps: { enabled: true, depth: 0 } },
    );
    rerender({ enabled: true, depth: 2 });

    // The panel leaves the screen, handing back both entries at once.
    rerender({ enabled: false, depth: 2 });
    expect(spies.go).toHaveBeenCalledWith(-2);
    pop();

    // It comes back and re-pushes its levels, then a real gesture arrives.
    rerender({ enabled: true, depth: 2 });
    pop();

    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it("does not answer a gesture it caused itself", () => {
    const onBack = vi.fn();
    const { rerender } = renderHook(
      ({ depth }: { depth: number }) =>
        usePanelBackGesture({ enabled: true, depth, onBack }),
      { initialProps: { depth: 0 } },
    );
    rerender({ depth: 1 });
    rerender({ depth: 0 });

    // `go(-1)` would fire this in a real browser.
    pop();

    expect(onBack).not.toHaveBeenCalled();
  });

  // Above the breakpoint the drill is a rail, not the whole screen, and the
  // back button belongs to the app's routes.
  it("leaves history alone above the breakpoint", () => {
    const onBack = vi.fn();
    const { rerender } = renderHook(
      ({ depth }: { depth: number }) =>
        usePanelBackGesture({ enabled: false, depth, onBack }),
      { initialProps: { depth: 0 } },
    );
    rerender({ depth: 2 });

    expect(spies.pushState).not.toHaveBeenCalled();
    pop();
    expect(onBack).not.toHaveBeenCalled();
  });
});
