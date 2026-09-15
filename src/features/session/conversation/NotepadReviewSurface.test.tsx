// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  _blockAnnotatableTextForTesting,
  _rangeFromBlockOffsetsForTesting,
  _resetAnnotatorBoundaryForTesting,
  _setAnnotatorBoundaryForTesting,
} from "@/components/document-viewer/AnnotatedMarkdown";
import { buildNotepadRefXml } from "@/lib/notepads/references";
import type {
  NotepadComment,
  NotepadCommentReply,
  ResolvedNotepadCommentThread,
} from "@/lib/notepads/schemas";
import { useSessionDetailStore } from "@/stores/session-detail.store";
import { useToastStoreForTesting } from "@/stores/toast.store";
import { createTestQueryClient, renderWithQuery } from "@/test/component-mocks";
import { installFetchFixture, type FetchFixture } from "@/test/fetch-fixture";

import NotepadReviewSurface from "./NotepadReviewSurface";

/**
 * The recogito annotator paints via the CSS Custom Highlight API and cannot
 * mount under jsdom, so these run against the seam's passthrough boundary: the
 * host composition, the notepad rendering it supplies, and the canonical
 * projection a persisted comment is built from are all exercised; the highlight
 * painting itself is the verify context's live pass.
 */

let api: FetchFixture;

function PassthroughAnnotator({
  children,
}: {
  children: ReactNode;
}): React.JSX.Element {
  return <div data-test-annotator="passthrough">{children}</div>;
}

function conversationListItem(
  conversationId: string,
  status: "awaiting" | "running",
) {
  return {
    scope: "session" as const,
    projectName: "p1",
    projectPath: "/p1",
    worktreePath: "/p1/wt",
    sessionName: "s1",
    conversationId,
    conversationName: `conv ${conversationId}`,
    summary: null,
    firstPromptSnippet: null,
    backend: "claude" as const,
    backendRef: null,
    transcriptPath: null,
    debugLogPath: null,
    status,
    lastActivityAt: "2026-08-28T10:00:00.000Z",
    archived: false,
  };
}

/** The dispatch bar's target feed; the panel mounts it in every test. */
function stubConversations(
  items: ReturnType<typeof conversationListItem>[] = [],
) {
  api.json("GET", /^\/api\/conversations\/all/, {
    items,
    totalCount: items.length,
  });
}

beforeEach(() => {
  _setAnnotatorBoundaryForTesting(PassthroughAnnotator);
  api = installFetchFixture();
  stubConversations();
});

afterEach(() => {
  _resetAnnotatorBoundaryForTesting();
  api.restore();
  cleanup();
  vi.restoreAllMocks();
});

const NOTEPAD_XML = buildNotepadRefXml({
  notepadId: "np-backlog",
  name: "Release checklist",
  scope: "global",
  projectName: null,
});

const CONTENT = [
  "## Release plan", // 1
  "", // 2
  "The **migration** lands on Tuesday.", // 3
  "", // 4
  `See ${NOTEPAD_XML} before shipping.`, // 5
].join("\n");

/**
 * The same notepad after its heading was renamed. Line 3's passage is
 * byte-for-byte unchanged, but every block under the heading now renders with
 * the renamed heading's stamped section id rather than the one the anchor
 * stored.
 */
const RENAMED_HEADING_CONTENT = CONTENT.replace(
  "## Release plan",
  "## Shipping plan",
);

/** The same notepad after the commented passage itself was edited away. */
const EDITED_PASSAGE_CONTENT = CONTENT.replace("migration", "rollout");

/**
 * The same tag typed inside inline code. The transform never reaches into a
 * code literal, so it renders as visible text and stays part of what the reader
 * selects — the case where treating every tag as a chip drops characters that
 * are still on screen.
 */
const CODE_CONTENT = [
  "## Release plan", // 1
  "", // 2
  `Paste \`${NOTEPAD_XML}\` to embed the list.`, // 3
].join("\n");

const CODE_LINE = CODE_CONTENT.split("\n")[2] ?? "";

/**
 * The two blocks whose canonical text carries a newline the reader can select
 * across: a paragraph with a soft line break, and a fenced block whose body
 * contains a blank line — which does NOT end the block, though it does end an
 * ordinary one.
 */
