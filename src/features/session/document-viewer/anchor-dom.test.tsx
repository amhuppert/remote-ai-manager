// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import MarkdownViewer from "@/components/MarkdownViewer";
import type { DocumentComment } from "@/lib/document-comments/schemas";
import {
  markdownViewerComponents,
  rehypeStampSourcePosition,
} from "./markdown-components";
import {
  blockAnnotatableText,
  deriveAnchorFromSelection,
  findCommentBlock,
  groupAnchoredComments,
  rangeFromBlockOffsets,
  selectAnchoredComments,
  selectionOffsetsInBlock,
} from "./anchor-dom";
import type { ResolvedComment } from "./types";

//  1: # Title
//  2:
//  3: ## Section Two
//  4:
//  5: Body of section two has a quotable passage inside it.
const DOC = [
  "# Title",
  "",
  "## Section Two",
  "",
  "Body of section two has a quotable passage inside it.",
  "",
].join("\n");

function baseComment(over: Partial<DocumentComment>): DocumentComment {
  return {
    id: "c1",
    projectPath: "/p",
    sessionName: "s",
    docPath: "doc.md",
    anchor: {
      sectionId: "section-two",
      headingLabel: "Section Two",
      line: 5,
      charStart: 0,
      charEnd: 4,
      quote: "Body",
      prefix: "",
      suffix: "",
      docRevision: "r1",
    },
    note: "n",
    status: "pending",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    sentAt: null,
    ...over,
  };
}

function resolved(
  over: Partial<DocumentComment>,
  reanchor: ResolvedComment["reanchor"],
): ResolvedComment {
  const c = baseComment(over);
  return { ...c, reanchor, stale: reanchor.status === "stale" };
}

function renderDoc() {
  return render(
    <MarkdownViewer
      content={DOC}
      isLoading={false}
      components={markdownViewerComponents}
      rehypePlugins={[rehypeStampSourcePosition]}
    />,
  );
}

describe("findCommentBlock", () => {
  it("finds the stamped block matching an anchor's line + section", () => {
    const { container } = renderDoc();
    const anchor = baseComment({}).anchor;
    const block = findCommentBlock(container, anchor);
    expect(block).not.toBeNull();
    expect(block?.tagName.toLowerCase()).toBe("p");
    expect(block?.textContent).toContain("quotable passage");
  });

  it("returns null when no block matches", () => {
    const { container } = renderDoc();
    const block = findCommentBlock(container, {
      ...baseComment({}).anchor,
      line: 999,
    });
    expect(block).toBeNull();
  });
});

describe("rangeFromBlockOffsets", () => {
  it("builds a range whose text equals the passage at the given offsets", () => {
    const { container } = renderDoc();
    const block = findCommentBlock(container, baseComment({}).anchor)!;
    // "quotable" begins at offset 26 of "Body of section two has a quotable passage inside it."
    const text = block.textContent ?? "";
    const start = text.indexOf("quotable");
    const end = start + "quotable".length;
    const range = rangeFromBlockOffsets(block, start, end);
    expect(range).not.toBeNull();
    expect(range?.toString()).toBe("quotable");
  });

  it("returns null for out-of-bounds offsets", () => {
    const { container } = renderDoc();
    const block = findCommentBlock(container, baseComment({}).anchor)!;
    expect(rangeFromBlockOffsets(block, 0, 100000)).toBeNull();
  });
});

describe("selectAnchoredComments", () => {
  it("keeps only comments that re-anchored, dropping stale ones", () => {
    const anchored = resolved(
      { id: "a" },
      {
        status: "anchored",
        charStart: 0,
        charEnd: 4,
      },
    );
    const stale = resolved({ id: "b" }, { status: "stale" });
    const result = selectAnchoredComments([anchored, stale]);
    expect(result.map((c) => c.id)).toEqual(["a"]);
  });
});

