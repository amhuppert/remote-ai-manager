import { describe, expect, it } from "vitest";
import { jsonOrNull, stableStringify } from "./serialization";

describe("stableStringify", () => {
  it("emits object keys in sorted order recursively", () => {
    expect(stableStringify({ b: 1, a: { d: 2, c: [3, { f: 4, e: 5 }] } })).toBe(
      '{"a":{"c":[3,{"e":5,"f":4}],"d":2},"b":1}',
    );
  });

  // A domain value that sets an optional field to `undefined` is the same value
  // as one that omits the key, and a serializer that writes `null` for it hands
  // the reader a shape its own schema rejects: an `.optional()` (not nullable)
  // field written this way makes a row the repository can never load again.
  it("omits object keys whose value is undefined", () => {
    expect(stableStringify({ a: 1, b: undefined })).toBe('{"a":1}');
    expect(stableStringify({ a: 1, b: undefined })).toBe(
      stableStringify({ a: 1 }),
    );
  });

  // Array elements are positional: dropping an undefined element would shift
  // every element after it, so `null` stays the honest encoding there.
  it("encodes undefined array elements as null", () => {
    expect(stableStringify([1, undefined, 2])).toBe("[1,null,2]");
  });

  it("encodes a top-level undefined as null", () => {
    expect(stableStringify(undefined)).toBe("null");
    expect(stableStringify(null)).toBe("null");
  });
});

describe("jsonOrNull", () => {
  it("maps absent values to a NULL column and present values to sorted JSON", () => {
    expect(jsonOrNull(undefined)).toBeNull();
    expect(jsonOrNull(null)).toBeNull();
    expect(jsonOrNull({ b: 1, a: undefined })).toBe('{"b":1}');
  });
});
