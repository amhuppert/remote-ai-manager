import { describe, expect, it } from "vitest";

import { resolveNotepadCommentAnchor } from "./comment-anchors";
import {
  notepadAnchorFromSelection,
  notepadAnchorInAnnotatableSpace,
  notepadNonAnnotatableSpans,
  projectNotepadBlock,
} from "./annotatable-projection";
import { buildNotepadRefXml } from "./references";
import type { NotepadCommentAnchor } from "./schemas";

/**
 * A selection is made over ANNOTATABLE text — Markdown syntax gone, reference
 * and image chips excluded — while an anchor is stated over CANONICAL text.
 * These pin the projection between the two: the excluded tokens are mapped
 * exactly (a reference tag is routinely longer than any bounded search), and a
 * passage that cannot be located honestly is refused rather than approximated.
 */

const REF_XML = buildNotepadRefXml({
  notepadId: "np-backlog",
  name: "Backlog",
  scope: "global",
  projectName: null,
});

const PARAGRAPH =
  "The migration lands on Tuesday, once the backfill finishes\nand the queue drains.";

/** Puts `block` on line 3, under a heading, with a section after it. */
function documentWith(block: string): string {
  return `# Release notes\n\n${block}\n\n## Risks\n\nNothing blocking.\n`;
}

/** What the rendered block yields for a selection of `quote` in `rendered`. */
function selectionOf(rendered: string, quote: string, line: number) {
  const charStart = rendered.indexOf(quote);
  if (charStart === -1) throw new Error(`fixture quote absent: ${quote}`);
  return {
    sectionId: "release-notes",
    headingLabel: "Release notes",
    line,
    charStart,
    charEnd: charStart + quote.length,
    quote,
  };
}

function anchorFor(
  blockText: string,
  quote: string,
  overrides: Partial<NotepadCommentAnchor> = {},
): NotepadCommentAnchor {
  const charStart = blockText.indexOf(quote);
  if (charStart === -1) throw new Error(`fixture quote absent: ${quote}`);
  const charEnd = charStart + quote.length;
  return {
    sectionId: "release-notes",
    headingLabel: "Release notes",
    line: 3,
    charStart,
    charEnd,
    quote,
    prefix: blockText.slice(Math.max(0, charStart - 32), charStart),
    suffix: blockText.slice(charEnd, charEnd + 32),
    notepadRevision: 1,
    ...overrides,
  };
}

describe("notepadNonAnnotatableSpans", () => {
  it("spans every reference tag and image token the rendering replaces", () => {
    const block = `See ${REF_XML} and [Image: img-a] now.`;

    expect(notepadNonAnnotatableSpans(block)).toEqual([
      { start: 4, end: 4 + REF_XML.length },
      {
        start: block.indexOf("[Image: img-a]"),
        end: block.indexOf("[Image: img-a]") + "[Image: img-a]".length,
      },
    ]);
  });

  it("leaves a tag the renderer keeps as literal text alone", () => {
    // Schema-invalid attributes: the transform does not chip it, so its
    // characters stay part of the annotatable text.
    expect(notepadNonAnnotatableSpans('a <notepad-ref bogus="x" /> b')).toEqual(
      [],
    );
  });

  it("leaves a reference tag inside inline code alone", () => {
    // The transform walks mdast, and `inlineCode` is a childless literal — so
    // the tag never becomes a chip and every one of its characters stays part
    // of the text the reader can select.
    expect(
      notepadNonAnnotatableSpans(`Use \`${REF_XML}\` in the body.`),
    ).toEqual([]);
  });

  it("leaves reference tags and image tokens inside a fenced block alone", () => {
    const block = `\`\`\`md\n${REF_XML}\n[Image: img-a]\n\`\`\``;

    expect(notepadNonAnnotatableSpans(block)).toEqual([]);
  });

  it("still spans a token outside the code that shares the block", () => {
    const block = `Write \`[Image: img-a]\` to embed ${REF_XML} here.`;

    expect(notepadNonAnnotatableSpans(block)).toEqual([
      {
        start: block.indexOf(REF_XML),
        end: block.indexOf(REF_XML) + REF_XML.length,
      },
    ]);
  });
});

