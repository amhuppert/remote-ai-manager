import { describe, expect, it } from "vitest";

import { truncate } from "./truncate";

describe("truncate", () => {
  it("returns the value unchanged when within budget", () => {
    expect(truncate("hello", 5)).toBe("hello");
    expect(truncate("hi", 10)).toBe("hi");
  });

  describe("default contract (keep max content chars, append marker)", () => {
    it("keeps max chars then appends the default ellipsis", () => {
      expect(truncate("hello world", 5)).toBe("hello…");
    });

    it("supports a custom ellipsis marker", () => {
      expect(truncate("hello world", 5, { ellipsis: "..." })).toBe("hello...");
    });

    it("supports a multi-line custom marker", () => {
      expect(truncate("abcdef", 3, { ellipsis: "\n…[truncated]" })).toBe(
        "abc\n…[truncated]",
      );
    });
  });

  describe("bounded-total contract (countEllipsisInBudget)", () => {
    it("reserves room for the ellipsis so the result never exceeds max", () => {
      const out = truncate("hello world", 5, { countEllipsisInBudget: true });
      expect(out).toBe("hell…");
      expect(out.length).toBe(5);
    });
  });

  describe("trimEnd", () => {
    it("trims trailing whitespace from the slice before the marker", () => {
      expect(
        truncate("abc defghi", 4, {
          countEllipsisInBudget: true,
          trimEnd: true,
        }),
      ).toBe("abc…");
    });
  });
});
