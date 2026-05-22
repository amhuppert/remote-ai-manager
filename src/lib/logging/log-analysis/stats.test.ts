import { describe, expect, it } from "vitest";
import { clampTop, nearestRankQuantile, summarizeNumbers } from "./stats";

describe("nearestRankQuantile", () => {
  it("calculates nearest-rank p50, p95, and p99", () => {
    const values = [5, 1, 100, 10, 20];

    expect(nearestRankQuantile(values, 0.5)).toBe(10);
    expect(nearestRankQuantile(values, 0.95)).toBe(100);
    expect(nearestRankQuantile(values, 0.99)).toBe(100);
  });

  it("returns null for empty arrays", () => {
    expect(nearestRankQuantile([], 0.95)).toBeNull();
  });
});

describe("summarizeNumbers", () => {
  it("returns common latency summary metrics", () => {
    expect(summarizeNumbers([1, 2, 3, 4])).toEqual({
      count: 4,
      total: 10,
      avg: 2.5,
      p50: 2,
      p95: 4,
      p99: 4,
      max: 4,
    });
  });

  it("returns null metrics for empty arrays", () => {
    expect(summarizeNumbers([])).toEqual({
      count: 0,
      total: 0,
      avg: null,
      p50: null,
      p95: null,
      p99: null,
      max: null,
    });
  });
});

describe("clampTop", () => {
  it("clamps top values to the supported range", () => {
    expect(clampTop(-1)).toBe(1);
    expect(clampTop(0)).toBe(1);
    expect(clampTop(10)).toBe(10);
    expect(clampTop(100)).toBe(50);
  });
});
