import { describe, expect, it } from "vitest";

import { gridShape, paneMessageLimit, truncate } from "./grid-shape";

describe("gridShape", () => {
  it("arranges 1 pane as a single full-height row", () => {
    expect(gridShape(1)).toEqual({ cols: 1, rows: 1, shape: "row" });
  });

  it("arranges 2 panes as a single full-height row", () => {
    expect(gridShape(2)).toEqual({ cols: 2, rows: 1, shape: "row" });
  });

  it("arranges 3 panes as a single full-height row", () => {
    expect(gridShape(3)).toEqual({ cols: 3, rows: 1, shape: "row" });
  });

  it("arranges 4 panes as a 2x2 grid", () => {
    expect(gridShape(4)).toEqual({ cols: 2, rows: 2, shape: "grid-2x2" });
  });

  it("arranges 5 panes as the asymmetric three-over-two-wider grid on a 6-col track", () => {
    expect(gridShape(5)).toEqual({ cols: 6, rows: 2, shape: "asym-5" });
  });

  it("arranges 6 panes as a 3x2 grid", () => {
    expect(gridShape(6)).toEqual({ cols: 3, rows: 2, shape: "grid-3x2" });
  });

  it("clamps counts below 1 to the single-pane shape", () => {
    expect(gridShape(0)).toEqual({ cols: 1, rows: 1, shape: "row" });
    expect(gridShape(-3)).toEqual({ cols: 1, rows: 1, shape: "row" });
  });

  it("clamps counts above 6 to the six-pane shape", () => {
    expect(gridShape(7)).toEqual({ cols: 3, rows: 2, shape: "grid-3x2" });
    expect(gridShape(100)).toEqual({ cols: 3, rows: 2, shape: "grid-3x2" });
  });
});

describe("paneMessageLimit", () => {
  it("allows up to four messages with exactly two panes", () => {
    expect(paneMessageLimit(2)).toBe(4);
  });

  it("allows up to two messages for a single pane", () => {
    expect(paneMessageLimit(1)).toBe(2);
  });

  it("allows up to two messages for three or more panes", () => {
    expect(paneMessageLimit(3)).toBe(2);
    expect(paneMessageLimit(4)).toBe(2);
    expect(paneMessageLimit(5)).toBe(2);
    expect(paneMessageLimit(6)).toBe(2);
  });
});

describe("truncate", () => {
  it("returns a string shorter than the limit unchanged", () => {
    expect(truncate("hello", 10)).toBe("hello");
  });

  it("returns a string exactly at the limit unchanged", () => {
    expect(truncate("hello", 5)).toBe("hello");
  });

  it("shortens an over-limit string with an ellipsis to exactly the limit length", () => {
    const result = truncate("hello world", 8);
    expect(result).toBe("hello w…");
    expect(result).toHaveLength(8);
  });

  it("returns an empty string unchanged", () => {
    expect(truncate("", 5)).toBe("");
  });
});
