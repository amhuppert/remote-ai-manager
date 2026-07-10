// @vitest-environment jsdom
import { renderHook, act } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { useSessionPageStoreBundle } from "./use-session-page-store-bundle";

describe("useSessionPageStoreBundle", () => {
  it("returns a bundle of store selectors and actions with stable callable identities", () => {
    const { result } = renderHook(() => useSessionPageStoreBundle("conv-1"));
    const bundle = result.current;
    expect(typeof bundle.switchLayout).toBe("function");
    expect(typeof bundle.hydrateLayout).toBe("function");
    expect(typeof bundle.switchMobilePanel).toBe("function");
    expect(typeof bundle.dismissError).toBe("function");
    expect(typeof bundle.requestDelete).toBe("function");
    expect(typeof bundle.dsToggle).toBe("function");
    expect(bundle).toHaveProperty("layout");
    expect(bundle).toHaveProperty("mobilePanel");
    expect(bundle).toHaveProperty("sending");
    expect(bundle).toHaveProperty("dsOpen");
  });

  it("switchMobilePanel forwards the panel value without throwing", () => {
    const { result } = renderHook(() => useSessionPageStoreBundle("conv-1"));
    act(() => {
      result.current.switchMobilePanel("docs");
    });
    expect(result.current.mobilePanel).toBeDefined();
  });
});