const MULTILINE_CONTENT = [
  "## Release plan", // 1
  "", // 2
  "The backfill finishes tonight", // 3
  "and the queue drains by morning.", // 4
  "", // 5
  "```js", // 6
  "const alpha = 1;", // 7
  "", // 8
  "const beta = 2;", // 9
  "```", // 10
].join("\n");

const PARAGRAPH_BLOCK = MULTILINE_CONTENT.split("\n").slice(2, 4).join("\n");
const FENCE_BLOCK = MULTILINE_CONTENT.split("\n").slice(5, 10).join("\n");

function stubCreatedComment(id: string, body: string) {
  api.reply("POST", "/api/notepads/np-a/comments", (request) => ({
    status: 201,
    json: {
      comment: {
        id,
        notepadId: "np-a",
        anchor: (request.jsonBody as { anchor: unknown }).anchor,
        body,
        status: "open",
        authorKind: "user",
        authorConversationId: null,
        createdAt: "2026-08-28T10:00:00.000Z",
        updatedAt: "2026-08-28T10:00:00.000Z",
        resolvedAt: null,
      },
    },
  }));
}

function stubComments(threads: ResolvedNotepadCommentThread[] = []) {
  api.json("GET", "/api/notepads/np-a/comments", { comments: threads });
}

interface ThreadOptions {
  quote?: string;
  line?: number;
  /** Canonical offset of the quote; defaults to the line-3 fixture passage. */
  charStart?: number;
  body?: string;
  status?: "open" | "resolved";
  anchorState?: "anchored" | "stale";
  replies?: NotepadCommentReply[];
}

function commentThread(
  id: string,
  options: ThreadOptions = {},
): ResolvedNotepadCommentThread {
  const quote = options.quote ?? "migration";
  const line = options.line ?? 3;
  const charStart = options.charStart ?? 6;
  const comment: NotepadComment = {
    id,
    notepadId: "np-a",
    anchor: {
      sectionId: "release-plan",
      headingLabel: "Release plan",
      line,
      charStart,
      charEnd: charStart + quote.length,
      quote,
      prefix: "The ",
      suffix: " lands",
      notepadRevision: 4,
    },
    body: options.body ?? "Confirm the date.",
    status: options.status ?? "open",
    authorKind: "user",
    authorConversationId: null,
    createdAt: "2026-08-28T10:00:00.000Z",
    updatedAt: "2026-08-28T10:00:00.000Z",
    resolvedAt:
      options.status === "resolved" ? "2026-08-28T11:00:00.000Z" : null,
  };
  return {
    comment,
    replies: options.replies ?? [],
    passage: {
      quote,
      location: `Release plan · line ${line}`,
      state: options.anchorState ?? "anchored",
    },
  };
}

function stubCommentReply(comment: NotepadComment) {
  return () => ({ json: { comment } });
}

function renderSurface(content = CONTENT, revision = 4) {
  return renderWithQuery(
    <NotepadReviewSurface
      notepadId="np-a"
      notepadName="release plan"
      notepadScope="global"
      projectName="p1"
      sessionName="s1"
      content={content}
      revision={revision}
      active
    />,
    createTestQueryClient(),
  );
}

/** Select `quote` in the rendered text, exactly as a reader's drag would. */
function stubSelectionOverText(container: HTMLElement, quote: string): void {
  const block = Array.from(
    container.querySelectorAll<HTMLElement>("[data-cc-line]"),
  ).find((candidate) =>
    _blockAnnotatableTextForTesting(candidate).includes(quote),
  );
  if (block === undefined) throw new Error(`Could not find text: ${quote}`);
  const start = _blockAnnotatableTextForTesting(block).indexOf(quote);
  const range = _rangeFromBlockOffsetsForTesting(
    block,
    start,
    start + quote.length,
  );
  if (range === null) throw new Error(`Could not select text: ${quote}`);
  range.getBoundingClientRect = () =>
    ({ bottom: 0, height: 0, left: 0, right: 0, top: 0, width: 0 }) as DOMRect;
  vi.spyOn(window, "getSelection").mockReturnValue({
    isCollapsed: false,
    rangeCount: 1,
    getRangeAt: () => range,
    removeAllRanges: vi.fn(),
  } as unknown as Selection);
}

