// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, waitFor } from "@testing-library/react";
import { SourceMappedDocumentMarkdown } from "@/components/markdown/Markdown";
import type { DocumentComment } from "@/lib/document-comments/schemas";
import { projectMarkdownPassage } from "@/components/markdown/markdown-source-map";
import {
  blockAnnotatableText,
  deriveAnchorFromSelection,
  findCommentBlock,
  findCommentBlockCandidates,
  groupResolvedAnnotations,
  rangeFromBlockOffsets,
  rangesFromCommentAnchor,
  selectRenderableAnnotations,
  selectionOffsetsInBlock,
} from "./anchor-dom";

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

/**
 * Render the canonical source-mapped document adapter and wait for it to stamp
 * blocks (its renderer is deferred), so the anchor helpers run against the exact
 * DOM the annotated surface produces.
 */
async function renderDoc(): Promise<HTMLElement> {
  const { container } = render(<SourceMappedDocumentMarkdown content={DOC} />);
  await waitFor(() =>
    expect(container.querySelector("[data-cc-line]")).not.toBeNull(),
  );
  return container;
}

describe("findCommentBlock", () => {
  it("finds the stamped block matching an anchor's line + section", async () => {
    const container = await renderDoc();
    const anchor = baseComment({}).anchor;
    const block = findCommentBlock(container, anchor);
    expect(block).not.toBeNull();
    expect(block?.tagName.toLowerCase()).toBe("p");
    expect(block?.textContent).toContain("quotable passage");
  });

  it("returns null when no block matches", async () => {
    const container = await renderDoc();
    const block = findCommentBlock(container, {
      ...baseComment({}).anchor,
      line: 999,
    });
    expect(block).toBeNull();
  });

  it("prefers the deepest stamped block when a list and its item share source metadata", () => {
    const container = document.createElement("div");
    container.innerHTML = `
      <ul data-cc-line="7" data-cc-section="section-two">
        <li data-cc-line="7" data-cc-section="section-two">alpha beta</li>
      </ul>
    `;

    const candidates = findCommentBlockCandidates(container, {
      line: 7,
      sectionId: "section-two",
    });

    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.tagName).toBe("LI");
    expect(
      findCommentBlock(container, { line: 7, sectionId: "section-two" }),
    ).toBe(candidates[0]);
  });

  it("returns every ambiguous deepest candidate and refuses to choose one", () => {
    const container = document.createElement("div");
    container.innerHTML = `
      <ul data-cc-line="7" data-cc-section="section-two">
        <li data-cc-line="7" data-cc-section="section-two">same quote</li>
        <li data-cc-line="7" data-cc-section="section-two">same quote</li>
      </ul>
    `;

    const anchor = { line: 7, sectionId: "section-two" };
    expect(findCommentBlockCandidates(container, anchor)).toHaveLength(2);
    expect(findCommentBlock(container, anchor)).toBeNull();
  });
});

describe("rangeFromBlockOffsets", () => {
  it("builds a range whose text equals the passage at the given offsets", async () => {
    const container = await renderDoc();
    const block = findCommentBlock(container, baseComment({}).anchor)!;
    // "quotable" begins at offset 26 of "Body of section two has a quotable passage inside it."
    const text = block.textContent ?? "";
    const start = text.indexOf("quotable");
    const end = start + "quotable".length;
    const range = rangeFromBlockOffsets(block, start, end);
    expect(range).not.toBeNull();
    expect(range?.toString()).toBe("quotable");
  });

  it("returns null for out-of-bounds offsets", async () => {
    const container = await renderDoc();
    const block = findCommentBlock(container, baseComment({}).anchor)!;
    expect(rangeFromBlockOffsets(block, 0, 100000)).toBeNull();
  });
});

