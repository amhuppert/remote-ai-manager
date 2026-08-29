import { describe, expect, it } from "vitest";

import type {
  MarkdownAnnotationSource,
  ResolvedMarkdownAnnotation,
} from "@/components/document-viewer/annotation-contract";
import { buildNotepadRefXml } from "@/lib/notepads/references";
import type {
  NotepadCommentStatus,
  NotepadCommentAnchorState,
  ResolvedNotepadCommentThread,
} from "@/lib/notepads/schemas";

import {
  notepadAnnotationSources,
  withLiveAnchorStates,
} from "./notepad-review-annotations";

function threadFixture(
  id: string,
  overrides: {
    status?: NotepadCommentStatus;
    state?: NotepadCommentAnchorState;
    quote?: string;
    charStart?: number;
    charEnd?: number;
  } = {},
): ResolvedNotepadCommentThread {
  const quote = overrides.quote ?? "the migration";
  return {
    comment: {
      id,
      notepadId: "np-1",
      anchor: {
        sectionId: "release-notes",
        headingLabel: "Release notes",
        line: 3,
        charStart: overrides.charStart ?? 4,
        charEnd: overrides.charEnd ?? 4 + quote.length,
        quote,
        prefix: "See ",
        suffix: " lands.",
        notepadRevision: 6,
      },
      body: "Confirm the date.",
      status: overrides.status ?? "open",
      authorKind: "user",
      authorConversationId: null,
      createdAt: "2026-08-20T10:00:00Z",
      updatedAt: "2026-08-20T10:00:00Z",
      resolvedAt: null,
    },
    replies: [],
    passage: {
      quote,
      location: "Release notes, line 3",
      state: overrides.state ?? "anchored",
    },
  };
}

function liveFixture(
  id: string,
  status: ResolvedMarkdownAnnotation["anchorState"]["status"],
): ResolvedMarkdownAnnotation {
  const anchorState =
    status === "stale"
      ? ({ status: "stale" } as const)
      : ({ status, charStart: 0, charEnd: 9 } as const);
  return {
    id,
    anchor: { ...threadFixture(id).comment.anchor, docRevision: "6" },
    tone: "active",
    accessibleLabel: `Comment ${id}`,
    anchorState,
    block: null,
  };
}

/** The canonical notepad the fixture anchors are stated over: quote at offset 4. */
function contentFor(quote = "the migration"): string {
  return `# Release notes\n\nSee ${quote} lands.\n`;
}

/** What the rendering stamped on line 3 — by default, the fixture's own ids. */
function stampsFor(
  sectionId = "release-notes",
  headingLabel = "Release notes",
): ReadonlyMap<
  number,
  { sectionId: string; headingLabel: string; line: number }
> {
  return new Map([[3, { sectionId, headingLabel, line: 3 }]]);
}

describe("notepadAnnotationSources", () => {
  it("tones an open comment active and a resolved one settled", () => {
    const sources = notepadAnnotationSources(
      [
        threadFixture("c-open"),
        threadFixture("c-done", { status: "resolved" }),
      ],
      contentFor(),
      stampsFor(),
    );

    expect(sources.map(({ id, tone }) => ({ id, tone }))).toEqual([
      { id: "c-open", tone: "active" },
      { id: "c-done", tone: "settled" },
    ]);
  });

  it("carries the notepad revision as the seam's document revision", () => {
    const [source] = notepadAnnotationSources(
      [threadFixture("c-1")],
      contentFor(),
      stampsFor(),
    );

    expect(source?.anchor).toEqual({
      sectionId: "release-notes",
      headingLabel: "Release notes",
      line: 3,
      charStart: 4,
      charEnd: 17,
      quote: "the migration",
      prefix: "See ",
      suffix: " lands.",
      docRevision: "6",
    });
  });

  it("restates the offsets in the coordinates the rendered view paints in", () => {
    // The stored anchor counts canonical characters, reference tag included;
    // the seam measures a chip-free text. Handing the canonical offsets over
    // would point it past the passage by the tag's whole length.
    const refXml = buildNotepadRefXml({
      notepadId: "np-backlog",
      name: "Backlog",
      scope: "global",
      projectName: null,
    });
    const block = `${refXml} See the migration lands.`;
    const content = `# Release notes\n\n${block}\n`;

    const [source] = notepadAnnotationSources(
      [
        threadFixture("c-1", {
          charStart: block.indexOf("the migration"),
          charEnd: block.indexOf("the migration") + "the migration".length,
        }),
      ],
      content,
      stampsFor(),
    );

    expect(source?.anchor).toMatchObject({ charStart: 5, charEnd: 18 });
  });

  it("restates the block identity the rendering stamped when a heading was renamed", () => {
    // The section id is derived from the heading above the block, so renaming
    // the heading restamps a block whose text never changed. The seam finds a
    // block by line AND section, so forwarding the stored id would address a
    // block the document does not have.
    const [source] = notepadAnnotationSources(
      [threadFixture("c-1")],
      contentFor(),
      stampsFor("shipping-notes", "Shipping notes"),
    );

    expect(source?.anchor).toMatchObject({
      sectionId: "shipping-notes",
      headingLabel: "Shipping notes",
      line: 3,
      quote: "the migration",
      charStart: 4,
      charEnd: 17,
    });
  });

  it("keeps the stored identity while the document has not rendered", () => {
    // No stamps yet means the deferred rendering has not mounted, not that the
    // block lost its heading — inventing an empty section id would strand every
    // comment for the frames before the document appears.
    const [source] = notepadAnnotationSources(
      [threadFixture("c-1")],
      contentFor(),
      new Map(),
    );

    expect(source?.anchor).toMatchObject({
      sectionId: "release-notes",
      headingLabel: "Release notes",
    });
  });

  it("withholds a comment the canonical resolution reports stale", () => {
    // Handing a stale anchor to the annotator invites it to paint the quote
    // wherever it next occurs — the one thing exact-match anchoring forbids.
    const sources = notepadAnnotationSources(
      [threadFixture("c-live"), threadFixture("c-gone", { state: "stale" })],
      contentFor(),
      stampsFor(),
    );

    expect(sources.map(({ id }) => id)).toEqual(["c-live"]);
  });

  it("withholds a comment whose passage the current content no longer holds", () => {
    // The canonical passage state travels with the thread, so a listing that
    // predates an edit can still claim anchored — the projection is the second
    // check, and nothing unresolvable reaches the annotator.
    const sources = notepadAnnotationSources(
      [threadFixture("c-1")],
      contentFor("the rollout"),
      stampsFor(),
    );

    expect(sources).toEqual([]);
  });

  it("never restates a comment onto different text", () => {
    // The stamp only re-identifies the enclosing block. The passage itself is
    // still matched exactly, so a renamed heading over an EDITED passage stays
    // withheld rather than riding the new section id onto other text.
    const sources = notepadAnnotationSources(
      [threadFixture("c-1")],
      contentFor("the rollout"),
      stampsFor("shipping-notes", "Shipping notes"),
    );

    expect(sources).toEqual([]);
  });

  it("labels each annotation with the passage it quotes", () => {
    const [source] = notepadAnnotationSources(
      [threadFixture("c-1", { quote: "the backfill" })],
      contentFor("the backfill"),
      stampsFor(),
    );

    expect(source?.accessibleLabel).toContain("the backfill");
  });
});

