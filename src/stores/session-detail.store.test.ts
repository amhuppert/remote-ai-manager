import { describe, it, expect, beforeEach } from "vitest";
import {
  useSessionDetailStore,
  useSidebarFilter,
  useSetSidebarFilter,
} from "./session-detail.store";

function resetStore() {
  useSessionDetailStore.getState().resetStore();
}

describe("session-detail.store — sidebar UI slice", () => {
  beforeEach(resetStore);

  it("has the expected defaults", () => {
    const s = useSessionDetailStore.getState();
    expect(s.sidebarFilter).toBe("");
  });

  it("setSidebarFilter mutates only sidebarFilter", () => {
    const before = useSessionDetailStore.getState();
    useSessionDetailStore.getState().setSidebarFilter("auth");
    const after = useSessionDetailStore.getState();
    expect(after.sidebarFilter).toBe("auth");
    expect(after.layout).toBe(before.layout);
    expect(after.sidebarCollapsed).toBe(before.sidebarCollapsed);
  });

  it("resetStore restores sidebar slice defaults", () => {
    const s = useSessionDetailStore.getState();
    s.setSidebarFilter("xyz");

    s.resetStore();

    const after = useSessionDetailStore.getState();
    expect(after.sidebarFilter).toBe("");
  });

  it("selector hooks expose sidebar slice fields", () => {
    expect(useSidebarFilter).toBeTypeOf("function");
    expect(useSetSidebarFilter).toBeTypeOf("function");
  });
});
