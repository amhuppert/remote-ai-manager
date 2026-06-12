import { describe, it, expect, beforeEach } from "vitest";
import { _useCockpitViewStore } from "./use-cockpit-view-state";

function store() {
  return _useCockpitViewStore.getState();
}

describe("use-cockpit-view-state", () => {
  beforeEach(() => {
    store()._reset();
  });

  it("reconciles newly-open tabs and sets entering on the zero→non-zero crossing", () => {
    expect(store().entering).toBe(false);
    store().reconcileTabs(["a", "b"]);
    expect(store().openTabIds).toEqual(["a", "b"]);
    expect(store().activeTabId).toBe("a");
    expect(store().workspaceView).toBe("sessions");
    expect(store().entering).toBe(true);
  });

  it("does not re-trigger entering when more tabs open while some are already open", () => {
    store().reconcileTabs(["a"]);
    store().clearEntering();
    store().reconcileTabs(["a", "b"]);
    expect(store().entering).toBe(false);
    expect(store().openTabIds).toEqual(["a", "b"]);
  });

  it("returns to first-run (no active tab, entering cleared) when all tabs close", () => {
    store().reconcileTabs(["a"]);
    store().reconcileTabs([]);
    expect(store().openTabIds).toEqual([]);
    expect(store().activeTabId).toBeNull();
    expect(store().entering).toBe(false);
  });

  it("setActiveTab changes the active tab", () => {
    store().reconcileTabs(["a", "b"]);
    store().setActiveTab("b");
    expect(store().activeTabId).toBe("b");
    expect(store().workspaceView).toBe("conversations");
  });

  it("focusTab appends an untracked tab and focuses it (reopen path)", () => {
    store().reconcileTabs(["a"]);
    store().focusTab("z");
    expect(store().openTabIds).toEqual(["a", "z"]);
    expect(store().activeTabId).toBe("z");
    expect(store().workspaceView).toBe("conversations");
  });

  it("focusTab focuses an already-open tab without duplicating it", () => {
    store().reconcileTabs(["a", "b"]);
    store().focusTab("b");
    expect(store().openTabIds).toEqual(["a", "b"]);
    expect(store().activeTabId).toBe("b");
  });

  it("toggleRail flips rail-collapsed", () => {
    expect(store().railCollapsed).toBe(false);
    store().toggleRail();
    expect(store().railCollapsed).toBe(true);
    store().toggleRail();
    expect(store().railCollapsed).toBe(false);
  });

  it("sets the workspace view explicitly", () => {
    expect(store().workspaceView).toBe("sessions");
    store().setWorkspaceView("conversations");
    expect(store().workspaceView).toBe("conversations");
    store().setWorkspaceView("sessions");
    expect(store().workspaceView).toBe("sessions");
  });
});
