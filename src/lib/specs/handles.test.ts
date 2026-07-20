import { describe, expect, it } from "vitest";

import {
  formatElementHandle,
  formatSpecSlug,
  parseElementHandle,
  parseSpecSlug,
  toDeepLinkElementId,
} from "./handles";

describe("spec handle grammar", () => {
  it.each(["native-sdd", "sdd2", "2fa-spec", "a-b-c"])(
    "round-trips spec slug %s",
    (slug) => {
      expect(formatSpecSlug(parseSpecSlug(slug))).toBe(slug);
    },
  );

  it.each([
    {
      qualified: "native-sdd/R3",
      bare: "R3",
      expected: {
        slug: "native-sdd",
        kind: "requirement",
        requirementNumber: 3,
      },
    },
    {
      qualified: "native-sdd/R3.2",
      bare: "R3.2",
      expected: {
        slug: "native-sdd",
        kind: "criterion",
        requirementNumber: 3,
        criterionNumber: 2,
      },
    },
    {
      qualified: "native-sdd/D2",
      bare: "D2",
      expected: { slug: "native-sdd", kind: "decision", number: 2 },
    },
    {
      qualified: "native-sdd/T7",
      bare: "T7",
      expected: { slug: "native-sdd", kind: "task", number: 7 },
    },
    {
      qualified: "native-sdd/Q2",
      bare: "Q2",
      expected: { slug: "native-sdd", kind: "question", number: 2 },
    },
    {
      qualified: "native-sdd/A1",
      bare: "A1",
      expected: { slug: "native-sdd", kind: "assumption", number: 1 },
    },
  ])("round-trips $qualified", ({ qualified, bare, expected }) => {
    const parsed = parseElementHandle(qualified);

    expect(parsed).toEqual(expected);
    expect(formatElementHandle(parsed)).toBe(qualified);
    expect(formatElementHandle(parsed, "bare")).toBe(bare);
    expect(toDeepLinkElementId(parsed)).toBe(bare);
  });

  it.each(["R3", "R3.2", "D2", "T7", "Q2", "A1"])(
    "resolves bare handle %s against a context slug",
    (bare) => {
      const parsed = parseElementHandle(bare, "native-sdd");

      expect(formatElementHandle(parsed)).toBe(`native-sdd/${bare}`);
      expect(toDeepLinkElementId(parsed)).toBe(bare);
    },
  );

  it.each([
    "",
    "Native-SDD",
    "native_sdd",
    "-native-sdd",
    "native-sdd-",
    "native--sdd",
    "native/sdd",
  ])("rejects malformed spec slug %j", (slug) => {
    expect(() => parseSpecSlug(slug)).toThrow();
  });

  it.each([
    "R3",
    "native-sdd",
    "native-sdd/",
    "native-sdd/R0",
    "native-sdd/R03",
    "native-sdd/R3.0",
    "native-sdd/R3.02",
    "native-sdd/r3",
    "native-sdd/C2",
    "native-sdd/D2.1",
    "native-sdd/R3/extra",
    "Native-SDD/R3",
    "native_sdd/R3",
  ])("rejects malformed or context-free element handle %j", (handle) => {
    expect(() => parseElementHandle(handle)).toThrow();
  });

  it("rejects a malformed context slug for a bare handle", () => {
    expect(() => parseElementHandle("R3", "Native-SDD")).toThrow();
  });
});