describe("neutral annotation grouping", () => {
  const blockA = document.createElement("p");
  const blockB = document.createElement("p");
  const annotation = (
    id: string,
    block: HTMLElement | null,
    tone: "active" | "settled",
  ) => ({
    id,
    anchor: baseComment({}).anchor,
    tone,
    accessibleLabel: `Annotation ${id}`,
    anchorState:
      block === null
        ? ({ status: "stale" } as const)
        : ({ status: "anchored", charStart: 0, charEnd: 4 } as const),
    block,
  });

  it("keeps only annotations with a healthy runtime block", () => {
    const result = selectRenderableAnnotations([
      annotation("a", blockA, "active"),
      annotation("b", null, "active"),
    ]);
    expect(result.map(({ id }) => id)).toEqual(["a"]);
  });

  it("groups by runtime block identity and keeps mixed groups active", () => {
    const groups = groupResolvedAnnotations([
      annotation("a", blockA, "settled"),
      annotation("b", blockA, "active"),
      annotation("c", blockB, "settled"),
      annotation("stale", null, "active"),
    ]);

    expect(groups).toHaveLength(2);
    expect(groups[0]).toMatchObject({
      block: blockA,
      ids: ["a", "b"],
      tone: "active",
      count: 2,
    });
    expect(groups[1]).toMatchObject({
      block: blockB,
      ids: ["c"],
      tone: "settled",
      count: 1,
    });
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

async function renderSelDoc(): Promise<HTMLElement> {
  const { container } = render(
    <SourceMappedDocumentMarkdown content={SEL_DOC} />,
  );
  await waitFor(() => expect(container.querySelector("ul li")).not.toBeNull());
  return container;
}

describe("blockAnnotatableText", () => {
  it("returns a paragraph's full text", async () => {
    const container = await renderSelDoc();
    const block = findCommentBlock(container, {
      line: 5,
      sectionId: "section-two",
    })!;
    expect(blockAnnotatableText(block)).toBe(
      "Body of section two has a quotable passage inside it.",
    );
  });

  it("returns a list item's text (the disc marker is a CSS pseudo, not text)", async () => {
    const container = await renderSelDoc();
    const li = container.querySelector("ul li") as HTMLElement;
    expect(blockAnnotatableText(li)).toBe("alpha beta gamma item");
  });
});

describe("selectionOffsetsInBlock", () => {
  it("round-trips offsets built by rangeFromBlockOffsets", async () => {
    const container = await renderSelDoc();
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

  it("maps a list item's offsets over its plain text", async () => {
    const container = await renderSelDoc();
    const li = container.querySelector("ul li") as HTMLElement;
    const range = rangeFromBlockOffsets(li, 0, "alpha".length)!;
    const offsets = selectionOffsetsInBlock(li, range);
    expect(offsets?.blockText).toBe("alpha beta gamma item");
    expect(offsets?.blockText.slice(0, 5)).toBe("alpha");
  });
});

describe("deriveAnchorFromSelection", () => {
  it("matches the source projection across nested lists, blockquotes, and code", async () => {
    const content = [
      "# Passage",
      "",
      "Prose with **emphasis**.",
      "",
      "- before",
      "  - nested",
      "- last",
      "",
      "> quoted",
      ">",
      "> second quote",
      "",
      "```ts",
      "const value = 1;",
      "",
      "value;",
      "```",
    ].join("\n");
    const { container } = render(
      <SourceMappedDocumentMarkdown content={content} />,
    );
    await waitFor(() => expect(container.querySelector("pre")).not.toBeNull());
    const range = document.createRange();
    range.selectNodeContents(container);
    const anchor = deriveAnchorFromSelection(range, content, container);

    expect(anchor?.endBlock).toBeDefined();
    if (!anchor?.endBlock) throw new Error("expected multi-block anchor");
    const projection = projectMarkdownPassage(
      content,
      anchor.line,
      anchor.endBlock.line,
    );
    expect(projection?.text).toBe(anchor.quote);
    expect(
      rangesFromCommentAnchor(container, anchor)
        .map((part) => part.toString())
        .join(""),
    ).toContain("const value = 1;\n\nvalue;");
  });

  it("derives a single-block anchor with the exact quote, heading, and line", async () => {
    const container = await renderSelDoc();
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

  it("anchors a selection spanning list items with element boundaries", async () => {
    const container = await renderSelDoc();
    const items = container.querySelectorAll("ul li");
    const range = document.createRange();
    range.selectNodeContents(items[0]!);
    range.setEnd(items[1]!, items[1]!.childNodes.length);
    expect(deriveAnchorFromSelection(range, SEL_DOC)).toMatchObject({
      line: 7,
      endBlock: { line: 8, sectionId: "section-two" },
      quote: "alpha beta gamma item\n\nsecond list item here",
      charStart: 0,
      charEnd: 44,
    });
  });

  it("preserves direct list text around nested items without duplicating descendants", () => {
    const container = document.createElement("div");
    container.innerHTML =
      '<ul data-cc-line="1"><li data-cc-line="1">before<ul data-cc-line="2"><li data-cc-line="2">nested</li></ul>after</li><li data-cc-line="3">last</li></ul>';
    const range = document.createRange();
    range.selectNodeContents(container);

    expect(deriveAnchorFromSelection(range, "source")).toMatchObject({
      line: 1,
      endBlock: { line: 3, sectionId: "" },
      quote: "before\n\nnested\n\nafter\n\nlast",
    });
  });

  it("skips protected text while preserving selected prose and code across sections", () => {
    const container = document.createElement("div");
    container.innerHTML =
      '<p data-cc-line="1" data-cc-section="one">first <span class="not-annotatable">hidden</span>paragraph</p>\n<h2 data-cc-line="3" data-cc-section="two">Heading</h2>\n<pre data-cc-line="5" data-cc-section="two"><code>alpha\n\nbeta\n</code></pre>';
    const range = document.createRange();
    range.setStart(container.querySelector("p")!.firstChild!, 2);
    range.setEnd(container.querySelector("code")!.firstChild!, 11);

    expect(deriveAnchorFromSelection(range, "source")).toMatchObject({
      line: 1,
      endBlock: { line: 5, sectionId: "two" },
      quote: "rst paragraph\n\nHeading\n\nalpha\n\nbeta",
      charStart: 2,
    });
  });

  it("rejects a collapsed (empty) selection", async () => {
    const container = await renderSelDoc();
    const block = findCommentBlock(container, {
      line: 5,
      sectionId: "section-two",
    })!;
    const range = rangeFromBlockOffsets(block, 3, 3)!;
    expect(deriveAnchorFromSelection(range, SEL_DOC)).toBeNull();
  });

  it("round-trips a passage that returns from a nested item to its parent", () => {
    const container = document.createElement("div");
    container.innerHTML =
      '<ul data-cc-line="1" data-cc-section=""><li data-cc-line="1" data-cc-section="">before<ul data-cc-line="2" data-cc-section=""><li data-cc-line="2" data-cc-section="">nested</li></ul>after</li></ul>';
    const parent = container.querySelector("li")!;
    const nested = parent.querySelector("li")!;
    const range = document.createRange();
    range.setStart(nested.firstChild!, 1);
    range.setEnd(parent.lastChild!, 3);

    const anchor = deriveAnchorFromSelection(range, "source", container);
    expect(anchor).toMatchObject({
      line: 2,
      endBlock: { line: 1, sectionId: "" },
      quote: "ested\n\naft",
    });
    if (!anchor) throw new Error("expected passage anchor");
    expect(
      rangesFromCommentAnchor(container, anchor).map((part) => part.toString()),
    ).toEqual(["ested", "aft"]);
  });

  it("keeps one-block offsets when element endpoints enclose inline markup", () => {
    const container = document.createElement("div");
    container.innerHTML =
      '<p data-cc-line="1" data-cc-section="">first <strong>important</strong> last</p>';
    const block = container.querySelector("p")!;
    const range = document.createRange();
    range.setStart(block, 1);
    range.setEnd(block, 2);

    expect(selectionOffsetsInBlock(block, range)).toEqual({
      blockText: "first important last",
      charStart: 6,
      charEnd: 15,
    });
    const anchor = deriveAnchorFromSelection(range, "source", container);
    expect(anchor).toMatchObject({
      quote: "important",
      charStart: 6,
      charEnd: 15,
    });
    expect(anchor?.endBlock).toBeUndefined();
  });

  it("does not include a block touched only at its empty end boundary", () => {
    const container = document.createElement("div");
    container.innerHTML =
      '<p data-cc-line="1" data-cc-section="">first</p><p data-cc-line="3" data-cc-section="">second</p>';
    const paragraphs = container.querySelectorAll("p");
    const range = document.createRange();
    range.setStart(paragraphs[0]!.firstChild!, 0);
    range.setEnd(paragraphs[1]!.firstChild!, 0);

    const anchor = deriveAnchorFromSelection(range, "source", container);
    expect(anchor?.quote).toBe("first");
    expect(anchor?.endBlock).toBeUndefined();
  });
});
