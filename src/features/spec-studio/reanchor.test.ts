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
