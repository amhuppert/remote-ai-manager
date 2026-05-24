import { describe, it, expect } from "vitest";
import type { FileItem } from "@/lib/files/schemas";
import {
  filterAndScoreFiles,
  MAX_DISPLAY_ITEMS,
} from "./file-autocomplete-filter";

function makeFiles(paths: string[]): FileItem[] {
  return paths.map((path) => ({ path }));
}

describe("filterAndScoreFiles", () => {
  it("returns empty result for empty file list", () => {
    const result = filterAndScoreFiles("foo", []);
    expect(result.items).toEqual([]);
    expect(result.totalCount).toBe(0);
  });

  it("empty query matches everything up to the display cap", () => {
    const files = makeFiles(
      Array.from({ length: 100 }, (_, i) => `file-${i}.ts`),
    );

    const result = filterAndScoreFiles("", files);

    expect(result.totalCount).toBe(100);
    expect(result.items.length).toBe(MAX_DISPLAY_ITEMS);
  });

  it("caps items at MAX_DISPLAY_ITEMS by default", () => {
    const files = makeFiles(
      Array.from({ length: 200 }, (_, i) => `prefix-${i}.ts`),
    );

    const result = filterAndScoreFiles("prefix", files);

    expect(result.items.length).toBe(MAX_DISPLAY_ITEMS);
    expect(result.totalCount).toBe(200);
  });

  it("respects custom maxDisplayItems", () => {
    const files = makeFiles(["a.ts", "ab.ts", "abc.ts", "abcd.ts"]);

    const result = filterAndScoreFiles("a", files, { maxDisplayItems: 2 });

    expect(result.items.length).toBe(2);
    expect(result.totalCount).toBe(4);
  });

  it("filters out non-matches", () => {
    const files = makeFiles(["foo.ts", "bar.ts", "foobar.ts"]);

    const result = filterAndScoreFiles("foo", files);

    expect(result.items.map((s) => s.item.path)).toEqual([
      "foo.ts",
      "foobar.ts",
    ]);
    expect(result.totalCount).toBe(2);
  });

  it("sorts prefix matches above substring matches", () => {
    const files = makeFiles(["src/utils.ts", "utils.ts"]);

    const result = filterAndScoreFiles("utils", files);
    const paths = result.items.map((s) => s.item.path);

    expect(paths[0]).toBe("utils.ts");
    expect(paths[1]).toBe("src/utils.ts");
  });

  it("breaks ties by locale-compare on path", () => {
    const files = makeFiles(["b.ts", "a.ts", "c.ts"]);

    const result = filterAndScoreFiles("", files);
    const paths = result.items.map((s) => s.item.path);

    expect(paths).toEqual(["a.ts", "b.ts", "c.ts"]);
  });

  it("each returned item carries item, tier, coverage, indices", () => {
    const files = makeFiles(["foo.ts"]);

    const result = filterAndScoreFiles("foo", files);

    expect(result.items).toHaveLength(1);
    const first = result.items[0]!;
    expect(first.item).toEqual({ path: "foo.ts" });
    expect(first.tier).toBe("prefix");
    expect(typeof first.coverage).toBe("number");
    expect(Array.isArray(first.indices)).toBe(true);
  });

  it("totalCount reflects pre-cap count, not displayed count", () => {
    const files = makeFiles(
      Array.from({ length: 75 }, (_, i) => `match-${i}.ts`),
    );

    const result = filterAndScoreFiles("match", files);

    expect(result.totalCount).toBe(75);
    expect(result.items.length).toBe(MAX_DISPLAY_ITEMS);
  });
});
