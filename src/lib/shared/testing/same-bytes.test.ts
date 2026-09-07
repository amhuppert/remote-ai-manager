import { describe, expect, it } from "vitest";
import { expectSameBytes } from "./same-bytes";

describe("expectSameBytes", () => {
  it("passes for identical content in distinct buffers", () => {
    expect(() =>
      expectSameBytes(Buffer.from("abc"), Buffer.from("abc")),
    ).not.toThrow();
  });

  it("fails naming the first differing offset", () => {
    expect(() =>
      expectSameBytes(Buffer.from("abcd"), Buffer.from("abXd"), "database"),
    ).toThrow(
      /database differ: actual 4 bytes, expected 4 bytes, first difference at offset 2/,
    );
  });

  it("fails on a length mismatch even when the prefix agrees", () => {
    expect(() =>
      expectSameBytes(Buffer.from("abc"), Buffer.from("abcdef")),
    ).toThrow(/actual 3 bytes, expected 6 bytes, first difference at offset 3/);
  });
});
