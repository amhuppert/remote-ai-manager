// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import type { ClipSelectionContext } from "@/components/document-viewer/annotation-contract";
import { buildClipFragment } from "@/lib/notepads/capture-fragment";
import { buildSpecSectionReferenceXml } from "@/lib/prompt-editor/spec-reference-contract";

import { specSectionClipCapability } from "./spec-section-clip";

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
      sectionId: "intent",
      headingLabel: "Intent",
      line: 2,
      charStart: 0,
      charEnd: text.length,
      quote: text,
      prefix: "",
      suffix: "",
      docRevision: "rev-8",
    },
    text,
    block,
    range,
  };
}

const SOURCE = {
  projectName: "command-center",
  slug: "notepad",
  elementId: "sec-intent",
  sectionTitle: "Intent",
  revision: 8,
};

const EXPECTED_XML = buildSpecSectionReferenceXml({
  projectName: "command-center",
  slug: "notepad",
  elementId: "sec-intent",
  name: "Intent",
  revision: "8",
});

describe("specSectionClipCapability", () => {
  it("carries the selected section's reference as provenance", () => {
    const capability = specSectionClipCapability(SOURCE);

    expect(capability.enabled).toBe(true);
    expect(
      capability.buildProvenance(
        selectionIn("<p>capture is trust-critical</p>", "trust-critical"),
      ),
    ).toEqual({ kind: "ref", xml: EXPECTED_XML });
  });

  /**
   * The defect this pins: every section of a spec used to emit the spec's own
   * root reference, so two selections from different sections were provenance-
   * identical and neither read back to the prose that was quoted.
   */
  it("distinguishes two sections of the same spec", () => {
    const selection = selectionIn("<p>capture is trust-critical</p>", "trust");
    const intent = specSectionClipCapability(SOURCE).buildProvenance(selection);
    const scope = specSectionClipCapability({
      ...SOURCE,
      elementId: "sec-scope",
      sectionTitle: "Scope",
    }).buildProvenance(selection);

    expect(intent).not.toEqual(scope);
    expect(intent.kind === "ref" ? intent.xml : "").toContain(
      'element-id="sec-intent"',
    );
    expect(scope.kind === "ref" ? scope.xml : "").toContain(
      'element-id="sec-scope"',
    );
  });

  it("reads back to the selected section, not to the spec root", () => {
    const provenance = specSectionClipCapability(SOURCE).buildProvenance(
      selectionIn("<p>capture is trust-critical</p>", "trust-critical"),
    );

    expect(provenance.kind === "ref" ? provenance.xml : "").toContain(
      'read-command="cctl spec section get &apos;notepad&apos; --id &apos;sec-intent&apos; --project &apos;command-center&apos;"',
    );
  });

  it("names the revision on screen, so a later revision is not misquoted", () => {
    const capability = specSectionClipCapability({ ...SOURCE, revision: 3 });

    const provenance = capability.buildProvenance(
      selectionIn("<p>capture is trust-critical</p>", "trust-critical"),
    );
    expect(provenance.kind === "ref" ? provenance.xml : "").toContain(
      'revision="3"',
    );
  });

  it("derives the code bit from the selection's rendered ancestry", () => {
    const capability = specSectionClipCapability(SOURCE);

    expect(
      capability.deriveIsCode(
        selectionIn("<p>capture is trust-critical</p>", "trust-critical"),
      ),
    ).toBe(false);
    expect(
      capability.deriveIsCode(
        selectionIn(
          `<div data-markdown-code-block><pre><code>cctl notepad get np-1</code></pre></div>`,
          "cctl",
        ),
      ),
    ).toBe(true);
  });

  it("lands the quoted selection attributed to the section reference", () => {
    const capability = specSectionClipCapability(SOURCE);
    const selection = selectionIn(
      "<p>capture is trust-critical</p>",
      "trust-critical",
    );

    expect(
      buildClipFragment({
        text: selection.text,
        isCode: capability.deriveIsCode(selection),
        provenance: capability.buildProvenance(selection),
      }),
    ).toBe(`> trust-critical\n— ${EXPECTED_XML}`);
  });
});
