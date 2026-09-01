// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import type { ClipSelectionContext } from "@/components/document-viewer/annotation-contract";
import { buildClipFragment } from "@/lib/notepads/capture-fragment";
import { buildNotepadRefXml } from "@/lib/notepads/references";

import { notepadReviewClipCapability } from "./notepad-review-clip";

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
      sectionId: "release-plan",
      headingLabel: "Release plan",
      line: 3,
      charStart: 0,
      charEnd: text.length,
      quote: text,
      prefix: "",
      suffix: "",
      docRevision: "7",
    },
    text,
    block,
    range,
  };
}

const SOURCE = {
  notepadId: "np-backlog",
  name: "Release checklist",
  scope: "project",
  projectName: "command-center",
} as const;

describe("notepadReviewClipCapability", () => {
  it("carries the source notepad's own reference as provenance", () => {
    const capability = notepadReviewClipCapability(SOURCE);

    expect(capability.enabled).toBe(true);
    expect(
      capability.buildProvenance(
        selectionIn("<p>migration lands Tuesday</p>", "migration lands"),
      ),
    ).toEqual({ kind: "ref", xml: buildNotepadRefXml(SOURCE) });
  });

  it("derives the code bit from the selection's rendered ancestry", () => {
    const capability = notepadReviewClipCapability(SOURCE);

    expect(
      capability.deriveIsCode(
        selectionIn("<p>migration lands Tuesday</p>", "migration lands"),
      ),
    ).toBe(false);
    expect(
      capability.deriveIsCode(
        selectionIn(
          `<div data-markdown-code-block><pre><code>bun run migrate</code></pre></div>`,
          "bun run",
        ),
      ),
    ).toBe(true);
  });

  it("lands the quoted selection attributed to the notepad reference", () => {
    const capability = notepadReviewClipCapability(SOURCE);
    const selection = selectionIn(
      "<p>migration lands Tuesday</p>",
      "migration lands",
    );

    expect(
      buildClipFragment({
        text: selection.text,
        isCode: capability.deriveIsCode(selection),
        provenance: capability.buildProvenance(selection),
      }),
    ).toBe(`> migration lands\n— ${buildNotepadRefXml(SOURCE)}`);
  });

  it("addresses a global notepad without a project attribute", () => {
    const capability = notepadReviewClipCapability({
      ...SOURCE,
      scope: "global",
      projectName: null,
    });

    const provenance = capability.buildProvenance(
      selectionIn("<p>migration lands Tuesday</p>", "migration lands"),
    );
    expect(provenance.kind).toBe("ref");
    expect(provenance.kind === "ref" ? provenance.xml : "").toContain(
      'scope="global"',
    );
    expect(provenance.kind === "ref" ? provenance.xml : "").not.toContain(
      "project-name=",
    );
  });
});