describe("projectNotepadBlock", () => {
  it("removes the excluded tokens and maps offsets in both directions", () => {
    const block = `See ${REF_XML} before shipping.`;
    const projection = projectNotepadBlock(block);

    expect(projection.text).toBe("See  before shipping.");
    // "shipping" sits past the whole tag canonically and right after "before"
    // in what the reader can select.
    expect(projection.canonicalOf[projection.text.indexOf("shipping")]).toBe(
      block.indexOf("shipping"),
    );
    expect(projection.keptBefore[block.indexOf("shipping")]).toBe(
      projection.text.indexOf("shipping"),
    );
  });
});

describe("notepadAnchorFromSelection", () => {
  it("keeps the selected offsets when the rendered block matches the canonical one", () => {
    const content = documentWith(PARAGRAPH);
    const selection = selectionOf(PARAGRAPH, "backfill", 3);

    expect(notepadAnchorFromSelection(selection, content, 7)).toEqual({
      sectionId: "release-notes",
      headingLabel: "Release notes",
      line: 3,
      charStart: PARAGRAPH.indexOf("backfill"),
      charEnd: PARAGRAPH.indexOf("backfill") + "backfill".length,
      quote: "backfill",
      prefix: PARAGRAPH.slice(
        PARAGRAPH.indexOf("backfill") - 32,
        PARAGRAPH.indexOf("backfill"),
      ),
      suffix: PARAGRAPH.slice(
        PARAGRAPH.indexOf("backfill") + "backfill".length,
      ).slice(0, 32),
      notepadRevision: 7,
    });
  });

  it("projects onto the canonical offsets when rendering dropped heading syntax", () => {
    // The reader selects "Release" in the rendered heading "Release notes";
    // canonically that passage starts three characters later, past "## ".
    const content = "## Release notes\n\nBody text.\n";

    const anchor = notepadAnchorFromSelection(
      selectionOf("Release notes", "Release", 1),
      content,
      2,
    );

    expect(anchor).toMatchObject({
      line: 1,
      charStart: 3,
      charEnd: 10,
      quote: "Release",
      notepadRevision: 2,
    });
  });

  it("projects onto the canonical offsets when rendering dropped inline emphasis", () => {
    const block = "The **migration** lands on Tuesday.";
    const content = `# Release notes\n\n${block}\n`;

    const anchor = notepadAnchorFromSelection(
      selectionOf("The migration lands on Tuesday.", "migration", 3),
      content,
      4,
    );

    expect(anchor).toMatchObject({
      charStart: block.indexOf("migration"),
      charEnd: block.indexOf("migration") + "migration".length,
      quote: "migration",
    });
  });

  it("projects past a reference tag longer than the bounded re-anchor window", () => {
    // The tag exceeds the ±64-character search radius, so a passage after it
    // is reachable only by mapping the excluded token exactly.
    expect(REF_XML.length).toBeGreaterThan(64);
    const block = `See ${REF_XML} before shipping.`;
    const content = documentWith(block);

    const anchor = notepadAnchorFromSelection(
      selectionOf("See  before shipping.", "shipping", 3),
      content,
      4,
    );

    expect(anchor).toMatchObject({
      charStart: block.indexOf("shipping"),
      charEnd: block.indexOf("shipping") + "shipping".length,
      quote: "shipping",
    });
  });

  it("projects past an image token", () => {
    const block = "Before [Image: img-a] after the picture.";
    const content = documentWith(block);

    const anchor = notepadAnchorFromSelection(
      selectionOf("Before  after the picture.", "picture", 3),
      content,
      4,
    );

    expect(anchor).toMatchObject({
      charStart: block.indexOf("picture"),
      charEnd: block.indexOf("picture") + "picture".length,
      quote: "picture",
    });
  });

  it("projects a selection after reference XML the rendering kept literal", () => {
    // Inside inline code the tag is not a chip, so the reader selects over text
    // that still contains it. Treating it as excluded would push the search a
    // whole tag-length away from the passage and find nothing.
    const block = `Use \`${REF_XML}\` in the body.`;
    const content = documentWith(block);

    const anchor = notepadAnchorFromSelection(
      selectionOf(`Use ${REF_XML} in the body.`, "body", 3),
      content,
      4,
    );

    expect(anchor).toMatchObject({
      charStart: block.indexOf("body"),
      charEnd: block.indexOf("body") + "body".length,
      quote: "body",
    });
  });

  it("projects a selection inside a fenced block holding an image token", () => {
    const block = `\`\`\`md\n[Image: img-a] renders the diagram\n\`\`\``;
    const content = documentWith(block);

    const anchor = notepadAnchorFromSelection(
      selectionOf("md\n[Image: img-a] renders the diagram\n", "diagram", 3),
      content,
      4,
    );

    expect(anchor).toMatchObject({
      charStart: block.indexOf("diagram"),
      charEnd: block.indexOf("diagram") + "diagram".length,
      quote: "diagram",
    });
  });

  it("produces an anchor the canonical resolver immediately re-anchors", () => {
    const block = `The **migration** lands, see ${REF_XML} for the rest.`;
    const content = `# Release notes\n\n${block}\n`;

    const anchor = notepadAnchorFromSelection(
      selectionOf("The migration lands, see  for the rest.", "rest", 3),
      content,
      4,
    );
    if (anchor === null) throw new Error("expected an anchor");

    expect(resolveNotepadCommentAnchor(anchor, content)).toEqual({
      state: "anchored",
      charStart: anchor.charStart,
      charEnd: anchor.charEnd,
    });
  });

  it("refuses a selection that runs across a reference chip", () => {
    // The run exists in the annotatable text but covers canonical characters
    // the reader never saw — the chip's XML — so there is no honest canonical
    // passage to anchor it to.
    const content = documentWith(`See ${REF_XML} before Tuesday.`);

    expect(
      notepadAnchorFromSelection(
        selectionOf("See  before Tuesday.", "See  before", 3),
        content,
        1,
      ),
    ).toBeNull();
  });

  it("refuses a selection that matches the canonical block ambiguously", () => {
    // A blockquote: the rendered text loses the "> " marker, so the selected
    // offsets no longer land on the passage — and the quote occurs twice, so
    // there is no unambiguous canonical passage to project onto.
    const content = documentWith("> migration and migration");

    expect(
      notepadAnchorFromSelection(
        selectionOf("migration and migration", "migration", 3),
        content,
        1,
      ),
    ).toBeNull();
  });

  it("refuses a selection whose line no longer holds a block", () => {
    expect(
      notepadAnchorFromSelection(
        selectionOf(PARAGRAPH, "backfill", 3),
        "# Release notes\n",
        1,
      ),
    ).toBeNull();
  });
});