async function commentOn(
  container: HTMLElement,
  quote: string,
  note: string,
): Promise<void> {
  const user = userEvent.setup();
  stubSelectionOverText(container, quote);
  fireEvent.pointerUp(document);
  // The trigger and the popover it opens both mount asynchronously, so each
  // step waits for its control rather than assuming the previous click already
  // painted it — a synchronous lookup here fails under load, not by defect.
  await user.click(await screen.findByRole("button", { name: "Comment" }));
  await user.type(
    await screen.findByRole("textbox", { name: "Comment note" }),
    note,
  );
  await user.click(await screen.findByRole("button", { name: "Add comment" }));
}

describe("NotepadReviewSurface — the notepad's own rendering", () => {
  it("annotates the notepad dialect, not raw markdown", async () => {
    stubComments();
    const { container } = renderSurface();

    // The reference renders as its chip rather than as literal XML: the host
    // supplied the notepad renderer to the annotation seam.
    expect(await screen.findByTestId("notepad-preview-chip")).toBeVisible();
    expect(container.textContent).not.toContain("<notepad-ref");

    // And that rendering carries the canonical-line stamps anchoring needs.
    const lines = Array.from(
      container.querySelectorAll<HTMLElement>("[data-cc-line]"),
    ).map((block) => block.getAttribute("data-cc-line"));
    expect(lines).toContain("1");
    expect(lines).toContain("3");
    expect(lines).toContain("5");
  });
});

