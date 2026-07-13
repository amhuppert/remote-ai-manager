// @vitest-environment jsdom
import { createRef } from "react";
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { DocumentMarkdown, SourceMappedDocumentMarkdown } from "./Markdown";
import {
  CC_HEADING_ATTR,
  CC_LINE_ATTR,
  CC_SECTION_ATTR,
  resolveBlockMeta,
  resolveSelectionMeta,
  slugifyHeading,
} from "./markdown-source-map";

const SOURCE_DOCUMENT = [
  "# Title",
  "",
  "Intro paragraph.",
  "",
  "## Repeated Section",
  "",
  "First section body.",
  "",
  "## Repeated Section",
  "",
  "Second section body.",
].join("\n");

function stripSourceMetadata(root: HTMLElement): string {
  const clone = root.cloneNode(true) as HTMLElement;
  clone.removeAttribute("data-markdown-source-mapped");
  for (const element of clone.querySelectorAll("*")) {
    element.removeAttribute(CC_LINE_ATTR);
    element.removeAttribute(CC_SECTION_ATTR);
    element.removeAttribute(CC_HEADING_ATTR);
  }
  return clone.outerHTML;
}

function paragraphWithText(container: HTMLElement, text: string): HTMLElement {
  const paragraph = Array.from(container.querySelectorAll("p")).find(
    (candidate) => candidate.textContent === text,
  );
  if (!paragraph) throw new Error(`Missing paragraph: ${text}`);
  return paragraph;
}

afterEach(cleanup);

describe("SourceMappedDocumentMarkdown", () => {
  it("adds stable source metadata without visible or accessible divergence", async () => {
    const documentRender = render(
      <DocumentMarkdown content={SOURCE_DOCUMENT} />,
    );
    await waitFor(
      () => {
        expect(
          documentRender.container.querySelector(
            '[data-markdown-intent="document"]',
          ),
        ).not.toBeNull();
      },
      { timeout: 10_000 },
    );
    const documentRoot = documentRender.container.querySelector<HTMLElement>(
      '[data-markdown-intent="document"]',
    )!;
    const documentRoles = Array.from(
      documentRoot.querySelectorAll("h1,h2,p"),
    ).map((element) => `${element.tagName}:${element.textContent}`);
    documentRender.unmount();

    const sourceRender = render(
      <SourceMappedDocumentMarkdown content={SOURCE_DOCUMENT} />,
    );
    await waitFor(
      () => {
        expect(
          sourceRender.container.querySelector(
            '[data-markdown-intent="document"]',
          ),
        ).not.toBeNull();
      },
      { timeout: 10_000 },
    );
    const sourceRoot = sourceRender.container.querySelector<HTMLElement>(
      '[data-markdown-intent="document"]',
    )!;
    const sourceRoles = Array.from(sourceRoot.querySelectorAll("h1,h2,p")).map(
      (element) => `${element.tagName}:${element.textContent}`,
    );

    expect(sourceRoles).toEqual(documentRoles);
    expect(stripSourceMetadata(sourceRoot)).toBe(
      stripSourceMetadata(documentRoot),
    );

    const intro = paragraphWithText(sourceRoot, "Intro paragraph.");
    expect(intro).toHaveAttribute(CC_LINE_ATTR, "3");
    expect(intro).toHaveAttribute(CC_SECTION_ATTR, "title");
    expect(intro).toHaveAttribute(CC_HEADING_ATTR, "Title");

    const second = paragraphWithText(sourceRoot, "Second section body.");
    expect(second).toHaveAttribute(CC_LINE_ATTR, "11");
    expect(second).toHaveAttribute(CC_SECTION_ATTR, "repeated-section-1");
    expect(second).toHaveAttribute(CC_HEADING_ATTR, "Repeated Section");
  });

  it("forwards its ref to the stable Markdown root", async () => {
    const ref = createRef<HTMLDivElement>();
    const { container } = render(
      <SourceMappedDocumentMarkdown ref={ref} content={SOURCE_DOCUMENT} />,
    );

    await waitFor(
      () => {
        const root = container.querySelector(
          '[data-markdown-intent="document"]',
        );
        expect(root).not.toBeNull();
        expect(ref.current).toBe(root);
      },
      { timeout: 10_000 },
    );
  });
});

describe("Markdown source-map helpers", () => {
  it("creates deterministic URL-safe heading slugs", () => {
    expect(slugifyHeading("  1. Repeated Section  ")).toBe(
      "1-repeated-section",
    );
    expect(slugifyHeading("***")).toBe("");
  });

  it("resolves same-block metadata and rejects cross-block selections", async () => {
    const { container } = render(
      <SourceMappedDocumentMarkdown content={SOURCE_DOCUMENT} />,
    );
    await waitFor(
      () => {
        expect(
          container.querySelector('[data-markdown-intent="document"]'),
        ).not.toBeNull();
      },
      { timeout: 10_000 },
    );
    const intro = paragraphWithText(container, "Intro paragraph.");
    const second = paragraphWithText(container, "Second section body.");
    const introText = intro.firstChild!;
    const secondText = second.firstChild!;

    expect(resolveBlockMeta(introText)).toEqual({
      sectionId: "title",
      headingLabel: "Title",
      line: 3,
    });

    const within = document.createRange();
    within.setStart(introText, 0);
    within.setEnd(introText, 5);
    expect(resolveSelectionMeta(within)).toEqual({
      sectionId: "title",
      headingLabel: "Title",
      line: 3,
    });

    const across = document.createRange();
    across.setStart(introText, 0);
    across.setEnd(secondText, 6);
    expect(resolveSelectionMeta(across)).toBeNull();
  });
});
