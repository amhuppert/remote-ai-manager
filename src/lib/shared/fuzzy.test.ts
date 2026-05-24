import { describe, it, expect } from "vitest";
import { fuzzyMatch, compareFuzzyResults } from "./fuzzy";

describe("fuzzyMatch", () => {
  it("returns match with prefix tier for empty query", () => {
    const result = fuzzyMatch("", "anything");
    expect(result).toEqual({
      match: true,
      tier: "prefix",
      coverage: 0,
      indices: [],
    });
  });

  it("returns prefix tier when query matches start of target", () => {
    const result = fuzzyMatch("hel", "help");
    expect(result.match).toBe(true);
    expect(result.tier).toBe("prefix");
    expect(result.indices).toEqual([0, 1, 2]);
    expect(result.coverage).toBeCloseTo(3 / 4);
  });

  it("returns substring tier when query matches non-prefix position", () => {
    const result = fuzzyMatch("ear", "clear");
    expect(result.match).toBe(true);
    expect(result.tier).toBe("substring");
    expect(result.indices).toEqual([2, 3, 4]);
    expect(result.coverage).toBeCloseTo(3 / 5);
  });

  it("does not match non-consecutive characters", () => {
    const result = fuzzyMatch("hp", "help");
    expect(result).toEqual({
      match: false,
      tier: null,
      coverage: 0,
      indices: [],
    });
  });

  it("matches case-insensitively", () => {
    const result = fuzzyMatch("HELP", "help");
    expect(result.match).toBe(true);
    expect(result.tier).toBe("prefix");
  });

  it("strips special characters from both query and target", () => {
    // "srclib" matches "src/lib/fuzzy.ts" stripped to "srclibfuzzyts" as prefix
    const result = fuzzyMatch("srclib", "src/lib/fuzzy.ts");
    expect(result.match).toBe(true);
    expect(result.tier).toBe("prefix");
    // Indices map back to original target positions
    expect(result.indices).toEqual([0, 1, 2, 4, 5, 6]);
  });

  it("strips special characters from query too", () => {
    // "src/lib" stripped to "srclib" matches "src/lib/fuzzy.ts" stripped to "srclibfuzzyts"
    const result = fuzzyMatch("src/lib", "src/lib/fuzzy.ts");
    expect(result.match).toBe(true);
    expect(result.tier).toBe("prefix");
    expect(result.indices).toEqual([0, 1, 2, 4, 5, 6]);
  });

  it("computes coverage as stripped query length / stripped target length", () => {
    // "com" (3 chars) against "commit" (6 stripped chars)
    const result = fuzzyMatch("com", "commit");
    expect(result.coverage).toBeCloseTo(3 / 6);
  });

  it("computes coverage correctly when target has special chars", () => {
    // "fuzzy" (5 chars) against "src/lib/fuzzy.ts" (stripped: "srclibfuzzyts" = 13 chars)
    const result = fuzzyMatch("fuzzy", "src/lib/fuzzy.ts");
    expect(result.coverage).toBeCloseTo(5 / 13);
  });

  it("returns no match when query has chars not in target", () => {
    const result = fuzzyMatch("xyz", "help");
    expect(result).toEqual({
      match: false,
      tier: null,
      coverage: 0,
      indices: [],
    });
  });

  it("handles query longer than target", () => {
    const result = fuzzyMatch("helpme", "help");
    expect(result.match).toBe(false);
  });

  it("matches with digits", () => {
    const result = fuzzyMatch("v2", "module-v2.ts");
    expect(result.match).toBe(true);
    expect(result.tier).toBe("substring");
  });
});

describe("compareFuzzyResults", () => {
  it("ranks prefix before substring regardless of coverage", () => {
    const prefixResult = {
      match: true as const,
      tier: "prefix" as const,
      coverage: 0.1,
      indices: [0],
    };
    const substrResult = {
      match: true as const,
      tier: "substring" as const,
      coverage: 0.9,
      indices: [1],
    };
    expect(compareFuzzyResults(prefixResult, substrResult)).toBeLessThan(0);
  });

  it("ranks higher coverage first within same tier", () => {
    const highCoverage = fuzzyMatch("com", "commit"); // 3/6 = 0.5
    const lowCoverage = fuzzyMatch("com", "components"); // 3/10 = 0.3
    expect(compareFuzzyResults(highCoverage, lowCoverage)).toBeLessThan(0);
  });

  it("returns 0 for equal tier and coverage", () => {
    const a = {
      match: true as const,
      tier: "prefix" as const,
      coverage: 0.5,
      indices: [0],
    };
    const b = {
      match: true as const,
      tier: "prefix" as const,
      coverage: 0.5,
      indices: [1],
    };
    expect(compareFuzzyResults(a, b)).toBe(0);
  });
});
