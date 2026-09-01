// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import type { ClipSelectionContext } from "@/components/document-viewer/annotation-contract";
import { buildClipFragment } from "@/lib/notepads/capture-fragment";

import { documentClipCapability } from "./document-clip";

/**
 * A selection as the annotation seam describes it: the anchor a comment would
 * persist, the rendered text, and the live block it resolved within.
 */
function selectionIn(html: string, text: string): ClipSelectionContext {
  const host = document.createElement("div");
  host.innerHTML = html;
  const block = host.firstElementChild;
  if (!(block instanceof HTMLElement)) throw new Error("no block rendered");
  // A range over the deepest text node holding `text`, as a browser resolves a
  // real selection — the block alone cannot answer inline-code ancestry.
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  while (node !== null && !(node.textContent ?? "").includes(text)) {
    node = walker.nextNode();
  }
  if (node === null) throw new Error(`no text node holds ${text}`);
  const at = (node.textContent ?? "").indexOf(text);
  const range = document.createRange();
  range.setStart(node, at);
  range.setEnd(node, at + text.length);
  return {
    anchor: {
      sectionId: "overview",
      headingLabel: "Overview",
      line: 5,
      charStart: 0,
      charEnd: text.length,
      quote: text,
      prefix: "",
      suffix: "",
      docRevision: "rev",
    },
    text,
    block,
    range,
  };
}

const DOC_PATH = ".kiro/steering/structure.md";

describe("documentClipCapability", () => {
  it("carries the repo-relative document path as path provenance", () => {
    const capability = documentClipCapability(DOC_PATH);

    expect(capability.enabled).toBe(true);
    expect(
      capability.buildProvenance(
        selectionIn("<p>route adapters compose</p>", "route adapters compose"),
      ),
    ).toEqual({ kind: "path", path: DOC_PATH });
  });

  it("derives the code bit from the selection's rendered ancestry", () => {
    const capability = documentClipCapability(DOC_PATH);

    expect(
      capability.deriveIsCode(
        selectionIn("<p>route adapters compose</p>", "route adapters compose"),
      ),
    ).toBe(false);
    expect(
      capability.deriveIsCode(
        selectionIn(
          `<div data-markdown-code-block><pre><code>const route = compose();</code></pre></div>`,
          "const route = compose();",
        ),
      ),
    ).toBe(true);
  });

  it("lands a prose selection as a blockquote attributed to the path", () => {
    const capability = documentClipCapability(DOC_PATH);
    const selection = selectionIn(
      "<p>route adapters compose</p>",
      "route adapters compose",
    );

    expect(
      buildClipFragment({
        text: selection.text,
        isCode: capability.deriveIsCode(selection),
        provenance: capability.buildProvenance(selection),
      }),
    ).toBe(`> route adapters compose\n— ${DOC_PATH}`);
  });

  it("lands a code selection fenced rather than quoted", () => {
    const capability = documentClipCapability(DOC_PATH);
    const selection = selectionIn(
      `<div data-markdown-code-block><pre><code>const route = compose();</code></pre></div>`,
      "const route = compose();",
    );

    expect(
      buildClipFragment({
        text: selection.text,
        isCode: capability.deriveIsCode(selection),
        provenance: capability.buildProvenance(selection),
      }),
    ).toBe("```\nconst route = compose();\n```\n" + `— ${DOC_PATH}`);
  });
});
