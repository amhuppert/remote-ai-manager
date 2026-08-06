import { describe, it, expect } from "vitest";

import { computeContentHash } from "./hashing";
import { contentHashSchema } from "./schemas";

describe("computeContentHash", () => {
  it("produces the persisted sha256:<hex> envelope with lowercase hex", () => {
    const hash = computeContentHash("You are a security reviewer.");

    expect(hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(contentHashSchema.safeParse(hash).success).toBe(true);
  });

  it("hashes NFC-normalized UTF-8 so equivalent Unicode spellings agree", () => {
    // "é" precomposed (U+00E9) vs decomposed (U+0065 U+0301): the same text to
    // a reader, so the same source content hash.
    const precomposed = "reviéw carefully";
    const decomposed = "reviéw carefully";

    expect(precomposed).not.toBe(decomposed);
    expect(computeContentHash(precomposed)).toBe(
      computeContentHash(decomposed),
    );
  });

  it("is deterministic for identical input and distinct for different input", () => {
    expect(computeContentHash("alpha")).toBe(computeContentHash("alpha"));
    expect(computeContentHash("alpha")).not.toBe(computeContentHash("alpha "));
  });

  it("covers the bytes it is given verbatim — whitespace is significant", () => {
    // Unlike the charter hash, this one is a provenance hash over stored
    // content: two records whose instructions differ only in trailing
    // whitespace are different stored bytes and must hash differently.
    expect(computeContentHash("do the thing\n")).not.toBe(
      computeContentHash("do the thing"),
    );
  });
});

describe("contentHashSchema", () => {
  const hex = "a".repeat(64);

  it("accepts the sha256 envelope", () => {
    expect(contentHashSchema.safeParse(`sha256:${hex}`).success).toBe(true);
  });

  it("rejects a bare digest, a wrong algorithm, uppercase hex, and a wrong length", () => {
    expect(contentHashSchema.safeParse(hex).success).toBe(false);
    expect(contentHashSchema.safeParse(`md5:${hex}`).success).toBe(false);
    expect(
      contentHashSchema.safeParse(`sha256:${"A".repeat(64)}`).success,
    ).toBe(false);
    expect(
      contentHashSchema.safeParse(`sha256:${"a".repeat(63)}`).success,
    ).toBe(false);
  });
});
