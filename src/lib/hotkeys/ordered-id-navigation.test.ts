import { describe, expect, it } from "vitest";
import {
  getAdjacentOrderedId,
  getOrderedIdForShortcut,
} from "./ordered-id-navigation";

describe("getOrderedIdForShortcut", () => {
  const ids = ["alpha", "beta", "gamma"];

  it("maps shortcut digits 1 through 9 to zero-based ordered positions", () => {
    expect(getOrderedIdForShortcut(ids, "1")).toBe("alpha");
    expect(getOrderedIdForShortcut(ids, "3")).toBe("gamma");
  });

  it("returns null for an unoccupied or invalid shortcut position", () => {
    expect(getOrderedIdForShortcut(ids, "4")).toBeNull();
    expect(getOrderedIdForShortcut(ids, "0")).toBeNull();
    expect(getOrderedIdForShortcut(ids, "x")).toBeNull();
  });
});

describe("getAdjacentOrderedId", () => {
  const ids = ["alpha", "beta", "gamma"];

  it("moves forward and backward from the active id", () => {
    expect(getAdjacentOrderedId(ids, "beta", "next")).toBe("gamma");
    expect(getAdjacentOrderedId(ids, "beta", "previous")).toBe("alpha");
  });

  it("wraps at both ends of the ordered set", () => {
    expect(getAdjacentOrderedId(ids, "gamma", "next")).toBe("alpha");
    expect(getAdjacentOrderedId(ids, "alpha", "previous")).toBe("gamma");
  });

  it("selects a directional edge when the active id is unavailable", () => {
    expect(getAdjacentOrderedId(ids, null, "next")).toBe("alpha");
    expect(getAdjacentOrderedId(ids, "missing", "previous")).toBe("gamma");
  });

  it("returns null for an empty set", () => {
    expect(getAdjacentOrderedId([], "alpha", "next")).toBeNull();
  });
});
