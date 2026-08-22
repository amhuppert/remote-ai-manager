// @vitest-environment jsdom
import { createElement } from "react";
import { renderHook, act } from "@testing-library/react";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { useWorkflowMobilePanel } from "./useWorkflowMobilePanel";

function createMatchMediaMock(matches: boolean) {
  const listeners: Array<(e: MediaQueryListEvent) => void> = [];
  // A real MediaQueryList updates `matches` before it notifies, so a subscriber
  // that re-reads the list — rather than trusting the event — sees the new
  // value. A fake with a frozen `matches` would hide that.
  const state = { matches };
  return {
    mock: {
      get matches() {
        return state.matches;
      },
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
      state.matches = newMatches;
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

  // The page mounts the bottom tab bar behind `isMobile`, so a mobile-width
  // client render that disagrees with the server's HTML throws the whole
  // subtree away and re-renders it. The viewport is external state: the server
  // has no snapshot of it, so the first client render has to agree with the
  // server and correct itself afterwards.
  it("hydrates server markup at a mobile width without a mismatch", async () => {
    function Probe(): React.ReactElement {
      const { isMobile } = useWorkflowMobilePanel<"graph" | "inspector">(
        "graph",
      );
      return createElement(
        "nav",
        { "data-mobile": String(isMobile) },
        isMobile ? "tabs" : null,
      );
    }

    // The server has no viewport, so its markup is always the non-mobile
    // shape — jsdom keeps `window` around during `renderToString`, so the
    // absent viewport is modelled by the query not matching.
    const serverMql = createMatchMediaMock(false);
    const matchMedia = vi
      .spyOn(window, "matchMedia")
      .mockReturnValue(serverMql.mock);
    const container = document.createElement("div");
    document.body.appendChild(container);
    container.innerHTML = renderToString(createElement(Probe));

    // …and then the real client, on a 390px phone.
    const clientMql = createMatchMediaMock(true);
    matchMedia.mockReturnValue(clientMql.mock);

    const errors: unknown[][] = [];
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation((...args: unknown[]) => {
        errors.push(args);
      });

    await act(async () => {
      hydrateRoot(container, createElement(Probe));
    });

    consoleError.mockRestore();
    expect(
      errors.filter((entry) => String(entry[0]).includes("Hydration")),
    ).toEqual([]);
    // …and the corrected render still reaches the mobile shape.
    expect(container.querySelector("nav")).toHaveAttribute(
      "data-mobile",
      "true",
    );
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