/** The annotation the panel handed the seam for `id`, in whatever state. */
function sourceFixture(id: string): MarkdownAnnotationSource {
  const {
    anchorState: _state,
    block: _block,
    ...source
  } = liveFixture(id, "anchored");
  return source;
}

describe("withLiveAnchorStates", () => {
  it("keeps a comment anchored when every resolution locates it", () => {
    const [entry] = withLiveAnchorStates(
      [threadFixture("c-1")],
      [sourceFixture("c-1")],
      [liveFixture("c-1", "anchored")],
      true,
    );

    expect(entry?.stale).toBe(false);
  });

  it("marks a comment stale when the canonical resolution says so", () => {
    const [entry] = withLiveAnchorStates(
      [threadFixture("c-1", { state: "stale" })],
      [],
      [],
      true,
    );

    expect(entry?.stale).toBe(true);
  });

  it("marks a comment stale when the live rendering no longer holds it", () => {
    // The canonical text still matches but the rendered DOM does not, so the
    // highlight cannot paint — the badge must not claim otherwise.
    const [entry] = withLiveAnchorStates(
      [threadFixture("c-1")],
      [sourceFixture("c-1")],
      [liveFixture("c-1", "stale")],
      true,
    );

    expect(entry?.stale).toBe(true);
  });

  it("marks a withheld comment stale even before the document is rendered", () => {
    // Withholding is this panel resolving the anchor over the content it is
    // rendering, so it is a verdict on the text — not on the DOM — and it must
    // not wait on a rendering that would give the comment nowhere to paint.
    const [entry] = withLiveAnchorStates([threadFixture("c-1")], [], [], false);

    expect(entry?.stale).toBe(true);
  });

  it("leaves a comment anchored before any live resolution has run", () => {
    // The live pass resolves in a layout effect; until it does, an annotation
    // the panel did hand over keeps its anchored verdict rather than flashing
    // stale on mount.
    const [entry] = withLiveAnchorStates(
      [threadFixture("c-1")],
      [sourceFixture("c-1")],
      [],
      true,
    );

    expect(entry?.stale).toBe(false);
  });

  it("ignores the live verdict until the document is rendered", () => {
    // The notepad rendering is deferred: its first frames carry no stamped
    // blocks, so the live pass calls every comment stale. Badging them would
    // flash a lie past the reader on every open.
    const [entry] = withLiveAnchorStates(
      [threadFixture("c-1")],
      [sourceFixture("c-1")],
      [liveFixture("c-1", "stale")],
      false,
    );

    expect(entry?.stale).toBe(false);
  });

  it("still honours the canonical verdict before the document is rendered", () => {
    const [entry] = withLiveAnchorStates(
      [threadFixture("c-1", { state: "stale" })],
      [],
      [],
      false,
    );

    expect(entry?.stale).toBe(true);
  });

  it("preserves the thread order and payload it was given", () => {
    const threads = [threadFixture("c-1"), threadFixture("c-2")];

    expect(
      withLiveAnchorStates(
        threads,
        [sourceFixture("c-1"), sourceFixture("c-2")],
        [],
        true,
      ).map((e) => e.thread),
    ).toEqual(threads);
  });
});
