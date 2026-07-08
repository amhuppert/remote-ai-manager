import { describe, expect, it } from "vitest";
import { deepEqualJson } from "./deep-equal";

describe("deepEqualJson", () => {
  it("compares primitives by value", () => {
    expect(deepEqualJson(1, 1)).toBe(true);
    expect(deepEqualJson("a", "a")).toBe(true);
    expect(deepEqualJson(true, true)).toBe(true);
    expect(deepEqualJson(null, null)).toBe(true);
    expect(deepEqualJson(undefined, undefined)).toBe(true);
    expect(deepEqualJson(1, 2)).toBe(false);
    expect(deepEqualJson("a", "b")).toBe(false);
    expect(deepEqualJson(null, undefined)).toBe(false);
    expect(deepEqualJson(0, "0")).toBe(false);
  });

  it("compares nested plain objects structurally, ignoring key order", () => {
    expect(deepEqualJson({ a: 1, b: { c: 2 } }, { b: { c: 2 }, a: 1 })).toBe(
      true,
    );
    expect(deepEqualJson({ a: 1, b: { c: 2 } }, { a: 1, b: { c: 3 } })).toBe(
      false,
    );
  });

  it("distinguishes a present-but-undefined key from a missing key", () => {
    // Mirrors node:util isDeepStrictEqual: own-enumerable key counts differ.
    expect(deepEqualJson({ a: undefined }, {})).toBe(false);
  });

  it("compares arrays element-wise and length-sensitively", () => {
    expect(deepEqualJson([1, 2, 3], [1, 2, 3])).toBe(true);
    expect(deepEqualJson([1, 2], [1, 2, 3])).toBe(false);
    expect(deepEqualJson([{ a: 1 }], [{ a: 1 }])).toBe(true);
    // An array and an object with the same numeric keys are not equal.
    expect(deepEqualJson([1], { 0: 1 })).toBe(false);
  });

  it("matches a realistic context-state snapshot round-trip", () => {
    const base = {
      contextId: "ctx-1",
      status: "pending",
      totalTaskCount: 1,
      completedTaskCount: 0,
      iterationCount: 0,
      worktreePath: null,
      laneId: null,
      failureHistory: [],
      pendingApproval: null,
    };
    expect(deepEqualJson(base, { ...base })).toBe(true);
    expect(deepEqualJson(base, { ...base, iterationCount: 1 })).toBe(false);
    expect(deepEqualJson(base, { ...base, laneId: "lane-1" })).toBe(false);
  });
});
