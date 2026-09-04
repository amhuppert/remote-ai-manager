import { describe, expect, it } from "vitest";

import {
  MEMORY_HOOK_ADVISORY_MAX_CHARS,
  assessMemoryHook,
  memoryOverlapQuery,
} from "./advisories";

describe("assessMemoryHook", () => {
  it("returns nothing for a fact-bearing one-line hook", () => {
    expect(
      assessMemoryHook(
        "Zero failures plus an onTaskUpdate timeout means swap thrash, not a branch defect",
      ),
    ).toEqual([]);
  });

  it("flags a hook past the advisory length", () => {
    const codes = assessMemoryHook(
      "word ".repeat(MEMORY_HOOK_ADVISORY_MAX_CHARS / 4) + "and more words",
    ).map((w) => w.code);
    expect(codes).toContain("hook_too_long");
  });

  it("flags a bare topic: too few words, a label opener, or a trailing colon", () => {
    for (const hook of [
      "Vitest swap thrash",
      "Notes on the turbopack cache",
      "Re: turbopack cache size and build time",
      "The turbopack cache and build time:",
    ]) {
      expect(assessMemoryHook(hook).map((w) => w.code)).toContain(
        "hook_topic_only",
      );
    }
  });

  it("does not mistake a fact that starts with a preposition for a label", () => {
    expect(
      assessMemoryHook(
        "On darwin the live database lives under Application Support",
      ),
    ).toEqual([]);
  });
});

describe("memoryOverlapQuery", () => {
  it("keeps content words from the hook and aliases, dropping function words", () => {
    expect(
      memoryOverlapQuery("The FTS5 index is derived state with a rebuild", [
        "search-index",
      ]),
    ).toBe("fts5 index derived state rebuild search");
  });

  it("returns null when only function words remain", () => {
    expect(memoryOverlapQuery("It is what it is, with them", [])).toBeNull();
  });
});