describe("NotepadReviewSurface — persisting a selection as a comment", () => {
  it("persists a rendered selection spanning formatted paragraphs", async () => {
    stubComments();
    stubCreatedComment("nc-span", "Review both paragraphs.");
    const content =
      "## Release plan\n\nThe **migration** lands.\n\n\nConfirm the backfill.";
    const { container } = renderSurface(content);
    await screen.findByText("Confirm the backfill.");
    const first = container.querySelector<HTMLElement>('[data-cc-line="3"]');
    const last = container.querySelector<HTMLElement>('[data-cc-line="6"]');
    if (first === null || last === null)
      throw new Error("fixture blocks did not render");
    const firstRange = _rangeFromBlockOffsetsForTesting(first, 4, 9);
    const lastRange = _rangeFromBlockOffsetsForTesting(last, 0, 20);
    if (firstRange === null || lastRange === null)
      throw new Error("fixture endpoints did not map");
    const range = document.createRange();
    range.setStart(firstRange.startContainer, firstRange.startOffset);
    range.setEnd(lastRange.endContainer, lastRange.endOffset);
    range.getBoundingClientRect = () => new DOMRect(0, 0, 100, 50);
    const selection = window.getSelection();
    if (selection === null) throw new Error("selection API unavailable");
    selection.removeAllRanges();
    selection.addRange(range);
    fireEvent.pointerUp(document);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Comment" }));
    await user.type(
      await screen.findByRole("textbox", { name: "Comment note" }),
      "Review both paragraphs.",
    );
    await user.click(
      await screen.findByRole("button", { name: "Add comment" }),
    );

    await waitFor(() =>
      expect(
        api.requestsTo("POST", "/api/notepads/np-a/comments")[0]?.jsonBody,
      ).toMatchObject({
        body: "Review both paragraphs.",
        anchor: {
          line: 3,
          endBlock: { line: 6, sectionId: "release-plan" },
          charStart: 6,
          quote: "migration** lands.\n\n\nConfirm the backfill",
          notepadRevision: 4,
        },
      }),
    );
  });

  it("persists an anchor stated over the canonical text", async () => {
    stubComments();
    api.reply("POST", "/api/notepads/np-a/comments", (request) => ({
      status: 201,
      json: {
        comment: {
          id: "nc-1",
          notepadId: "np-a",
          anchor: (request.jsonBody as { anchor: unknown }).anchor,
          body: "Confirm the date.",
          status: "open",
          authorKind: "user",
          authorConversationId: null,
          createdAt: "2026-08-28T10:00:00.000Z",
          updatedAt: "2026-08-28T10:00:00.000Z",
          resolvedAt: null,
        },
      },
    }));
    const { container } = renderSurface();
    await screen.findByTestId("notepad-preview-chip");

    await commentOn(container, "migration", "Confirm the date.");

    await waitFor(() =>
      expect(
        api.requestsTo("POST", "/api/notepads/np-a/comments")[0]?.jsonBody,
      ).toMatchObject({
        body: "Confirm the date.",
        anchor: {
          line: 3,
          quote: "migration",
          // Rendered, the passage starts at offset 4 ("The migration…");
          // canonically it starts at 6, past the emphasis marker. The stored
          // anchor is the canonical one, so `cctl notepad get` locates it.
          charStart: 6,
          charEnd: 15,
          notepadRevision: 4,
        },
      }),
    );
  });

  it("anchors a selection that follows a reference chip in the same block", async () => {
    // The chip's XML is longer than the re-anchor search window, so rendered
    // and canonical offsets for anything after it diverge by more than a
    // bounded search can bridge — the projection has to map the excluded token
    // exactly rather than hunt for the quote near the rendered offset.
    expect(NOTEPAD_XML.length).toBeGreaterThan(64);
    stubComments();
    api.reply("POST", "/api/notepads/np-a/comments", (request) => ({
      status: 201,
      json: {
        comment: {
          id: "nc-2",
          notepadId: "np-a",
          anchor: (request.jsonBody as { anchor: unknown }).anchor,
          body: "Ship it Friday.",
          status: "open",
          authorKind: "user",
          authorConversationId: null,
          createdAt: "2026-08-28T10:00:00.000Z",
          updatedAt: "2026-08-28T10:00:00.000Z",
          resolvedAt: null,
        },
      },
    }));
    const { container } = renderSurface();
    await screen.findByTestId("notepad-preview-chip");

    await commentOn(container, "shipping", "Ship it Friday.");

    const canonicalLine = CONTENT.split("\n")[4] ?? "";
    await waitFor(() =>
      expect(
        api.requestsTo("POST", "/api/notepads/np-a/comments")[0]?.jsonBody,
      ).toMatchObject({
        anchor: {
          line: 5,
          quote: "shipping",
          charStart: canonicalLine.indexOf("shipping"),
          charEnd: canonicalLine.indexOf("shipping") + "shipping".length,
        },
      }),
    );
  });

  it("anchors a selection that follows reference XML the renderer kept literal", async () => {
    // Inside inline code the tag is not a chip: the reader can select it, so
    // every character after it sits at very nearly its canonical offset. A
    // projection that excluded it anyway would search a tag-length past the
    // passage and refuse a perfectly ordinary selection.
    stubComments();
    api.reply("POST", "/api/notepads/np-a/comments", (request) => ({
      status: 201,
      json: {
        comment: {
          id: "nc-4",
          notepadId: "np-a",
          anchor: (request.jsonBody as { anchor: unknown }).anchor,
          body: "Name the notepad here.",
          status: "open",
          authorKind: "user",
          authorConversationId: null,
          createdAt: "2026-08-28T10:00:00.000Z",
          updatedAt: "2026-08-28T10:00:00.000Z",
          resolvedAt: null,
        },
      },
    }));
    const { container } = renderSurface(CODE_CONTENT);
    await screen.findByText(/Paste/);
    expect(screen.queryByTestId("notepad-preview-chip")).toBeNull();

    await commentOn(container, "embed", "Name the notepad here.");

    await waitFor(() =>
      expect(
        api.requestsTo("POST", "/api/notepads/np-a/comments")[0]?.jsonBody,
      ).toMatchObject({
        anchor: {
          line: 3,
          quote: "embed",
          charStart: CODE_LINE.indexOf("embed"),
          charEnd: CODE_LINE.indexOf("embed") + "embed".length,
        },
      }),
    );
  });

  it("anchors a selection spanning a paragraph's soft line break", async () => {
    // The break renders as a `<br>`, and the annotatable text keeps the newline
    // beside it, so the passage the reader dragged across is a single canonical
    // run — quote included.
    stubComments();
    stubCreatedComment("nc-6", "Which morning?");
    const { container } = renderSurface(MULTILINE_CONTENT);
    await screen.findByText(/backfill/);

    await commentOn(container, "tonight\nand the queue", "Which morning?");

    await waitFor(() =>
      expect(
        api.requestsTo("POST", "/api/notepads/np-a/comments")[0]?.jsonBody,
      ).toMatchObject({
        anchor: {
          line: 3,
          quote: "tonight\nand the queue",
          charStart: PARAGRAPH_BLOCK.indexOf("tonight"),
        },
      }),
    );
  });

  it("anchors a selection below a blank line inside a fenced code block", async () => {
    // A blank line ends an ordinary block but not a fence, and the whole fence
    // carries one stamp — its opening line. Reading the block as "lines until
    // the first blank one" would search truncated code and refuse this.
    stubComments();
    stubCreatedComment("nc-7", "Rename this.");
    const { container } = renderSurface(MULTILINE_CONTENT);
    await screen.findByText(/const alpha/);

    await commentOn(container, "beta", "Rename this.");

    await waitFor(() =>
      expect(
        api.requestsTo("POST", "/api/notepads/np-a/comments")[0]?.jsonBody,
      ).toMatchObject({
        anchor: {
          line: 6,
          quote: "beta",
          charStart: FENCE_BLOCK.indexOf("beta"),
          charEnd: FENCE_BLOCK.indexOf("beta") + "beta".length,
        },
      }),
    );
  });

  it("refuses a selection that runs across a reference chip", async () => {
    stubComments();
    const { container } = renderSurface();
    await screen.findByTestId("notepad-preview-chip");

    // The chip's label is excluded from annotatable text, so this selection
    // yields a run that exists nowhere in the canonical block.
    await commentOn(container, "See  before", "Whose checklist?");

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /Couldn't locate that selection/,
    );
    expect(api.requestsTo("POST", "/api/notepads/np-a/comments")).toHaveLength(
      0,
    );
  });
});

