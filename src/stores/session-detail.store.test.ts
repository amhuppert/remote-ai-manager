import { describe, it, expect, beforeEach } from "vitest";
import {
  useSessionDetailStore,
  useSidebarFilter,
  useSidebarGroupBy,
  useSetSidebarFilter,
  useSetSidebarGroupBy,
  type SidebarGroupBy,
} from "./session-detail.store";

function resetStore() {
  useSessionDetailStore.getState().resetStore();
}

describe("session-detail.store — sidebar UI slice", () => {
  beforeEach(resetStore);

  it("has the expected defaults", () => {
    const s = useSessionDetailStore.getState();
    expect(s.sidebarFilter).toBe("");
    expect(s.sidebarGroupBy).toBe("project");
  });

  it("setSidebarFilter mutates only sidebarFilter", () => {
    const before = useSessionDetailStore.getState();
    useSessionDetailStore.getState().setSidebarFilter("auth");
    const after = useSessionDetailStore.getState();
    expect(after.sidebarFilter).toBe("auth");
    expect(after.sidebarGroupBy).toBe(before.sidebarGroupBy);
    expect(after.layout).toBe(before.layout);
    expect(after.sidebarCollapsed).toBe(before.sidebarCollapsed);
  });

  it("setSidebarGroupBy mutates only sidebarGroupBy", () => {
    const before = useSessionDetailStore.getState();
    useSessionDetailStore.getState().setSidebarGroupBy("project");
    const after = useSessionDetailStore.getState();
    expect(after.sidebarGroupBy).toBe("project");
    expect(after.sidebarFilter).toBe(before.sidebarFilter);
  });

  it("setSidebarGroupBy accepts all valid values", () => {
    const values: SidebarGroupBy[] = ["session", "project"];
    for (const v of values) {
      useSessionDetailStore.getState().setSidebarGroupBy(v);
      expect(useSessionDetailStore.getState().sidebarGroupBy).toBe(v);
    }
  });

  it("resetStore restores sidebar slice defaults", () => {
    const s = useSessionDetailStore.getState();
    s.setSidebarFilter("xyz");
    s.setSidebarGroupBy("session");

    s.resetStore();

    const after = useSessionDetailStore.getState();
    expect(after.sidebarFilter).toBe("");
    expect(after.sidebarGroupBy).toBe("project");
  });

  it("selector hooks expose sidebar slice fields", () => {
    expect(useSidebarFilter).toBeTypeOf("function");
    expect(useSidebarGroupBy).toBeTypeOf("function");
    expect(useSetSidebarFilter).toBeTypeOf("function");
    expect(useSetSidebarGroupBy).toBeTypeOf("function");
  });
});
