import { describe, expect, it, vi } from "vitest";
import { createVersionedRowCache } from "./versioned-row-cache";

interface Raw {
  id: string;
  a: number;
  b: string;
}

/** Column-only equality — mirrors a repo's rawRowsEqual over known columns. */
function rowsEqual(x: Raw, y: Raw): boolean {
  return x.id === y.id && x.a === y.a && x.b === y.b;
}

function makeCache(parse: (row: Raw) => { id: string; sum: string }) {
  return createVersionedRowCache<string, Raw, { id: string; sum: string }>({
    keyOf: (row) => row.id,
    rowsEqual,
    parse,
  });
}

describe("createVersionedRowCache", () => {
  it("parses each row on the first readAll", () => {
    const parse = vi.fn((row: Raw) => ({
      id: row.id,
      sum: `${row.a}${row.b}`,
    }));
    const cache = makeCache(parse);
    const rows: Raw[] = [
      { id: "1", a: 1, b: "x" },
      { id: "2", a: 2, b: "y" },
    ];

    const out = cache.readAll(() => rows);
    expect(out).toEqual([
      { id: "1", sum: "1x" },
      { id: "2", sum: "2y" },
    ]);
    expect(parse).toHaveBeenCalledTimes(2);
  });

  it("returns the same array reference while the version is unchanged", () => {
    const parse = vi.fn((row: Raw) => ({ id: row.id, sum: row.b }));
    const cache = makeCache(parse);
    const rows: Raw[] = [{ id: "1", a: 1, b: "x" }];

    const first = cache.readAll(() => rows);
    const second = cache.readAll(() => rows);
    expect(second).toBe(first);
    // No re-parse on the version hit.
    expect(parse).toHaveBeenCalledTimes(1);
  });

  it("does NOT invoke the row loader on a version hit (short-circuit before raw fetch)", () => {
    const cache = makeCache((row) => ({ id: row.id, sum: row.b }));
    const rows: Raw[] = [{ id: "1", a: 1, b: "x" }];
    const loadRows = vi.fn(() => rows);

    cache.readAll(loadRows);
    expect(loadRows).toHaveBeenCalledTimes(1);

    // A warm version hit must return the cached array without re-fetching rows.
    cache.readAll(loadRows);
    expect(loadRows).toHaveBeenCalledTimes(1);

    // After a bump the loader runs again — the version gate invalidated.
    cache.bump();
    cache.readAll(loadRows);
    expect(loadRows).toHaveBeenCalledTimes(2);
  });

  it("reuses the parsed element for an unchanged row after a bump", () => {
    const parse = vi.fn((row: Raw) => ({ id: row.id, sum: row.b }));
    const cache = makeCache(parse);
    const rowA1: Raw = { id: "1", a: 1, b: "x" };
    const rowB1: Raw = { id: "2", a: 2, b: "y" };

    const first = cache.readAll(() => [rowA1, rowB1]);
    cache.bump();
    // Row 2 changed; row 1 unchanged (fresh raw object, equal columns).
    const rowA2: Raw = { id: "1", a: 1, b: "x" };
    const rowB2: Raw = { id: "2", a: 2, b: "CHANGED" };
    const second = cache.readAll(() => [rowA2, rowB2]);

    // Different array container after a bump.
    expect(second).not.toBe(first);
    // Row 1's parsed element is reused (same reference); row 2 is re-parsed.
    expect(second[0]).toBe(first[0]);
    expect(second[1]).not.toBe(first[1]);
    expect(second[1]).toEqual({ id: "2", sum: "CHANGED" });
    // 2 initial parses + 1 for the changed row.
    expect(parse).toHaveBeenCalledTimes(3);
  });

  it("prunes cache entries for keys no longer present", () => {
    const parse = vi.fn((row: Raw) => ({ id: row.id, sum: row.b }));
    const cache = makeCache(parse);
    cache.readAll(() => [
      { id: "1", a: 1, b: "x" },
      { id: "2", a: 2, b: "y" },
    ]);
    cache.bump();
    cache.readAll(() => [{ id: "1", a: 1, b: "x" }]);

    expect(cache.getParsedByKey("2")).toBeUndefined();
    expect(cache.getParsedByKey("1")).toBeDefined();
  });

  it("evict drops a single key so its next read re-parses", () => {
    const parse = vi.fn((row: Raw) => ({ id: row.id, sum: row.b }));
    const cache = makeCache(parse);
    cache.readAll(() => [{ id: "1", a: 1, b: "x" }]);
    expect(cache.getParsedByKey("1")).toBeDefined();

    cache.evict("1");
    expect(cache.getParsedByKey("1")).toBeUndefined();

    cache.bump();
    cache.readAll(() => [{ id: "1", a: 1, b: "x" }]);
    // Re-parsed after eviction (initial + post-evict).
    expect(parse).toHaveBeenCalledTimes(2);
  });

  it("getParsedByKey exposes the parsed entry for a secondary memo layer", () => {
    const cache = makeCache((row) => ({ id: row.id, sum: row.b }));
    const rows: Raw[] = [
      { id: "1", a: 1, b: "x" },
      { id: "2", a: 2, b: "y" },
    ];
    const out = cache.readAll(() => rows);
    // The element a caller would resolve through getParsedByKey is the same
    // reference readAll returned.
    expect(cache.getParsedByKey("2")!.parsed).toBe(out[1]);
  });

  it("exposes a monotonic version", () => {
    const cache = makeCache((row) => ({ id: row.id, sum: row.b }));
    expect(cache.version).toBe(0);
    cache.bump();
    cache.bump();
    expect(cache.version).toBe(2);
  });
});
