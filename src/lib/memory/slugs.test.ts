import { describe, expect, it } from "vitest";

import { MEMORY_SLUG_PATTERN } from "./schemas";
import {
  MEMORY_SLUG_MAX_LENGTH,
  deriveMemorySlug,
  suffixMemorySlug,
} from "./slugs";

describe("deriveMemorySlug", () => {
  it("turns a hook into lowercase hyphenated words", () => {
    expect(
      deriveMemorySlug("The FTS5 index is derived state, rebuilt from rows"),
    ).toBe("the-fts5-index-is-derived-state-rebuilt-from-rows");
  });

  it("folds diacritics and drops every other non-alphanumeric run", () => {
    expect(deriveMemorySlug("  Réseau -- `cctl` (v2)!  ")).toBe(
      "reseau-cctl-v2",
    );
  });

  it("cuts an over-long hook on a word boundary within the cap", () => {
    const hook = Array.from({ length: 20 }, (_, i) => `word${i}`).join(" ");
    const slug = deriveMemorySlug(hook);
    expect(slug.length).toBeLessThanOrEqual(MEMORY_SLUG_MAX_LENGTH);
    expect(slug).not.toMatch(/-$/);
    expect(hook.replace(/ /g, "-")).toMatch(new RegExp(`^${slug}-`));
  });

  it("falls back to a fixed slug when nothing survives folding", () => {
    expect(deriveMemorySlug("!!! ???")).toBe("note");
  });

  it("always satisfies the slug pattern", () => {
    for (const hook of ["A", "Über-Test", "x".repeat(200), "--a--b--"]) {
      expect(deriveMemorySlug(hook)).toMatch(MEMORY_SLUG_PATTERN);
    }
  });
});

describe("suffixMemorySlug", () => {
  it("appends the ordinal", () => {
    expect(suffixMemorySlug("swap-thrash", 2)).toBe("swap-thrash-2");
  });

  it("trims the base so the suffixed slug stays within the cap", () => {
    const base = "a".repeat(MEMORY_SLUG_MAX_LENGTH);
    const suffixed = suffixMemorySlug(base, 12);
    expect(suffixed.length).toBe(MEMORY_SLUG_MAX_LENGTH);
    expect(suffixed).toMatch(/-12$/);
    expect(suffixed).toMatch(MEMORY_SLUG_PATTERN);
  });
});
