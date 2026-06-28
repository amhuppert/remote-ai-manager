// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import MarkdownViewer from "@/components/MarkdownViewer";
import {
  slugifyHeading,
  markdownViewerComponents,
  rehypeStampSourcePosition,
  resolveBlockMeta,
  resolveSelectionMeta,
} from "./markdown-components";

// A document with stable, known source line numbers:
//  1: # Title
//  2:
//  3: Intro paragraph.
//  4:
//  5: ## Section Two
//  6:
//  7: Body of section two.
//  8:
//  9: - alpha
// 10: - beta
// 11:
// 12: 1. one
// 13: 2. two
const DOC = [
  "# Title",
  "",
  "Intro paragraph.",
  "",
  "## Section Two",
  "",
  "Body of section two.",
  "",
  "- alpha",
  "- beta",
  "",
  "1. one",
  "2. two",
  "",
].join("\n");

function renderViewer() {
  return render(
    <MarkdownViewer
      content={DOC}
      isLoading={false}
      components={markdownViewerComponents}
      rehypePlugins={[rehypeStampSourcePosition]}
    />,
  );
}

function paragraphWithText(container: HTMLElement, text: string): HTMLElement {
  const p = Array.from(container.querySelectorAll("p")).find(
    (el) => el.textContent?.trim() === text,
  );
  if (!p) throw new Error(`paragraph not found: ${text}`);
  return p;
}

describe("slugifyHeading", () => {
  it("produces a deterministic, url-safe slug", () => {
    expect(slugifyHeading("Section Two")).toBe("section-two");
    expect(slugifyHeading("1. Overview")).toBe("1-overview");
    expect(slugifyHeading("  Trim  Me  ")).toBe("trim-me");
    expect(slugifyHeading("Section Two")).toBe(slugifyHeading("Section Two"));
  });
});

describe("rehypeStampSourcePosition", () => {
  it("stamps each block with its source line", () => {
    const { container } = renderViewer();
    const body = paragraphWithText(container, "Body of section two.");
    expect(body.getAttribute("data-cc-line")).toBe("7");

    const intro = paragraphWithText(container, "Intro paragraph.");
    expect(intro.getAttribute("data-cc-line")).toBe("3");
  });

  it("stamps each block with its nearest-heading section id and label", () => {
    const { container } = renderViewer();
    const body = paragraphWithText(container, "Body of section two.");
    expect(body.getAttribute("data-cc-section")).toBe("section-two");
    expect(body.getAttribute("data-cc-heading")).toBe("Section Two");

    const intro = paragraphWithText(container, "Intro paragraph.");
    expect(intro.getAttribute("data-cc-section")).toBe("title");
    expect(intro.getAttribute("data-cc-heading")).toBe("Title");
  });

  it("flags unordered list items as bullets and leaves ordered items unflagged", () => {
    const { container } = renderViewer();
    const ulItem = container.querySelector("ul li");
    const olItem = container.querySelector("ol li");
    expect(ulItem?.getAttribute("data-cc-bullet")).toBe("true");
    expect(olItem?.getAttribute("data-cc-bullet")).toBeNull();
  });
});

describe("markdownViewerComponents li (chevron marker)", () => {
  it("renders a decorative chevron for unordered items but not ordered items", () => {
    const { container } = renderViewer();
    const ulItem = container.querySelector("ul li");
    const olItem = container.querySelector("ol li");

    const chevron = ulItem?.querySelector('[aria-hidden="true"]');
    expect(chevron).not.toBeNull();
    expect(chevron?.textContent).toBe("›"); // ›

    expect(olItem?.querySelector('[aria-hidden="true"]')).toBeNull();
    // ordered list keeps its rendered content
    expect(olItem?.textContent?.trim()).toBe("one");
  });
});

describe("resolveBlockMeta", () => {
  it("resolves the section/heading/line of the block containing a node", () => {
    const { container } = renderViewer();
    const body = paragraphWithText(container, "Body of section two.");
    const textNode = body.firstChild;
    expect(resolveBlockMeta(textNode)).toEqual({
      sectionId: "section-two",
      headingLabel: "Section Two",
      line: 7,
    });
  });

  it("returns null when no stamped block ancestor exists", () => {
    const detached = document.createElement("span");
    detached.textContent = "loose";
    expect(resolveBlockMeta(detached.firstChild)).toBeNull();
    expect(resolveBlockMeta(null)).toBeNull();
  });
});

describe("resolveSelectionMeta", () => {
  it("returns the single block's meta for a within-block selection", () => {
    const { container } = renderViewer();
    const body = paragraphWithText(container, "Body of section two.");
    const textNode = body.firstChild as Text;
    const range = document.createRange();
    range.setStart(textNode, 0);
    range.setEnd(textNode, 4); // "Body"
    expect(resolveSelectionMeta(range)).toEqual({
      sectionId: "section-two",
      headingLabel: "Section Two",
      line: 7,
    });
  });

  it("rejects a selection spanning more than one block", () => {
    const { container } = renderViewer();
    const items = container.querySelectorAll("ul li");
    expect(items.length).toBeGreaterThanOrEqual(2);
    const range = document.createRange();
    range.selectNodeContents(items[0]!);
    range.setEnd(items[1]!, items[1]!.childNodes.length);
    expect(resolveSelectionMeta(range)).toBeNull();
  });
});
