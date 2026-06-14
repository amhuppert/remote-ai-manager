// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import type { LayoutMode } from "@/lib/sessions/schemas";
import { useSessionDetailStore } from "./session-detail.store";

function getState() {
  return useSessionDetailStore.getState();
}

// The store's reset default for `layout`. Captured (not hardcoded) so these
// tests pin round-trip validation behavior, not the specific default value.
let defaultLayout: LayoutMode;

beforeEach(() => {
  getState().resetStore();
  defaultLayout = getState().layout;
  localStorage.clear();
});

describe("session-detail.store — layout persistence round-trip (jsdom)", () => {
  it("persists and re-hydrates the panes layout (3.1)", () => {
    getState().switchLayout("panes", "cc-test-layout");
    expect(getState().layout).toBe("panes");
    expect(localStorage.getItem("cc-test-layout")).toBe("panes");

    getState().resetStore();
    expect(getState().layout).toBe(defaultLayout);

    getState().hydrateLayout("cc-test-layout");
    expect(getState().layout).toBe("panes");
  });

  it("re-hydrates each existing layout unchanged (regression)", () => {
    const existing: LayoutMode[] = ["conversation", "default", "split", "diff"];
    for (const layout of existing) {
      getState().switchLayout(layout, "cc-test-layout");
      expect(localStorage.getItem("cc-test-layout")).toBe(layout);

      getState().resetStore();
      expect(getState().layout).toBe(defaultLayout);

      getState().hydrateLayout("cc-test-layout");
      expect(getState().layout).toBe(layout);
    }
  });

  it("rejects an unknown persisted layout value", () => {
    localStorage.setItem("cc-test-layout2", "garbage");

    getState().hydrateLayout("cc-test-layout2");

    expect(getState().layout).toBe(defaultLayout);
  });
});
