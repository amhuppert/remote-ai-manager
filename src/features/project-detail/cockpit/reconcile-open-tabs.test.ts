import { describe, it, expect } from "vitest";
import { reconcileOpenTabs } from "./reconcile-open-tabs";

describe("reconcileOpenTabs", () => {
  it("keeps the active tab when it is still open", () => {
    const result = reconcileOpenTabs(["a", "b"], {
      openTabIds: ["a", "b"],
      activeTabId: "b",
    });
    expect(result).toEqual({
      openTabIds: ["a", "b"],
      activeTabId: "b",
      firstRun: false,
    });
  });

  it("picks a fallback when the active tab was closed", () => {
    const result = reconcileOpenTabs(["a", "c"], {
      openTabIds: ["a", "b", "c"],
      activeTabId: "b",
    });
    expect(result.openTabIds).toEqual(["a", "c"]);
    expect(result.activeTabId).toBe("a");
    expect(result.firstRun).toBe(false);
  });

  it("signals first-run when no open conversations remain", () => {
    const result = reconcileOpenTabs([], {
      openTabIds: ["a"],
      activeTabId: "a",
    });
    expect(result).toEqual({
      openTabIds: [],
      activeTabId: null,
      firstRun: true,
    });
  });

  it("appends newly-open conversations after existing tabs", () => {
    const result = reconcileOpenTabs(["a", "b", "c"], {
      openTabIds: ["a"],
      activeTabId: "a",
    });
    expect(result.openTabIds).toEqual(["a", "b", "c"]);
    expect(result.activeTabId).toBe("a");
  });

  it("preserves existing tab order and appends new ids in server order", () => {
    const result = reconcileOpenTabs(["c", "a", "b"], {
      openTabIds: ["a", "b"],
      activeTabId: "a",
    });
    // existing [a, b] keep their order; new [c] appended.
    expect(result.openTabIds).toEqual(["a", "b", "c"]);
    expect(result.activeTabId).toBe("a");
  });

  it("activates the first open tab when there was no active tab", () => {
    const result = reconcileOpenTabs(["x", "y"], {
      openTabIds: [],
      activeTabId: null,
    });
    expect(result.openTabIds).toEqual(["x", "y"]);
    expect(result.activeTabId).toBe("x");
    expect(result.firstRun).toBe(false);
  });
});