describe("NotepadReviewSurface — the comment threads", () => {
  it("lists each comment with its passage and replies, attributing an agent reply to its conversation", async () => {
    stubComments([
      commentThread("nc-1", {
        body: "Confirm the date.",
        replies: [
          {
            id: "nr-1",
            commentId: "nc-1",
            body: "Confirmed with release eng.",
            authorKind: "agent",
            authorConversationId: "conv-77aabbcc",
            createdAt: "2026-08-28T10:05:00.000Z",
          },
        ],
      }),
    ]);
    renderSurface();

    const thread = await screen.findByTestId("notepad-comment-nc-1");
    expect(within(thread).getByText(/Release plan · line 3/)).toBeVisible();
    expect(within(thread).getByText(/migration/)).toBeVisible();
    expect(within(thread).getByText("Confirm the date.")).toBeVisible();

    const reply = within(thread).getByText("Confirmed with release eng.");
    expect(reply).toBeVisible();
    // An agent reply names the conversation that wrote it — attribution a
    // reader needs to know which agent answered.
    expect(thread).toHaveTextContent("conv-77a");
  });

  it("paints an existing comment that sits after a reference chip", async () => {
    // The inverse of the selection case: the stored anchor counts canonical
    // characters, the chip's tag included, so the seam only finds the passage
    // if those offsets are restated in the coordinates it measures.
    const canonicalLine = CONTENT.split("\n")[4] ?? "";
    stubComments([
      commentThread("nc-3", {
        quote: "shipping",
        line: 5,
        charStart: canonicalLine.indexOf("shipping"),
      }),
    ]);
    renderSurface();

    // The gutter marker exists only for an annotation that resolved to a real
    // block in the rendered document.
    expect(
      await screen.findByRole("button", { name: "1 comment on this passage" }),
    ).toBeVisible();
    expect(
      within(screen.getByTestId("notepad-comment-nc-3")).queryByText("stale"),
    ).not.toBeInTheDocument();
  });

  it("reveals a passage's thread when its gutter marker is activated", async () => {
    // The gutter marker is the only affordance tying a highlight back to what
    // was said about it; the thread list can hold far more than fits, so
    // activating a marker has to bring that thread to the reader.
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    stubComments([
      commentThread("nc-1", { body: "Confirm the date." }),
      commentThread("nc-2", {
        quote: "shipping",
        line: 5,
        charStart: (CONTENT.split("\n")[4] ?? "").indexOf("shipping"),
        body: "Name the ship gate.",
      }),
    ]);
    renderSurface();

    const markers = await screen.findAllByRole("button", {
      name: "1 comment on this passage",
    });
    await userEvent.click(markers[1]!);

    await waitFor(() => {
      expect(screen.getByTestId("notepad-comment-nc-2")).toHaveAttribute(
        "data-active",
        "true",
      );
    });
    expect(screen.getByTestId("notepad-comment-nc-1")).not.toHaveAttribute(
      "data-active",
      "true",
    );
    expect(scrollIntoView).toHaveBeenCalled();
  });

  it("paints an existing comment that follows reference XML kept literal", async () => {
    // Nothing is excluded from a code span, so the stored canonical offsets are
    // already the ones the view paints in; shifting them by the tag's length
    // would leave this comment with no highlight and no gutter marker.
    stubComments([
      commentThread("nc-5", {
        quote: "embed",
        line: 3,
        charStart: CODE_LINE.indexOf("embed"),
      }),
    ]);
    renderSurface(CODE_CONTENT);

    expect(
      await screen.findByRole("button", { name: "1 comment on this passage" }),
    ).toBeVisible();
    expect(
      within(screen.getByTestId("notepad-comment-nc-5")).queryByText("stale"),
    ).not.toBeInTheDocument();
  });

  it("paints a comment whose passage is unchanged under a renamed heading", async () => {
    // Exactness governs the commented passage, not the enclosing block's
    // derived section identity. Renaming the heading restamps every block
    // beneath it, so an anchor carrying the pre-rename section id addresses a
    // block the rendering no longer has — while the quoted text never moved.
    // This is the sole annotation, so nothing else can prove the document
    // rendered: it must paint, and it must not be quietly dropped instead.
    stubComments([commentThread("nc-1")]);
    renderSurface(RENAMED_HEADING_CONTENT);

    expect(
      await screen.findByRole("button", { name: "1 comment on this passage" }),
    ).toBeVisible();
    const thread = screen.getByTestId("notepad-comment-nc-1");
    expect(within(thread).queryByText("stale")).not.toBeInTheDocument();
  });

  it("marks the only comment stale when its quote is gone, whatever the listing claimed", async () => {
    // A listing fetched before the edit still reports the passage anchored.
    // The panel resolves against the content it is rendering, so the thread
    // must show stale rather than sit anchored with nothing painted — and that
    // verdict cannot wait on some other annotation resolving, because there is
    // no other annotation.
    stubComments([commentThread("nc-1", { anchorState: "anchored" })]);
    renderSurface(EDITED_PASSAGE_CONTENT);

    const thread = await screen.findByTestId("notepad-comment-nc-1");
    await waitFor(() =>
      expect(within(thread).getByText("stale")).toBeVisible(),
    );
    expect(
      screen.queryByRole("button", { name: "1 comment on this passage" }),
    ).not.toBeInTheDocument();
  });

  it("marks a comment whose passage no longer resolves as stale", async () => {
    stubComments([
      commentThread("nc-1", { anchorState: "anchored" }),
      commentThread("nc-2", { anchorState: "stale", quote: "shipping" }),
    ]);
    renderSurface();

    const stale = await screen.findByTestId("notepad-comment-nc-2");
    expect(within(stale).getByText("stale")).toBeVisible();

    const anchored = screen.getByTestId("notepad-comment-nc-1");
    expect(within(anchored).queryByText("stale")).not.toBeInTheDocument();
  });

  it("resolves an open comment and reopens a resolved one", async () => {
    const user = userEvent.setup();
    stubComments([
      commentThread("nc-1"),
      commentThread("nc-2", { status: "resolved" }),
    ]);
    api.reply(
      "PATCH",
      "/api/notepads/np-a/comments/nc-1",
      stubCommentReply(commentThread("nc-1", { status: "resolved" }).comment),
    );
    api.reply(
      "PATCH",
      "/api/notepads/np-a/comments/nc-2",
      stubCommentReply(commentThread("nc-2").comment),
    );
    renderSurface();

    const open = await screen.findByTestId("notepad-comment-nc-1");
    await user.click(within(open).getByRole("button", { name: "Resolve" }));
    await waitFor(() =>
      expect(
        api.requestsTo("PATCH", "/api/notepads/np-a/comments/nc-1")[0]
          ?.jsonBody,
      ).toEqual({ status: "resolved" }),
    );

    const resolved = screen.getByTestId("notepad-comment-nc-2");
    await user.click(within(resolved).getByRole("button", { name: "Reopen" }));
    await waitFor(() =>
      expect(
        api.requestsTo("PATCH", "/api/notepads/np-a/comments/nc-2")[0]
          ?.jsonBody,
      ).toEqual({ status: "open" }),
    );
  });

  it("deletes a comment only after the confirm", async () => {
    const user = userEvent.setup();
    stubComments([commentThread("nc-1")]);
    api.json("DELETE", "/api/notepads/np-a/comments/nc-1", { ok: true });
    renderSurface();

    const thread = await screen.findByTestId("notepad-comment-nc-1");
    await user.click(within(thread).getByRole("button", { name: "Delete…" }));
    expect(
      api.requestsTo("DELETE", "/api/notepads/np-a/comments/nc-1"),
    ).toHaveLength(0);

    await user.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() =>
      expect(
        api.requestsTo("DELETE", "/api/notepads/np-a/comments/nc-1"),
      ).toHaveLength(1),
    );
  });
});

