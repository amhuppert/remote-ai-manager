// @vitest-environment jsdom
import { renderHook, act } from "@testing-library/react";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { useWorkflowMobilePanel } from "./useWorkflowMobilePanel";

function createMatchMediaMock(matches: boolean) {
  const listeners: Array<(e: MediaQueryListEvent) => void> = [];
  return {
    mock: {
      matches,
      media: "(max-width: 768px)",
      addEventListener: (_: string, cb: (e: MediaQueryListEvent) => void) => {
        listeners.push(cb);
      },
      removeEventListener: (
        _: string,
        cb: (e: MediaQueryListEvent) => void,
      ) => {
        const idx = listeners.indexOf(cb);
        if (idx >= 0) listeners.splice(idx, 1);
      },
    } as unknown as MediaQueryList,
    fireChange(newMatches: boolean) {
      for (const cb of listeners) {
        cb({ matches: newMatches } as MediaQueryListEvent);
      }
    },
  };
}

describe("useWorkflowMobilePanel", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("returns the provided default panel", () => {
    const mql = createMatchMediaMock(false);
    vi.spyOn(window, "matchMedia").mockReturnValue(mql.mock);

    const { result } = renderHook(() =>
      useWorkflowMobilePanel<"graph" | "inspector">("graph"),
    );
    expect(result.current.mobilePanel).toBe("graph");
  });

  it("reports isMobile=true when matchMedia matches", () => {
    const mql = createMatchMediaMock(true);
    vi.spyOn(window, "matchMedia").mockReturnValue(mql.mock);

    const { result } = renderHook(() =>
      useWorkflowMobilePanel<"graph" | "inspector">("graph"),
    );
    expect(result.current.isMobile).toBe(true);
  });

  it("reports isMobile=false when matchMedia does not match", () => {
    const mql = createMatchMediaMock(false);
    vi.spyOn(window, "matchMedia").mockReturnValue(mql.mock);

    const { result } = renderHook(() =>
      useWorkflowMobilePanel<"graph" | "inspector">("graph"),
    );
    expect(result.current.isMobile).toBe(false);
  });

  it("updates isMobile when matchMedia changes", () => {
    const mql = createMatchMediaMock(false);
    vi.spyOn(window, "matchMedia").mockReturnValue(mql.mock);

    const { result } = renderHook(() =>
      useWorkflowMobilePanel<"graph" | "inspector">("graph"),
    );
    expect(result.current.isMobile).toBe(false);

    act(() => {
      mql.fireChange(true);
    });
    expect(result.current.isMobile).toBe(true);
  });

  it("setMobilePanel always updates the panel", () => {
    const mql = createMatchMediaMock(false);
    vi.spyOn(window, "matchMedia").mockReturnValue(mql.mock);

    const { result } = renderHook(() =>
      useWorkflowMobilePanel<"graph" | "inspector">("graph"),
    );

    act(() => {
      result.current.setMobilePanel("inspector");
    });
    expect(result.current.mobilePanel).toBe("inspector");
  });

  it("autoSwitchPanel updates only when mobile", () => {
    const mql = createMatchMediaMock(false);
    vi.spyOn(window, "matchMedia").mockReturnValue(mql.mock);

    const { result } = renderHook(() =>
      useWorkflowMobilePanel<"graph" | "inspector">("graph"),
    );

    // On desktop, autoSwitchPanel is a no-op
    act(() => {
      result.current.autoSwitchPanel("inspector");
    });
    expect(result.current.mobilePanel).toBe("graph");

    // Switch to mobile
    act(() => {
      mql.fireChange(true);
    });

    // Now autoSwitchPanel should work
    act(() => {
      result.current.autoSwitchPanel("inspector");
    });
    expect(result.current.mobilePanel).toBe("inspector");
  });
});
