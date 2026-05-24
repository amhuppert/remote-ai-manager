import { describe, it, expect } from "vitest";
import { deepGet, deepSet, deepEqual, stripUndefinedDeep } from "./form-state";

describe("deepGet", () => {
  it("returns nested value by dot path", () => {
    expect(deepGet({ a: { b: { c: 1 } } }, "a.b.c")).toBe(1);
  });
  it("returns undefined for missing path", () => {
    expect(deepGet({ a: { b: {} } }, "a.b.c")).toBeUndefined();
    expect(deepGet(null, "a")).toBeUndefined();
  });
});

describe("deepSet", () => {
  it("sets nested value by dot path without mutating original", () => {
    const original = { a: { b: 1 } };
    const next = deepSet(original, "a.b", 2);
    expect(next).toEqual({ a: { b: 2 } });
    expect(original).toEqual({ a: { b: 1 } });
  });
  it("creates missing intermediate objects", () => {
    expect(deepSet({}, "a.b.c", 5)).toEqual({ a: { b: { c: 5 } } });
  });
});

describe("deepEqual", () => {
  it("compares primitives and arrays", () => {
    expect(deepEqual(1, 1)).toBe(true);
    expect(deepEqual([1, 2], [1, 2])).toBe(true);
    expect(deepEqual([1, 2], [2, 1])).toBe(false);
  });
  it("compares nested objects", () => {
    expect(deepEqual({ a: { b: 1 } }, { a: { b: 1 } })).toBe(true);
    expect(deepEqual({ a: { b: 1 } }, { a: { b: 2 } })).toBe(false);
  });
  it("handles null and undefined", () => {
    expect(deepEqual(null, null)).toBe(true);
    expect(deepEqual(undefined, null)).toBe(true);
    expect(deepEqual(null, {})).toBe(false);
  });
});

describe("stripUndefinedDeep", () => {
  it("removes undefined keys and empty nested objects", () => {
    expect(
      stripUndefinedDeep({ a: 1, b: undefined, c: { d: undefined } }),
    ).toEqual({
      a: 1,
    });
  });
  it("preserves arrays as-is", () => {
    expect(stripUndefinedDeep({ list: [1, 2, 3] })).toEqual({
      list: [1, 2, 3],
    });
  });
});