describe("groupAnchoredComments", () => {
  const anchoredAt = (
    id: string,
    line: number,
    status: "pending" | "sent",
  ): ResolvedComment =>
    resolved(
      { id, status, anchor: { ...baseComment({}).anchor, line } },
      { status: "anchored", charStart: 0, charEnd: 4 },
    );

  it("collapses co-located comments into one marker and counts them", () => {
    const groups = groupAnchoredComments([
      anchoredAt("a", 5, "sent"),
      anchoredAt("b", 5, "pending"),
      anchoredAt("c", 9, "sent"),
    ]);
    expect(groups).toHaveLength(2);
    const [block5, block9] = groups;
    expect(block5?.count).toBe(2);
    // a block with any pending comment reads as pending
    expect(block5?.status).toBe("pending");
    expect(block5?.representativeId).toBe("a");
    expect(block9?.count).toBe(1);
    expect(block9?.status).toBe("sent");
  });

  it("excludes stale comments from gutter markers", () => {
    const groups = groupAnchoredComments([
      anchoredAt("a", 5, "pending"),
      resolved(
        { id: "z", anchor: { ...baseComment({}).anchor, line: 5 } },
        {
          status: "stale",
        },
      ),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.count).toBe(1);
  });
});

// A doc with a paragraph (line 5) and an unordered list (lines 7-8).
//  5: Body of section two has a quotable passage inside it.
//  7: - alpha beta gamma item
//  8: - second list item here
const SEL_DOC = [
  "# Title", // 1
  "", // 2
  "## Section Two", // 3
  "", // 4
  "Body of section two has a quotable passage inside it.", // 5
  "", // 6
  "- alpha beta gamma item", // 7
  "- second list item here", // 8
  "", // 9
].join("\n");

function renderSelDoc() {
  return render(
    <MarkdownViewer
      content={SEL_DOC}
      isLoading={false}
      components={markdownViewerComponents}
      rehypePlugins={[rehypeStampSourcePosition]}
    />,
  );
}

describe("blockAnnotatableText", () => {
  it("returns a paragraph's full text", () => {
    const { container } = renderSelDoc();
    const block = findCommentBlock(container, {
      line: 5,
      sectionId: "section-two",
    })!;
    expect(blockAnnotatableText(block)).toBe(
      "Body of section two has a quotable passage inside it.",
    );
  });

  it("excludes the decorative chevron from a bullet's text", () => {
    const { container } = renderSelDoc();
    const li = container.querySelector("ul li") as HTMLElement;
    expect(li.textContent).toContain("›");
    const text = blockAnnotatableText(li);
    expect(text.includes("›")).toBe(false);
    expect(text).toBe("alpha beta gamma item");
  });
});

describe("selectionOffsetsInBlock", () => {
  it("round-trips offsets built by rangeFromBlockOffsets", () => {
    const { container } = renderSelDoc();
    const block = findCommentBlock(container, {
      line: 5,
      sectionId: "section-two",
    })!;
    const text = block.textContent ?? "";
    const start = text.indexOf("quotable passage");
    const end = start + "quotable passage".length;
    const range = rangeFromBlockOffsets(block, start, end)!;
    const offsets = selectionOffsetsInBlock(block, range);
    expect(offsets?.charStart).toBe(start);
    expect(offsets?.charEnd).toBe(end);
    expect(offsets?.blockText.slice(start, end)).toBe("quotable passage");
  });

  it("excludes the decorative chevron from a bullet's annotatable text", () => {
    const { container } = renderSelDoc();
    const li = container.querySelector("ul li") as HTMLElement;
    // The li's full text content includes the chevron glyph...
    expect(li.textContent).toContain("›");
    // ...but the annotatable block text used for offsets does not.
    const range = rangeFromBlockOffsets(li, 0, "alpha".length)!;
    const offsets = selectionOffsetsInBlock(li, range);
    expect(offsets?.blockText.startsWith("alpha beta gamma")).toBe(true);
    expect(offsets?.blockText.includes("›")).toBe(false);
    expect(offsets?.blockText.slice(0, 5)).toBe("alpha");
  });
});

describe("deriveAnchorFromSelection", () => {
  it("derives a single-block anchor with the exact quote, heading, and line", () => {
    const { container } = renderSelDoc();
    const block = findCommentBlock(container, {
      line: 5,
      sectionId: "section-two",
    })!;
    const text = block.textContent ?? "";
    const start = text.indexOf("quotable passage");
    const end = start + "quotable passage".length;
    const range = rangeFromBlockOffsets(block, start, end)!;

    const anchor = deriveAnchorFromSelection(range, SEL_DOC);
    expect(anchor).not.toBeNull();
    expect(anchor?.quote).toBe("quotable passage");
    expect(anchor?.headingLabel).toBe("Section Two");
    expect(anchor?.sectionId).toBe("section-two");
    expect(anchor?.line).toBe(5);
    expect(anchor?.charStart).toBe(start);
    expect(anchor?.charEnd).toBe(end);
    expect(anchor?.docRevision).toMatch(/.+/);
  });

  it("rejects a selection spanning more than one block (returns null)", () => {
    const { container } = renderSelDoc();
    const items = container.querySelectorAll("ul li");
    const range = document.createRange();
    range.selectNodeContents(items[0]!);
    range.setEnd(items[1]!, items[1]!.childNodes.length);
    expect(deriveAnchorFromSelection(range, SEL_DOC)).toBeNull();
  });

  it("rejects a collapsed (empty) selection", () => {
    const { container } = renderSelDoc();
    const block = findCommentBlock(container, {
      line: 5,
      sectionId: "section-two",
    })!;
    const range = rangeFromBlockOffsets(block, 3, 3)!;
    expect(deriveAnchorFromSelection(range, SEL_DOC)).toBeNull();
  });
});
