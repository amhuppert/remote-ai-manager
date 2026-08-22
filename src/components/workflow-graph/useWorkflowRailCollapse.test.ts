// @vitest-environment jsdom
import { renderHook, act } from "@testing-library/react";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { useWorkflowRailCollapse } from "./useWorkflowRailCollapse";

/**
 * A viewport the test can resize. `matchMedia` is answered per query string,
 * which is what the rail ladder needs: 900px matches the 1100px rule but not
 * the 768px one, and the two answers drive different behaviour.
 */
function installViewport(initialWidth: number) {
  let width = initialWidth;
  const listeners = new Map<string, Set<(e: MediaQueryListEvent) => void>>();
  const limitOf = (query: string): number =>
    Number(/max-width:\s*(\d+)px/.exec(query)?.[1] ?? 0);

  vi.spyOn(window, "matchMedia").mockImplementation((query: string) => {
    return {
      get matches() {
        return width <= limitOf(query);
      },
      media: query,
      addEventListener: (_: string, cb: (e: MediaQueryListEvent) => void) => {
        const set = listeners.get(query) ?? new Set();
        set.add(cb);
        listeners.set(query, set);
      },
      removeEventListener: (
        _: string,
        cb: (e: MediaQueryListEvent) => void,
      ) => {
        listeners.get(query)?.delete(cb);
      },
    } as unknown as MediaQueryList;
  });

  return {
    resize(next: number) {
      width = next;
      act(() => {
        for (const [query, set] of listeners) {
          for (const cb of set) {
            cb({ matches: next <= limitOf(query) } as MediaQueryListEvent);
          }
        }
      });
    },
  };
}

describe("useWorkflowRailCollapse", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("leaves the rail expanded above 1100px", () => {
    installViewport(1280);
    const { result } = renderHook(() => useWorkflowRailCollapse());
    expect(result.current.collapsed).toBe(false);
    expect(result.current.overlay).toBe(false);
  });

  it("collapses the rail to a strip at 1100px and below", () => {
    installViewport(900);
    const { result } = renderHook(() => useWorkflowRailCollapse());
    expect(result.current.collapsed).toBe(true);
  });

  it("collapses when the viewport crosses below 1100px and restores above it", () => {
    const viewport = installViewport(1280);
    const { result } = renderHook(() => useWorkflowRailCollapse());
    expect(result.current.collapsed).toBe(false);

    viewport.resize(1000);
    expect(result.current.collapsed).toBe(true);

    viewport.resize(1280);
    expect(result.current.collapsed).toBe(false);
  });

  it("remembers each width regime's own choice", () => {
    const viewport = installViewport(1280);
    const { result } = renderHook(() => useWorkflowRailCollapse());

    act(() => result.current.setCollapsed(true));
    expect(result.current.collapsed).toBe(true);

    // Expanding at a narrow width says nothing about the wide layout.
    viewport.resize(900);
    act(() => result.current.setCollapsed(false));
    expect(result.current.collapsed).toBe(false);

    viewport.resize(1280);
    expect(result.current.collapsed).toBe(true);
  });

  it("floats an expanded rail over the canvas only between 769px and 1100px", () => {
    const viewport = installViewport(900);
    const { result } = renderHook(() => useWorkflowRailCollapse());
    expect(result.current.overlay).toBe(false);

    act(() => result.current.setCollapsed(false));
    expect(result.current.overlay).toBe(true);

    // At the mobile breakpoint the rail IS the panel, so it never floats.
    viewport.resize(768);
    expect(result.current.overlay).toBe(false);
  });

  it("never reports the rail collapsed at the mobile breakpoint", () => {
    installViewport(390);
    const { result } = renderHook(() => useWorkflowRailCollapse());
    expect(result.current.collapsed).toBe(false);
  });

  it("puts the collapse boundary at 1100px inclusive", () => {
    const viewport = installViewport(1101);
    const { result } = renderHook(() => useWorkflowRailCollapse());
    expect(result.current.collapsed).toBe(false);

    viewport.resize(1100);
    expect(result.current.collapsed).toBe(true);
  });

  it("puts the mobile boundary at 768px inclusive", () => {
    const viewport = installViewport(769);
    const { result } = renderHook(() => useWorkflowRailCollapse());
    act(() => result.current.setCollapsed(false));
    expect(result.current.overlay).toBe(true);

    viewport.resize(768);
    expect(result.current.overlay).toBe(false);
    expect(result.current.collapsed).toBe(false);
  });
});
