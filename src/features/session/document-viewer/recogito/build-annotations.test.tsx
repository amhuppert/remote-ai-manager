// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { deriveAnchorFromSelection } from "../anchor-dom";
import { resolveLiveMarkdownAnchors } from "../use-live-markdown-anchor-resolution";
import { markdownAnnotationsToTextAnnotations } from "./build-annotations";

describe("markdownAnnotationsToTextAnnotations", () => {
  it("paints every block of a passage under one annotation identity", () => {
    const container = document.createElement("div");
    container.innerHTML =
      '<p data-cc-line="1" data-cc-section="">first <strong>paragraph</strong></p><p data-cc-line="3" data-cc-section="">second <span class="not-annotatable">hidden</span>paragraph</p>';
    const range = document.createRange();
    range.selectNodeContents(container);
    const anchor = deriveAnchorFromSelection(range, "source", container);
    expect(anchor).not.toBeNull();
    if (!anchor) throw new Error("expected passage anchor");
    const sources = resolveLiveMarkdownAnchors(
      [
        {
          id: "comment-1",
          anchor,
          tone: "active" as const,
          accessibleLabel: "Comment",
        },
      ],
      container,
    );

    const annotations = markdownAnnotationsToTextAnnotations(
      sources,
      container,
    );

    expect(annotations).toHaveLength(1);
    expect(annotations[0]?.id).toBe("comment-1");
    expect(
      annotations[0]?.target.selector.map((selector) => selector.quote),
    ).toEqual(["first ", "paragraph", "second ", "paragraph"]);
  });
});