describe("NotepadReviewSurface — dispatching open comments", () => {
  const PROMPT_URL =
    "/api/projects/p1/sessions/s1/conversations/conv-idle/prompt";
  const QUEUE_URL =
    "/api/projects/p1/sessions/s1/conversations/conv-busy/queue";

  it("offers nothing to send when no comment is open", async () => {
    stubComments([commentThread("nc-1", { status: "resolved" })]);
    stubConversations([conversationListItem("conv-idle", "awaiting")]);
    renderSurface();

    const bar = await screen.findByTestId("notepad-dispatch-bar");
    expect(
      within(bar).getByRole("button", { name: /Send 0 open comments/ }),
    ).toBeDisabled();
  });

  it("sends the open comments to the chosen conversation without the user writing anything", async () => {
    const user = userEvent.setup();
    stubComments([
      commentThread("nc-1", { body: "Confirm the date." }),
      commentThread("nc-2", { status: "resolved", body: "Already handled." }),
    ]);
    stubConversations([conversationListItem("conv-idle", "awaiting")]);
    api.json("POST", PROMPT_URL, { ok: true });
    renderSurface();

    const bar = await screen.findByTestId("notepad-dispatch-bar");
    // The bar mounts before the comment and conversation feeds resolve; the
    // enabled button is the signal that both have.
    await waitFor(() =>
      expect(
        within(bar).getByRole("button", { name: /Send 1 open comment$/ }),
      ).toBeEnabled(),
    );
    await user.click(
      within(bar).getByRole("button", { name: /Send 1 open comment$/ }),
    );

    await waitFor(() =>
      expect(api.requestsTo("POST", PROMPT_URL)).toHaveLength(1),
    );
    const body = api.requestsTo("POST", PROMPT_URL)[0]?.jsonBody as {
      prompt: string;
      notepadFeedback: {
        notepadId: string;
        items: Array<{ commentId: string; body: string }>;
      };
    };
    // Composed from the comments themselves — the resolved one is not re-raised.
    expect(body.notepadFeedback.notepadId).toBe("np-a");
    expect(body.notepadFeedback.items.map((i) => i.commentId)).toEqual([
      "nc-1",
    ]);
    expect(body.prompt).toContain("Confirm the date.");
    expect(body.prompt).toContain("migration");
    expect(body.prompt).not.toContain("Already handled.");
  });

  it("queues the dispatch when the chosen conversation is running", async () => {
    const user = userEvent.setup();
    stubComments([commentThread("nc-1")]);
    stubConversations([conversationListItem("conv-busy", "running")]);
    api.json("POST", QUEUE_URL, {
      queued: true,
      message: null,
      deliveryTiming: "next_turn",
    });
    renderSurface();

    const bar = await screen.findByTestId("notepad-dispatch-bar");
    // The bar mounts before the comment and conversation feeds resolve; the
    // enabled button is the signal that both have.
    await waitFor(() =>
      expect(
        within(bar).getByRole("button", { name: /Send 1 open comment$/ }),
      ).toBeEnabled(),
    );
    await user.click(
      within(bar).getByRole("button", { name: /Send 1 open comment$/ }),
    );

    await waitFor(() =>
      expect(api.requestsTo("POST", QUEUE_URL)).toHaveLength(1),
    );
    expect(api.requestsTo("POST", PROMPT_URL)).toHaveLength(0);
  });

  it("surfaces a delivery failure instead of reporting the comments as sent", async () => {
    const user = userEvent.setup();
    stubComments([commentThread("nc-1")]);
    stubConversations([conversationListItem("conv-idle", "awaiting")]);
    api.reply("POST", PROMPT_URL, () => ({
      status: 400,
      json: { error: "conversation is archived" },
    }));
    renderSurface();

    const bar = await screen.findByTestId("notepad-dispatch-bar");
    // The bar mounts before the comment and conversation feeds resolve; the
    // enabled button is the signal that both have.
    await waitFor(() =>
      expect(
        within(bar).getByRole("button", { name: /Send 1 open comment$/ }),
      ).toBeEnabled(),
    );
    await user.click(
      within(bar).getByRole("button", { name: /Send 1 open comment$/ }),
    );

    expect(
      await within(bar).findByText("conversation is archived"),
    ).toBeInTheDocument();
  });
});

