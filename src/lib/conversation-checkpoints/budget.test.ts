import { describe, it, expect } from "vitest";

import {
  CHECKPOINT_SEED_BUDGET,
  truncateToUtf8Bytes,
  utf8ByteLength,
} from "./budget";

describe("CHECKPOINT_SEED_BUDGET", () => {
  it("carries the fixed product limits and partitions the total exactly", () => {
    expect(CHECKPOINT_SEED_BUDGET).toEqual({
      workingState: 18_432,
      recentDialogue: 10_240,
      recoveryFraming: 4_096,
      total: 32_768,
    });
    expect(
      CHECKPOINT_SEED_BUDGET.workingState +
        CHECKPOINT_SEED_BUDGET.recentDialogue +
        CHECKPOINT_SEED_BUDGET.recoveryFraming,
    ).toBe(CHECKPOINT_SEED_BUDGET.total);
  });
});

describe("utf8ByteLength", () => {
  it("measures bytes, not JavaScript string length", () => {
    expect(utf8ByteLength("abc")).toBe(3);
    // 2-byte, 3-byte, and 4-byte code points.
    expect(utf8ByteLength("é")).toBe(2);
    expect(utf8ByteLength("日")).toBe(3);
    expect(utf8ByteLength("🧭")).toBe(4);
    expect("🧭".length).toBe(2);
  });
});

describe("truncateToUtf8Bytes", () => {
  it("returns the input unchanged at an exact fit", () => {
    expect(truncateToUtf8Bytes("日本語", 9)).toBe("日本語");
  });

  it("drops the code point that would cross the limit by one byte", () => {
    expect(truncateToUtf8Bytes("日本語", 8)).toBe("日本");
    expect(utf8ByteLength(truncateToUtf8Bytes("日本語", 8))).toBe(6);
  });

  it("never splits a surrogate pair", () => {
    // Three 4-byte emoji; a 6-byte budget can only hold one whole one.
    const text = "🧭🧭🧭";
    const kept = truncateToUtf8Bytes(text, 6);
    expect(kept).toBe("🧭");
    expect(Array.from(kept)).toHaveLength(1);
    expect(kept).not.toContain("�");
    expect(Buffer.from(kept, "utf8").toString("utf8")).toBe(kept);
  });

  it("returns nothing when even the first code point does not fit", () => {
    expect(truncateToUtf8Bytes("🧭tail", 3)).toBe("");
    expect(truncateToUtf8Bytes("abc", 0)).toBe("");
    expect(truncateToUtf8Bytes("abc", -5)).toBe("");
  });
});
