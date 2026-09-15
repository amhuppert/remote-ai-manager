import { describe, expect, it } from "vitest";

import {
  describeNotepadCommentLocation,
  resolveNotepadCommentAnchor,
} from "./comment-anchors";
import { buildNotepadRefXml } from "./references";
import type { NotepadCommentAnchor } from "./schemas";

/**
 * Every fixture is a canonical notepad text — the exact string `cctl notepad
 * get` returns, reference XML and image tokens included — because that is the
 * text these anchors are defined over.
 */

const PARAGRAPH =
  "The migration lands on Tuesday, once the backfill finishes\nand the queue drains.";

/** Puts `block` on line 3, under a heading, with a section after it. */
function documentWith(block: string): string {
  return `# Release notes\n\n${block}\n\n## Risks\n\nNothing blocking.\n`;
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

describe("resolveNotepadCommentAnchor", () => {
  it("anchors a passage across paragraphs including their canonical separation", () => {
    const blocks = "The migration lands.\n\n\nConfirm the backfill.";
    const anchor = anchorFor(
      blocks,
      "migration lands.\n\n\nConfirm the backfill",
      {
        endBlock: { line: 6, sectionId: "release-notes" },
      },
    );

    expect(resolveNotepadCommentAnchor(anchor, documentWith(blocks))).toEqual({
      state: "anchored",
      charStart: anchor.charStart,
      charEnd: anchor.charEnd,
    });
    expect(
      resolveNotepadCommentAnchor(
        anchor,
        documentWith(blocks.replace("lands", "waits")),
      ),
    ).toEqual({ state: "stale" });
  });

  it("anchors an unchanged passage at its stored offsets", () => {
    const anchor = anchorFor(PARAGRAPH, "migration");

    expect(
      resolveNotepadCommentAnchor(anchor, documentWith(PARAGRAPH)),
    ).toEqual({
      state: "anchored",
      charStart: anchor.charStart,
      charEnd: anchor.charEnd,
    });
  });

  it("anchors a quote spanning the block's soft line break", () => {
    // The block is the contiguous line run, so an anchor may cross a newline
    // inside it — the offsets are over the whole block, not one line.
    const anchor = anchorFor(PARAGRAPH, "finishes\nand the queue");

    expect(
      resolveNotepadCommentAnchor(anchor, documentWith(PARAGRAPH)),
    ).toEqual({
      state: "anchored",
      charStart: anchor.charStart,
      charEnd: anchor.charEnd,
    });
  });

  it("anchors a passage below a blank line inside a fenced code block", () => {
    // A fence is one rendered block and one stamp — its opening line — but a
    // blank line inside it does not end it. Reading the block as "lines until
    // the first blank one" would truncate the code and lose every passage
    // below the blank line.
    const block = "```js\nconst alpha = 1;\n\nconst beta = 2;\n```";
    const anchor = anchorFor(block, "beta");

    expect(resolveNotepadCommentAnchor(anchor, documentWith(block))).toEqual({
      state: "anchored",
      charStart: anchor.charStart,
      charEnd: anchor.charEnd,
    });
  });

  it("anchors a passage below a blank line inside an indented code block", () => {
    const block = "    const alpha = 1;\n\n    const beta = 2;";
    const anchor = anchorFor(block, "beta");

    expect(resolveNotepadCommentAnchor(anchor, documentWith(block))).toEqual({
      state: "anchored",
      charStart: anchor.charStart,
      charEnd: anchor.charEnd,
    });
  });

  it("stops a fenced block at its closing fence, not at later content", () => {
    // The prose after the fence is a different block with its own stamp;
    // pulling it into the fence's block text would let an anchor resolve
    // against text the reader sees somewhere else entirely.
    const content = documentWith("```\nalpha\n\nbeta\n```\n\nProse after.");
    // Anchored at the fence's opening line, quoting text that lives past its
    // closing fence.
    const anchor = anchorFor("Prose after.", "Prose after.");

    expect(resolveNotepadCommentAnchor(anchor, content)).toEqual({
      state: "stale",
    });
  });

  it("anchors a passage that an earlier edit shifted within its block", () => {
    const anchor = anchorFor(PARAGRAPH, "migration");
    const edited = `The database ${PARAGRAPH.slice(4)}`;

    const resolution = resolveNotepadCommentAnchor(
      anchor,
      documentWith(edited),
    );

    expect(resolution).toEqual({
      state: "anchored",
      charStart: edited.indexOf("migration"),
      charEnd: edited.indexOf("migration") + "migration".length,
    });
  });

  it("reports stale once the quoted passage is edited away", () => {
    const anchor = anchorFor(PARAGRAPH, "migration");
    const edited = PARAGRAPH.replace("migration", "rollout");

    expect(resolveNotepadCommentAnchor(anchor, documentWith(edited))).toEqual({
      state: "stale",
    });
  });

  it("reports stale when the quote matches ambiguously in more than one place", () => {
    const anchor = anchorFor("The migration lands on Tuesday.", "migration");
    const duplicated = "A migration and the migration land on Tuesday.";

    // Both occurrences are equally good exact matches, so the comment stays
    // where it is rather than being guessed onto one of them.
    expect(
      resolveNotepadCommentAnchor(anchor, documentWith(duplicated)),
    ).toEqual({ state: "stale" });
  });

  it("never relocates to a far-away occurrence of the quote", () => {
    const anchor = anchorFor("The migration lands on Tuesday.", "migration");
    const rewritten = `The rollout lands on Tuesday. ${"Filler sentence. ".repeat(
      12,
    )}The migration is scheduled.`;

    expect(
      resolveNotepadCommentAnchor(anchor, documentWith(rewritten)),
    ).toEqual({ state: "stale" });
  });

  it("anchors over canonical text carrying reference XML and image tokens", () => {
    const refXml = buildNotepadRefXml({
      notepadId: "np-backlog",
      name: "Backlog",
      scope: "global",
      projectName: null,
    });
    const block = `See ${refXml} — the migration lands on Tuesday.\n[Image: img-a]`;

    for (const quote of ["migration", refXml, "[Image: img-a]"]) {
      const anchor = anchorFor(block, quote);
      expect(resolveNotepadCommentAnchor(anchor, documentWith(block))).toEqual({
        state: "anchored",
        charStart: anchor.charStart,
        charEnd: anchor.charEnd,
      });
    }
  });

  it("reports stale when the anchored line no longer holds a block", () => {
    const anchor = anchorFor(PARAGRAPH, "migration");

    // The paragraph was deleted: line 3 is now blank.
    expect(
      resolveNotepadCommentAnchor(anchor, "# Release notes\n\n\n\n## Risks\n"),
    ).toEqual({ state: "stale" });
    // And an anchor past the end of a shortened notepad.
    expect(resolveNotepadCommentAnchor(anchor, "# Release notes\n")).toEqual({
      state: "stale",
    });
    expect(resolveNotepadCommentAnchor(anchor, "")).toEqual({ state: "stale" });
  });

  it("reports stale for an empty quote rather than anchoring nothing", () => {
    const anchor = anchorFor(PARAGRAPH, "migration");

    expect(
      resolveNotepadCommentAnchor(
        { ...anchor, quote: "", charEnd: anchor.charStart },
        documentWith(PARAGRAPH),
      ),
    ).toEqual({ state: "stale" });
  });
});

describe("describeNotepadCommentLocation", () => {
  it("names the heading the passage sits under and its line", () => {
    expect(
      describeNotepadCommentLocation(anchorFor(PARAGRAPH, "migration")),
    ).toBe("Release notes, line 3");
  });

  it("falls back to the line alone above the first heading", () => {
    expect(
      describeNotepadCommentLocation(
        anchorFor(PARAGRAPH, "migration", {
          sectionId: "",
          headingLabel: "",
          line: 1,
        }),
      ),
    ).toBe("line 1");
  });
});
