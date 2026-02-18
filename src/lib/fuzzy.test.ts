import { describe, it, expect } from "vitest";
import { fuzzyMatch } from "./fuzzy";

describe("fuzzyMatch", () => {
  it("returns match with score 100 for empty query", () => {
    const result = fuzzyMatch("", "anything");
    expect(result).toEqual({ match: true, score: 100, indices: [] });
  });

  it("returns prefix match with score 100", () => {
    const result = fuzzyMatch("hel", "help");
    expect(result.match).toBe(true);
    expect(result.score).toBe(100);
    expect(result.indices).toEqual([0, 1, 2]);
  });

  it("returns substring match with score 80", () => {
    const result = fuzzyMatch("ear", "clear");
    expect(result.match).toBe(true);
    expect(result.score).toBe(80);
    expect(result.indices).toEqual([2, 3, 4]);
  });

  it("returns ordered character match with spread-based score", () => {
    const result = fuzzyMatch("hp", "help");
    expect(result.match).toBe(true);
    expect(result.score).toBeGreaterThanOrEqual(10);
    expect(result.score).toBeLessThanOrEqual(60);
    expect(result.indices).toEqual([0, 3]);
  });

  it("returns no match when characters are not in order", () => {
    const result = fuzzyMatch("xyz", "help");
    expect(result).toEqual({ match: false, score: 0, indices: [] });
  });

  it("matches case-insensitively", () => {
    const result = fuzzyMatch("HELP", "help");
    expect(result.match).toBe(true);
    expect(result.score).toBe(100);
  });

  it("scores prefix higher than substring", () => {
    const prefix = fuzzyMatch("co", "commit");
    const substr = fuzzyMatch("mit", "commit");
    expect(prefix.score).toBeGreaterThan(substr.score);
  });

  it("scores substring higher than ordered chars", () => {
    const substr = fuzzyMatch("ear", "clear");
    const ordered = fuzzyMatch("cr", "clear");
    expect(substr.score).toBeGreaterThan(ordered.score);
  });
});
