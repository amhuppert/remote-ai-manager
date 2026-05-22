import { describe, expect, it } from "vitest";
import {
  buildIntervalForest,
  computeExclusiveMs,
  computeTraceTimingSummary,
} from "./intervals";

describe("buildIntervalForest", () => {
  it("builds parent-child containment relationships", () => {
    const roots = buildIntervalForest([
      { id: "parent", name: "parent", startMs: 0, endMs: 100 },
      { id: "child", name: "child", startMs: 10, endMs: 30 },
    ]);

    expect(roots).toHaveLength(1);
    expect(roots[0]?.id).toBe("parent");
    expect(roots[0]?.children).toHaveLength(1);
    expect(roots[0]?.children[0]?.id).toBe("child");
  });

  it("keeps overlapping non-contained intervals as siblings", () => {
    const roots = buildIntervalForest([
      { id: "a", name: "a", startMs: 0, endMs: 50 },
      { id: "b", name: "b", startMs: 25, endMs: 75 },
    ]);

    expect(roots.map((root) => root.id)).toEqual(["a", "b"]);
  });
});

describe("computeExclusiveMs", () => {
  it("subtracts the union of child intervals from parent duration", () => {
    const roots = buildIntervalForest([
      { id: "parent", name: "parent", startMs: 0, endMs: 100 },
      { id: "child-a", name: "child-a", startMs: 10, endMs: 40 },
      { id: "child-b", name: "child-b", startMs: 30, endMs: 60 },
    ]);

    expect(computeExclusiveMs(roots[0]!)).toBe(50);
  });
});

describe("computeTraceTimingSummary", () => {
  it("computes unexplained request time from root interval union", () => {
    const roots = buildIntervalForest([
      { id: "a", name: "a", startMs: 0, endMs: 50 },
      { id: "b", name: "b", startMs: 40, endMs: 80 },
    ]);

    expect(computeTraceTimingSummary(120, roots)).toEqual({
      requestDurationMs: 120,
      rootUnionMs: 80,
      unexplainedMs: 40,
      unexplainedPercent: 33.33333333333333,
    });
  });
});
