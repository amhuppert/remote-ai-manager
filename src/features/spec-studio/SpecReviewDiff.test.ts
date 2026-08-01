import { describe, expect, it } from "vitest";

import { formatInlineReviewDiff } from "./SpecReviewDiff";

describe("formatInlineReviewDiff", () => {
  it("keeps unchanged text as one segment", () => {
    expect(
      formatInlineReviewDiff(
        "Every execution pins scope.",
        "Every execution pins scope.",
      ),
    ).toEqual([{ kind: "unchanged", text: "Every execution pins scope." }]);
  });

  it("isolates inserted and removed phrases while preserving readable spacing", () => {
    expect(
      formatInlineReviewDiff(
        "Every execution pins scope.",
        "Every execution records the exact selected scope.",
      ),
    ).toEqual([
      { kind: "unchanged", text: "Every execution " },
      { kind: "removed", text: "pins " },
      { kind: "added", text: "records the exact selected " },
      { kind: "unchanged", text: "scope." },
    ]);
  });

  it("formats one-sided revisions as a single semantic segment", () => {
    expect(formatInlineReviewDiff(null, "New requirement")).toEqual([
      { kind: "added", text: "New requirement" },
    ]);
    expect(formatInlineReviewDiff("Retired requirement", null)).toEqual([
      { kind: "removed", text: "Retired requirement" },
    ]);
  });
});
