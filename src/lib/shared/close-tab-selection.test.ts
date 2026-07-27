import { describe, expect, it } from "vitest";
import { closeTabSelection } from "./close-tab-selection";

describe("closeTabSelection", () => {
  it("selects the previous tab when closing a middle tab", () => {
    expect(closeTabSelection(["a", "b", "c"], "b")).toBe("a");
  });

  it("selects the previous tab when closing the last tab", () => {
    expect(closeTabSelection(["a", "b", "c"], "c")).toBe("b");
  });

  it("selects the next tab when the first tab has no previous neighbor", () => {
    expect(closeTabSelection(["a", "b", "c"], "a")).toBe("b");
  });

  it("returns null when closing the only tab", () => {
    expect(closeTabSelection(["a"], "a")).toBeNull();
  });

  it("returns null when the closing tab is not in the ordered set", () => {
    expect(closeTabSelection(["a", "b"], "missing")).toBeNull();
  });

  it("returns null for an empty ordered set", () => {
    expect(closeTabSelection([], "a")).toBeNull();
  });

  it("does not mutate the ordered tab set", () => {
    const tabs = ["a", "b", "c"];

    closeTabSelection(tabs, "b");

    expect(tabs).toEqual(["a", "b", "c"]);
  });
});
