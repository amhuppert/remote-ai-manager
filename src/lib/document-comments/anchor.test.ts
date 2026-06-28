import { describe, expect, it } from "vitest";
import {
  computeDocRevision,
  deriveSelectionAnchor,
  tryReanchorExact,
} from "./anchor";
import type { CommentAnchor } from "./schemas";

const BLOCK = "The best code is no code. Don't add features we don't need.";

function deriveOver(
  blockText: string,
  charStart: number,
  charEnd: number,
  content = blockText,
): CommentAnchor {
  return deriveSelectionAnchor({
    blockText,
    blockLine: 7,
    sectionId: "1-design",
    headingLabel: "1 › Design",
    charStart,
    charEnd,
    content,
  });
}

describe("computeDocRevision", () => {
  it("is deterministic — identical content yields an identical revision", () => {
    const content = "# Title\n\nSome body text.\n";
    expect(computeDocRevision(content)).toBe(computeDocRevision(content));
  });

  it("is change-sensitive — different content yields a different revision", () => {
    expect(computeDocRevision("alpha")).not.toBe(computeDocRevision("beta"));
  });

  it("distinguishes whitespace-only differences", () => {
    expect(computeDocRevision("a b")).not.toBe(computeDocRevision("a  b"));
    expect(computeDocRevision("ab")).not.toBe(computeDocRevision("ab\n"));
  });

  it("returns a non-empty string", () => {
    expect(computeDocRevision("anything").length).toBeGreaterThan(0);
    expect(typeof computeDocRevision("")).toBe("string");
  });
});

describe("deriveSelectionAnchor", () => {
  it("captures the exact selected quote at the given offsets", () => {
    const anchor = deriveOver(BLOCK, 4, 8); // "best"
    expect(anchor.quote).toBe("best");
    expect(anchor.charStart).toBe(4);
    expect(anchor.charEnd).toBe(8);
  });

  it("carries the section, heading, and line through", () => {
    const anchor = deriveOver(BLOCK, 4, 8);
    expect(anchor.sectionId).toBe("1-design");
    expect(anchor.headingLabel).toBe("1 › Design");
    expect(anchor.line).toBe(7);
  });

  it("stores bounded prefix and suffix context", () => {
    const anchor = deriveOver(BLOCK, 4, 8); // "best"
    expect(anchor.prefix).toBe("The ");
    expect(anchor.suffix.startsWith(" code")).toBe(true);
  });

  it("clamps prefix/suffix at the block boundaries", () => {
    const anchor = deriveOver(BLOCK, 0, 3); // "The" at the very start
    expect(anchor.prefix).toBe("");
    const end = deriveOver(BLOCK, BLOCK.length - 5, BLOCK.length); // "need."
    expect(end.suffix).toBe("");
  });

  it("stamps the document revision from the whole content, not the block", () => {
    const content = "# Doc\n\n" + BLOCK + "\n";
    const anchor = deriveOver(BLOCK, 4, 8, content);
    expect(anchor.docRevision).toBe(computeDocRevision(content));
  });
});

describe("tryReanchorExact", () => {
  it("re-anchors an unchanged block at the stored offsets", () => {
    const anchor = deriveOver(BLOCK, 4, 8); // "best"
    const result = tryReanchorExact(BLOCK, anchor);
    expect(result).toEqual({ status: "anchored", charStart: 4, charEnd: 8 });
  });

  it("returns stale when the block no longer exists (null)", () => {
    const anchor = deriveOver(BLOCK, 4, 8);
    expect(tryReanchorExact(null, anchor)).toEqual({ status: "stale" });
  });

  it("returns stale when the stored quote no longer matches anywhere", () => {
    const anchor = deriveOver(BLOCK, 4, 8); // "best"
    const changed = "The worst code is no code.";
    expect(tryReanchorExact(changed, anchor)).toEqual({ status: "stale" });
  });

  it("re-anchors a passage that shifted a few characters within the same block", () => {
    const anchor = deriveOver(BLOCK, 4, 8); // "best" at offset 4
    const shifted = "Truly, " + BLOCK; // "best" now at offset 11
    const result = tryReanchorExact(shifted, anchor);
    expect(result).toEqual({ status: "anchored", charStart: 11, charEnd: 15 });
    // It is the SAME passage that moved, not a relocation.
    if (result.status === "anchored") {
      expect(shifted.slice(result.charStart, result.charEnd)).toBe("best");
    }
  });

  it("never relocates to a far-away occurrence of the same quote", () => {
    // "best" was at offset 4; the original passage is deleted and the only
    // remaining "best" is far outside the bounded nearby window.
    const farAway = "x".repeat(400) + "best" + "y".repeat(50); // "best" at offset 400
    const anchor = deriveOver(BLOCK, 4, 8); // stored offset 4
    expect(tryReanchorExact(farAway, anchor)).toEqual({ status: "stale" });
  });

  it("is stale when the quote occurs more than once within the nearby window (ambiguous)", () => {
    // The original passage no longer matches at the stored offset, and the same
    // quote now appears twice near it. We cannot tell which (if either) is the
    // moved original, so we never relocate to an arbitrary one.
    const anchor = deriveOver(BLOCK, 4, 8); // quote "best", stored offset 4
    const ambiguous = "a best b best c"; // "best" at offsets 2 and 9
    expect(ambiguous.slice(4, 8)).not.toBe("best"); // stored offset no longer matches
    expect(tryReanchorExact(ambiguous, anchor)).toEqual({ status: "stale" });
  });

  it("keeps the exact-offset match even when a duplicate quote sits nearby", () => {
    // The passage is unchanged at the stored offset; a second copy of the quote
    // nearby must not turn the unambiguous exact match into a stale relocation.
    const anchor = deriveOver(BLOCK, 4, 8); // quote "best", stored offset 4
    const withDuplicate = "The best and best code."; // "best" at offsets 4 and 13
    expect(withDuplicate.slice(4, 8)).toBe("best");
    expect(tryReanchorExact(withDuplicate, anchor)).toEqual({
      status: "anchored",
      charStart: 4,
      charEnd: 8,
    });
  });

  it("re-anchors a unique nearby shift while ignoring a duplicate outside the window", () => {
    // One occurrence shifted inside the window plus an unrelated occurrence far
    // outside it: the in-window match is unique, so the out-of-window copy does
    // not make it ambiguous.
    const anchor = deriveOver(BLOCK, 4, 8); // quote "best", stored offset 4
    const shifted = "Hi best " + "z".repeat(100) + "best"; // "best" at 3 and 108
    expect(shifted.indexOf("best")).toBe(3);
    expect(shifted.indexOf("best", 4)).toBe(108);
    expect(tryReanchorExact(shifted, anchor)).toEqual({
      status: "anchored",
      charStart: 3,
      charEnd: 7,
    });
  });

  it("round-trips: derive then re-anchor on the same block yields the original offsets", () => {
    const anchor = deriveOver(BLOCK, 25, 30); // "Don't"[?] arbitrary slice
    const result = tryReanchorExact(BLOCK, anchor);
    expect(result).toEqual({
      status: "anchored",
      charStart: 25,
      charEnd: 30,
    });
  });
});
