import { describe, expect, it } from "vitest";

import type { CommentAnchor } from "@/lib/document-comments/schemas";
import { reanchorSpecThread } from "./reanchor";

const anchor: CommentAnchor = {
  sectionId: "intent",
  headingLabel: "Intent",
  line: 1,
  charStart: 0,
  charEnd: 14,
  quote: "Stable address",
  prefix: "",
  suffix: " for every spec",
  docRevision: "revision-3",
};

describe("reanchorSpecThread", () => {
  it("keeps a multi-block passage stale after its heading identity changes", () => {
    const quote = "First paragraph.\n\nSecond paragraph.";
    const spanning: CommentAnchor = {
      ...anchor,
      sectionId: "old",
      line: 3,
      endBlock: { line: 5, sectionId: "old" },
      charStart: 0,
      charEnd: quote.length,
      quote,
    };

    expect(
      reanchorSpecThread(
        spanning,
        "# Replacement\n\nFirst paragraph.\n\nSecond paragraph.",
      ),
    ).toEqual({ status: "stale" });
  });

  it("checks the ending section and repeated-heading identities", () => {
    const quote = "Second paragraph.\n\nThird paragraph.";
    const spanning: CommentAnchor = {
      ...anchor,
      sectionId: "intent-1",
      line: 7,
      endBlock: { line: 9, sectionId: "intent-1" },
      charStart: 0,
      charEnd: quote.length,
      quote,
    };
    const content =
      "# Intent\n\nFirst paragraph.\n\n# Intent\n\nSecond paragraph.\n\nThird paragraph.";

    expect(
      reanchorSpecThread({ ...spanning, sectionId: "intent" }, content),
    ).toEqual({ status: "stale" });
    expect(
      reanchorSpecThread(
        { ...spanning, endBlock: { line: 9, sectionId: "intent" } },
        content,
      ),
    ).toEqual({ status: "stale" });
    expect(reanchorSpecThread(spanning, content)).toEqual({
      status: "anchored",
      charStart: 0,
      charEnd: quote.length,
    });
  });

  it("resolves a rendered passage spanning formatted paragraphs against its source", () => {
    const quote = "first paragraph.\n\nSecond paragraph";
    const spanning: CommentAnchor = {
      ...anchor,
      sectionId: "intent",
      line: 3,
      endBlock: { line: 6, sectionId: "intent" },
      charStart: 4,
      charEnd: 4 + quote.length,
      quote,
    };
    expect(
      reanchorSpecThread(
        spanning,
        "# Intent\n\nThe **first** paragraph.\n\n\nSecond paragraph ends.",
      ),
    ).toEqual({
      status: "anchored",
      charStart: spanning.charStart,
      charEnd: spanning.charEnd,
    });
    expect(
      reanchorSpecThread(
        spanning,
        "# Intent\n\nThe **first** paragraph.\n\n\nChanged paragraph ends.",
      ),
    ).toEqual({ status: "stale" });
  });

  it("relocates only a unique quote within the same element body", () => {
    expect(
      reanchorSpecThread(anchor, "The Stable address remains durable."),
    ).toEqual({ status: "reanchored", charStart: 4, charEnd: 18 });
  });

  it("leaves an ambiguous quote stale", () => {
    expect(
      reanchorSpecThread(
        anchor,
        "The Stable address differs from another Stable address.",
      ),
    ).toEqual({ status: "stale" });
  });

  it("presents a removed element as orphaned", () => {
    expect(reanchorSpecThread(anchor, null)).toEqual({ status: "orphaned" });
  });

  it("keeps an unchanged original range anchored", () => {
    expect(
      reanchorSpecThread(anchor, "Stable address for every spec."),
    ).toEqual({ status: "anchored", charStart: 0, charEnd: 14 });
  });
});
