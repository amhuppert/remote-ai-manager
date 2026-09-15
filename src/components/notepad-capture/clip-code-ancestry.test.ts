// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import type { ClipSelectionContext } from "@/components/document-viewer/annotation-contract";

import { selectionLiesWithinCode } from "./clip-code-ancestry";

/**
 * A selection as the annotation seam describes it, over DOM shaped the way the
 * canonical Markdown renderer emits it. `block` is the STAMPED block — for a
 * fenced block that is the renderer's wrapping container, not the `<pre>`.
 */
function selection(html: string, text: string): ClipSelectionContext {
  const host = document.createElement("div");
  host.innerHTML = html;
  const block = host.firstElementChild;
  if (!(block instanceof HTMLElement)) throw new Error("no block rendered");
  return { ...selectionOver(block, text), block };
}

/** A range over the deepest text node holding `text`, as a browser resolves one. */
function selectionOver(
  block: HTMLElement,
  text: string,
): Omit<ClipSelectionContext, "block"> {
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  while (node !== null && !(node.textContent ?? "").includes(text)) {
    node = walker.nextNode();
  }
  if (node === null) throw new Error(`no text node holds ${text}`);
  const start = (node.textContent ?? "").indexOf(text);
  const range = document.createRange();
  range.setStart(node, start);
  range.setEnd(node, start + text.length);
  return {
    anchor: {
      sectionId: "usage",
      headingLabel: "Usage",
      line: 7,
      charStart: start,
      charEnd: start + text.length,
      quote: text,
      prefix: "",
      suffix: "",
      docRevision: "rev",
    },
    text,
    range,
  };
}

/** How the canonical renderer emits a fence: stamps on the WRAPPER, pre inside. */
const FENCED =
  '<div data-markdown-code-block data-code-language="ts" data-cc-line="7">' +
  "<pre><code>const landed = await land(fragment);</code></pre></div>";

describe("selectionLiesWithinCode", () => {
  it("treats a selection spanning a fenced block and following prose as prose", () => {
    const host = document.createElement("div");
    host.innerHTML = `${FENCED}<p>Explanation after code.</p>`;
    const block = host.firstElementChild;
    const start = block?.querySelector("code")?.firstChild;
    const end = host.lastElementChild?.firstChild;
    if (!(block instanceof HTMLElement) || !start || !end)
      throw new Error("no passage");
    const range = document.createRange();
    range.setStart(start, 0);
    range.setEnd(end, 11);
    expect(
      selectionLiesWithinCode({
        ...selectionOver(block, "const landed"),
        block,
        range,
      }),
    ).toBe(false);
  });

  it("treats a fenced block as code though the stamp sits on the wrapper", () => {
    expect(selectionLiesWithinCode(selection(FENCED, "const landed"))).toBe(
      true,
    );
  });

  it("treats the renderer's un-fenced fallback, which stamps the pre, as code", () => {
    expect(
      selectionLiesWithinCode(
        selection(
          '<pre data-cc-line="7"><code>indented block</code></pre>',
          "indented",
        ),
      ),
    ).toBe(true);
  });

  it("treats an inline code span inside a prose block as code", () => {
    expect(
      selectionLiesWithinCode(
        selection(
          '<p data-cc-line="5">Read it with <code>cctl notepad get np-1</code> first.</p>',
          "notepad get",
        ),
      ),
    ).toBe(true);
  });

  it("treats ordinary prose as not code", () => {
    expect(
      selectionLiesWithinCode(
        selection(
          '<p data-cc-line="5">Read it with <code>cctl notepad get np-1</code> first.</p>',
          "Read it with",
        ),
      ),
    ).toBe(false);
  });

  it("treats a selection running out of a code span into its prose as not code", () => {
    const host = document.createElement("div");
    host.innerHTML =
      '<p data-cc-line="5">Read <code>cctl notepad get</code> first.</p>';
    const block = host.firstElementChild;
    if (!(block instanceof HTMLElement)) throw new Error("no block");
    const code = block.querySelector("code")?.firstChild;
    const tail = block.lastChild;
    if (code === null || code === undefined || tail === null) {
      throw new Error("unexpected block shape");
    }
    const range = document.createRange();
    range.setStart(code, 5);
    range.setEnd(tail, 3);

    expect(
      selectionLiesWithinCode({
        anchor: {
          sectionId: "usage",
          headingLabel: "Usage",
          line: 5,
          charStart: 10,
          charEnd: 23,
          quote: "notepad get f",
          prefix: "",
          suffix: "",
          docRevision: "rev",
        },
        text: "notepad get f",
        block,
        range,
      }),
    ).toBe(false);
  });
});