describe("NotepadReviewSurface — clipping a selection", () => {
  const CLIP_TARGET = {
    id: "np-target",
    scope: "project" as const,
    projectPath: "/p1",
    projectName: "p1",
    name: "capture target",
    revision: 2,
    writeMode: "full-edit" as const,
    pinned: false,
    archived: false,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-30T00:00:00.000Z",
  };

  /** The reference a clip from THIS surface must carry: the notepad under review. */
  const SOURCE_XML = buildNotepadRefXml({
    notepadId: "np-a",
    name: "release plan",
    scope: "global",
    projectName: null,
  });

  beforeEach(() => {
    useSessionDetailStore.getState().resetStore();
    useToastStoreForTesting.setState({ toasts: [] });
    api.json("GET", /^\/api\/notepads\?project=p1/, {
      notepads: [CLIP_TARGET],
    });
  });

  it("offers clip beside comment on the one selection affordance", async () => {
    stubComments();
    const { container } = renderSurface();
    await screen.findByTestId("notepad-preview-chip");

    stubSelectionOverText(container, "migration");
    fireEvent.pointerUp(document);

    const comment = await screen.findByRole("button", { name: "Comment" });
    const clip = await screen.findByRole("button", { name: "Clip" });
    expect(clip.parentElement).toBe(comment.parentElement);
  });

  it("lands the quoted selection attributed to this notepad's reference", async () => {
    const user = userEvent.setup();
    stubComments();
    const appended: unknown[] = [];
    api.reply("POST", "/api/notepads/np-target/content", (request) => {
      appended.push(request.jsonBody);
      return {
        json: {
          notepad: {
            id: "np-target",
            scope: "project",
            projectPath: "/p1",
            name: "capture target",
            content: "existing",
            revision: 3,
            writeMode: "full-edit",
            pinned: false,
            archived: false,
            createdAt: "2026-08-01T00:00:00.000Z",
            updatedAt: "2026-08-31T00:00:00.000Z",
          },
        },
      };
    });
    const { container } = renderSurface();
    await screen.findByTestId("notepad-preview-chip");

    stubSelectionOverText(container, "migration");
    fireEvent.pointerUp(document);
    await user.click(await screen.findByRole("button", { name: "Clip" }));

    await waitFor(() => expect(appended).toHaveLength(1));
    expect(appended[0]).toEqual({
      operation: "append",
      content: `> migration\n— ${SOURCE_XML}`,
    });
  });
});
