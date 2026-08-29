// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { _blockAnnotatableTextForTesting } from "@/components/document-viewer/AnnotatedMarkdown";
import { buildNotepadRefXml } from "@/lib/notepads/references";
import NotepadMarkdownRenderer from "./NotepadMarkdownRenderer";
import { CC_LINE_ATTR, CC_SECTION_ATTR } from "./markdown-source-map";

/**
 * The review surface anchors comments to blocks by their source position in the
 * CANONICAL notepad text, and counts anchor offsets over annotatable text only.
 * These pin both halves of that contract on the notepad renderer: the stamps
 * the seam's anchor resolution locates blocks by, and the exclusion of chips
 * (references and images) from the annotatable text model.
 */

beforeEach(() => {
  // Chip labels resolve through React Query; a stubbed 404 keeps the tests
  // offline and exercises the captured-name fallback path.
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(JSON.stringify({ error: "not found" }), { status: 404 }),
    ),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const NOTEPAD_XML = buildNotepadRefXml({
  notepadId: "np-7f3a",
  name: "Release checklist",
  scope: "project",
  projectName: "command-center",
});

function renderNotepad(content: string) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <NotepadMarkdownRenderer notepadId="np-host" content={content} />
    </QueryClientProvider>,
  );
}

function blockAt(container: HTMLElement, line: number): HTMLElement {
  const block = container.querySelector<HTMLElement>(
    `[${CC_LINE_ATTR}="${line}"]`,
  );
  if (block === null) throw new Error(`no block stamped at line ${line}`);
  return block;
}

describe("notepad review rendering — source-position stamps", () => {
  it("stamps each block with its line in the canonical text and its section", () => {
    const content = [
      "Intro before any heading.", // 1
      "", // 2
      "## Release plan", // 3
      "", // 4
      "Ship the checklist today.", // 5
      "", // 6
      "- first item", // 7
    ].join("\n");

    const { container } = renderNotepad(content);

    expect(blockAt(container, 1).tagName).toBe("P");
    expect(blockAt(container, 1).getAttribute(CC_SECTION_ATTR)).toBe("");

    const heading = blockAt(container, 3);
    expect(heading.tagName).toBe("H2");
    expect(heading.getAttribute(CC_SECTION_ATTR)).toBe("release-plan");

    const paragraph = blockAt(container, 5);
    expect(paragraph.textContent).toBe("Ship the checklist today.");
    expect(paragraph.getAttribute(CC_SECTION_ATTR)).toBe("release-plan");

    expect(blockAt(container, 7).getAttribute(CC_SECTION_ATTR)).toBe(
      "release-plan",
    );
  });

  it("stamps a block whose whole line is a reference with that line", () => {
    const content = ["Before.", "", NOTEPAD_XML, "", "After."].join("\n");

    const { container } = renderNotepad(content);

    const refBlock = blockAt(container, 3);
    expect(
      refBlock.querySelector('[data-testid="notepad-preview-chip"]'),
    ).not.toBeNull();
    expect(blockAt(container, 5).textContent).toBe("After.");
  });
});

describe("notepad review rendering — non-annotatable chips", () => {
  it("excludes a reference chip's label from the block's annotatable text", () => {
    const content = `Ship ${NOTEPAD_XML} today.`;

    const { container } = renderNotepad(content);

    const block = blockAt(container, 1);
    const chip = screen.getByTestId("notepad-preview-chip");
    expect(chip.textContent).not.toBe("");
    expect(block.textContent).toContain(chip.textContent);

    expect(_blockAnnotatableTextForTesting(block)).toBe("Ship  today.");
  });

  it("keeps reference XML and image tokens inside code annotatable", () => {
    // `code` and `inlineCode` are childless mdast literals, so the transform
    // never reaches into them and the tokens stay literal text. Anything
    // deriving the annotatable text from the canonical string has to honour the
    // same rule or its offsets drift by the whole token.
    const content = `Use \`${NOTEPAD_XML}\` in the body.\n\n\`\`\`\n[Image: img-1]\n\`\`\`\n`;

    const { container } = renderNotepad(content);

    expect(screen.queryByTestId("notepad-preview-chip")).toBeNull();
    expect(screen.queryByTestId("notepad-preview-image")).toBeNull();
    expect(_blockAnnotatableTextForTesting(blockAt(container, 1))).toBe(
      `Use ${NOTEPAD_XML} in the body.`,
    );
    expect(_blockAnnotatableTextForTesting(blockAt(container, 3))).toContain(
      "[Image: img-1]",
    );
  });

  it("keeps a soft line break and un-chipped raw html in the annotatable text", () => {
    // Two ways a block's canonical text could silently lose characters when it
    // is rendered, and neither does. remark-breaks turns the newline into a
    // `<br>`, but mdast-util-to-hast emits a literal newline text node beside
    // it, so the break still costs exactly its one canonical character; and a
    // reference tag that fails schema validation is left as visible text rather
    // than dropped. A projection that hid either would shift every offset after
    // it.
    const { container } = renderNotepad(
      `alpha\nbeta\n\nkeep <notepad-ref bogus="x" /> going\n`,
    );

    expect(_blockAnnotatableTextForTesting(blockAt(container, 1))).toBe(
      "alpha\nbeta",
    );
    expect(_blockAnnotatableTextForTesting(blockAt(container, 4))).toBe(
      'keep <notepad-ref bogus="x" /> going',
    );
  });

  it("excludes an embedded image and its unavailable placeholder", () => {
    const content = "Look at [Image: img-1] here.";

    const { container } = renderNotepad(content);

    const image = screen.getByTestId("notepad-preview-image");
    expect(image.closest(".not-annotatable")).not.toBeNull();
    expect(_blockAnnotatableTextForTesting(blockAt(container, 1))).toBe(
      "Look at  here.",
    );

    fireEvent.error(image);

    const placeholder = screen.getByTestId("notepad-image-placeholder");
    expect(placeholder.textContent).toContain("image unavailable");
    expect(_blockAnnotatableTextForTesting(blockAt(container, 1))).toBe(
      "Look at  here.",
    );
  });
});