describe("notepadAnchorInAnnotatableSpace", () => {
  it("restates a passage after a reference chip in the coordinates the view paints in", () => {
    const block = `See ${REF_XML} before shipping.`;
    const content = documentWith(block);
    const anchor = anchorFor(block, "shipping");

    // Canonically the passage sits past the whole tag; in the rendered text the
    // tag contributes nothing, so the offsets shift back by its full length.
    expect(notepadAnchorInAnnotatableSpace(anchor, content)).toEqual({
      start: anchor.charStart - REF_XML.length,
      end: anchor.charEnd - REF_XML.length,
    });
  });

  it("follows the passage when an edit shifted it inside the block", () => {
    const block = `See ${REF_XML} before shipping.`;
    const edited = `See ${REF_XML} well before shipping.`;
    const anchor = anchorFor(block, "shipping");

    expect(
      notepadAnchorInAnnotatableSpace(anchor, documentWith(edited)),
    ).toEqual({
      start: "See  well before ".length,
      end: "See  well before ".length + "shipping".length,
    });
  });

  it("paints a passage after reference XML the rendering kept literal at its own offsets", () => {
    // Nothing is excluded from a code span, so the canonical offsets are
    // already the ones the view paints in — shifting them by the tag's length
    // would leave the highlight and its gutter marker unresolvable.
    const block = `Use \`${REF_XML}\` in the body.`;
    const anchor = anchorFor(block, "body");

    expect(
      notepadAnchorInAnnotatableSpace(anchor, documentWith(block)),
    ).toEqual({ start: anchor.charStart, end: anchor.charEnd });
  });

  it("has nowhere to paint a passage quoting the chip's own text", () => {
    const block = `See ${REF_XML} before shipping.`;
    const content = documentWith(block);

    expect(
      notepadAnchorInAnnotatableSpace(anchorFor(block, REF_XML), content),
    ).toBeNull();
  });

  it("reports nothing for a passage the canonical resolution lost", () => {
    const block = "The migration lands on Tuesday.";
    const anchor = anchorFor(block, "migration");

    expect(
      notepadAnchorInAnnotatableSpace(
        anchor,
        documentWith(block.replace("migration", "rollout")),
      ),
    ).toBeNull();
  });
});
