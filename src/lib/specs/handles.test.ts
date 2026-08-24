import { describe, expect, it } from "vitest";

import {
  explainInvalidElementHandle,
  formatBareElementHandle,
  formatElementHandle,
  formatSpecSlug,
  parseElementHandle,
  parseSpecSlug,
  toDeepLinkElementId,
  type BareElementHandle,
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

describe("slug-free handle formatting", () => {
  it.each<[BareElementHandle, string]>([
    [{ kind: "requirement", requirementNumber: 3 }, "R3"],
    [{ kind: "criterion", requirementNumber: 3, criterionNumber: 2 }, "R3.2"],
    [{ kind: "decision", number: 4 }, "D4"],
    [{ kind: "task", number: 5 }, "T5"],
    [{ kind: "question", number: 6 }, "Q6"],
    [{ kind: "assumption", number: 7 }, "A7"],
  ])("formats %j as %s without needing a spec slug", (handle, expected) => {
    expect(formatBareElementHandle(handle)).toBe(expected);
  });

  it("produces the same bare handle the qualified formatter does", () => {
    expect(formatBareElementHandle({ kind: "question", number: 12 })).toBe(
      formatElementHandle(
        { slug: parseSpecSlug("native-sdd"), kind: "question", number: 12 },
        "bare",
      ),
    );
  });

  it("refuses a number outside the grammar rather than emitting an unaddressable handle", () => {
    expect(() =>
      formatBareElementHandle({ kind: "question", number: 0 }),
    ).toThrow();
  });
});

describe("invalid element handle explanations", () => {
  it.each(["c2", "R0", "R3.0", "1", ""])(
    "states the handle grammar with concrete examples for %j",
    (input) => {
      const explanation = explainInvalidElementHandle(input);

      expect(explanation).toContain("R1.2");
      expect(explanation).toContain("D3");
      expect(explanation).toContain("T4");
      expect(explanation).toContain("Q1");
      expect(explanation).toContain("A2");
    },
  );

  it.each(["requirement-1", "native-sdd-criterion-2", "task_7"])(
    "says %j looks like an element id rather than a handle",
    (input) => {
      expect(explainInvalidElementHandle(input)).toContain(
        "looks like an element id",
      );
    },
  );

  it("names the real handle when the value is a known element id", () => {
    const explanation = explainInvalidElementHandle(
      "requirement-1",
      new Map([
        ["requirement-1", "R1"],
        ["criterion-1", "R1.2"],
      ]),
    );

    expect(explanation).toContain("requirement-1");
    expect(explanation).toContain("is an element id");
    expect(explanation).toContain("R1");
    expect(explanation).not.toContain("looks like an element id");
  });

  it("falls back to the grammar when a known-element map has no entry", () => {
    const explanation = explainInvalidElementHandle(
      "c2",
      new Map([["requirement-1", "R1"]]),
    );

    expect(explanation).not.toContain("is an element id");
    expect(explanation).toContain("R1.2");
  });

  it("reads the element-id signal through a slug-qualified value", () => {
    expect(explainInvalidElementHandle("native-sdd/requirement-1")).toContain(
      "looks like an element id",
    );
  });

  /**
   * An element id reaching a handle-taking command is often a SECTION id, the
   * one element kind that has no handle to convert to. Restating the handle
   * grammar alone leaves that caller with no working read at all, so the
   * explanation names the command that takes an element id.
   */
  it("names the element-id read on both id-shaped explanations", () => {
    const shaped = explainInvalidElementHandle("problem-section");
    const known = explainInvalidElementHandle(
      "requirement-1",
      new Map([["requirement-1", "R1"]]),
    );
    const ungrammatical = explainInvalidElementHandle("c2");

    for (const explanation of [shaped, known]) {
      expect(explanation).toContain(
        "cctl spec section get <slug> --id <element-id>",
      );
    }
    // Not on a value that is merely ungrammatical: it names no element at all,
    // so pointing at the element-id read would be a guess, not guidance.
    expect(ungrammatical).not.toContain("spec section get");
  });
});
