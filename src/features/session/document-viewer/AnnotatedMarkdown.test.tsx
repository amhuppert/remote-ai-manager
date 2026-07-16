// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useEffect, type ReactNode } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type {
  CommentStatus,
  DocumentComment,
  DocumentRef,
} from "@/lib/document-comments/schemas";
import { findCommentBlock, rangeFromBlockOffsets } from "./anchor-dom";
import AnnotatedMarkdown, {
  _resetAnnotatorBoundaryForTesting,
  _setAnnotatorBoundaryForTesting,
} from "./AnnotatedMarkdown";
import type { ResolvedComment } from "./types";

//  1: # Design Review
//  2:
//  3: ## Overview
//  4:
//  5: The viewer renders agent-produced markdown with selection commenting.
//  6:
//  7: ## Details
//  8:
//  9: Comments persist durably and carry a precise source reference.
// 10:
const DOC = [
  "# Design Review",
  "",
  "## Overview",
  "",
  "The viewer renders agent-produced markdown with selection commenting.",
  "",
  "## Details",
  "",
  "Comments persist durably and carry a precise source reference.",
  "",
].join("\n");

const DOC_REF: DocumentRef = {
  projectName: "project",
  sessionName: "session",
  docPath: "doc-a.md",
  title: "Design Review",
};

const OVERVIEW_BODY =
  "The viewer renders agent-produced markdown with selection commenting.";
const DETAILS_BODY =
  "Comments persist durably and carry a precise source reference.";

function makeResolved(args: {
  id: string;
  line: number;
  sectionId: string;
  headingLabel: string;
  blockText: string;
  quote: string;
  status: CommentStatus;
  anchored: boolean;
}): ResolvedComment {
  const charStart = args.blockText.indexOf(args.quote);
  const charEnd = charStart + args.quote.length;
  const comment: DocumentComment = {
    id: args.id,
    projectPath: "/project",
    sessionName: "session",
    docPath: "doc-a.md",
    anchor: {
      sectionId: args.sectionId,
      headingLabel: args.headingLabel,
      line: args.line,
      charStart,
      charEnd,
      quote: args.quote,
      prefix: "",
      suffix: "",
      docRevision: "rev",
    },
    note: "note",
    status: args.status,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    sentAt: args.status === "sent" ? "2026-01-02T00:00:00.000Z" : null,
  };
  return {
    ...comment,
    reanchor: args.anchored
      ? { status: "anchored", charStart, charEnd }
      : { status: "stale" },
    stale: !args.anchored,
  };
}

// Two comments on line 5 (one gutter group, count 2), one on line 9 (count 1),
// and one stale on line 9 that must NOT produce a marker.
const COMMENTS: ResolvedComment[] = [
  makeResolved({
    id: "overview-1",
    line: 5,
    sectionId: "overview",
    headingLabel: "Overview",
    blockText: OVERVIEW_BODY,
    quote: "agent-produced markdown",
    status: "pending",
    anchored: true,
  }),
  makeResolved({
    id: "overview-2",
    line: 5,
    sectionId: "overview",
    headingLabel: "Overview",
    blockText: OVERVIEW_BODY,
    quote: "selection commenting",
    status: "pending",
    anchored: true,
  }),
  makeResolved({
    id: "details-sent",
    line: 9,
    sectionId: "details",
    headingLabel: "Details",
    blockText: DETAILS_BODY,
    quote: "precise source reference",
    status: "sent",
    anchored: true,
  }),
  makeResolved({
    id: "details-stale",
    line: 9,
    sectionId: "details",
    headingLabel: "Details",
    blockText: DETAILS_BODY,
    quote: "no longer present in the rendered document",
    status: "pending",
    anchored: false,
  }),
];

/**
 * jsdom cannot mount the browser-only recogito annotator (it paints via the CSS
 * Custom Highlight API), so component tests inject this passthrough via the
 * boundary seam. It mirrors what `TextAnnotator` does structurally — wrapping the
 * annotatable subtree in `.r6o-annotatable` — and records the props the host
 * feeds it, so the composition, gutter, deferred sync, and selection can be
 * exercised without the highlight engine.
 */
const annotatorProps: {
  comments?: ResolvedComment[];
  syncSignal?: string | null;
} = {};

function PassthroughAnnotator({
  children,
  comments,
  syncSignal,
}: {
  children: ReactNode;
  comments?: ResolvedComment[];
  onOpenComment?: (commentId: string) => void;
  syncSignal?: string | null;
}): React.JSX.Element {
  useEffect(() => {
    annotatorProps.comments = comments;
    annotatorProps.syncSignal = syncSignal;
  }, [comments, syncSignal]);
  return (
    <div className="r6o-annotatable" data-fake-annotator="true">
      {children}
    </div>
  );
}

/** jsdom's Range has no `getBoundingClientRect`; the selection hook reads it. */
function withRect(range: Range): Range {
  range.getBoundingClientRect = () =>
    ({ bottom: 0, left: 0, top: 0, right: 0, width: 0, height: 0 }) as DOMRect;
  return range;
}

function stubSelectionOverPassage(container: HTMLElement, quote: string): void {
  const block = findCommentBlock(container, {
    line: 5,
    sectionId: "overview",
  })!;
  const text = block.textContent ?? "";
  const start = text.indexOf(quote);
  const range = withRect(
    rangeFromBlockOffsets(block, start, start + quote.length)!,
  );
  vi.spyOn(window, "getSelection").mockReturnValue({
    isCollapsed: false,
    rangeCount: 1,
    getRangeAt: () => range,
    removeAllRanges: vi.fn(),
  } as unknown as Selection);
}

function renderAnnotated(
  overrides: Partial<React.ComponentProps<typeof AnnotatedMarkdown>> = {},
) {
  const onOpenComment = vi.fn();
  const onCreateComment = vi.fn();
  const utils = render(
    <AnnotatedMarkdown
      docRef={DOC_REF}
      content={DOC}
      isLoading={false}
      comments={[]}
      onOpenComment={onOpenComment}
      onCreateComment={onCreateComment}
      {...overrides}
    />,
  );
  return { ...utils, onOpenComment, onCreateComment };
}

async function findSourceRoot(container: HTMLElement): Promise<HTMLElement> {
  return waitFor(() => {
    const root = container.querySelector<HTMLElement>(
      '[data-markdown-source-mapped="true"]',
    );
    expect(root).not.toBeNull();
    return root!;
  });
}

beforeEach(() => {
  _setAnnotatorBoundaryForTesting(PassthroughAnnotator);
  annotatorProps.comments = undefined;
  annotatorProps.syncSignal = undefined;
});

afterEach(() => {
  cleanup();
  _resetAnnotatorBoundaryForTesting();
  vi.restoreAllMocks();
});

describe("AnnotatedMarkdown composition", () => {
  it("nests the source-mapped document inside the annotator, inside the viewport", async () => {
    const { container } = renderAnnotated();
    const sourceRoot = await findSourceRoot(container);

    const viewport = container.querySelector<HTMLElement>(
      "[data-markdown-viewport]",
    );
    const annotatable = container.querySelector<HTMLElement>(
      '[data-fake-annotator="true"]',
    );
    expect(viewport).not.toBeNull();
    expect(annotatable).not.toBeNull();
    // viewport ⊃ inset ⊃ annotatable ⊃ source-mapped document root
    expect(viewport!.contains(annotatable!)).toBe(true);
    expect(annotatable!.contains(sourceRoot)).toBe(true);
    expect(sourceRoot.getAttribute("data-markdown-intent")).toBe("document");
    // the source root carries stamped source metadata
    expect(sourceRoot.querySelector("[data-cc-line]")).not.toBeNull();
  });

  it("renders one host-owned gutter marker per anchored block, excluding stale comments", async () => {
    const { container, onOpenComment } = renderAnnotated({
      comments: COMMENTS,
    });
    await findSourceRoot(container);

    const viewport = container.querySelector<HTMLElement>(
      "[data-markdown-viewport]",
    )!;
    const pins = await waitFor(() => {
      const found = within(viewport).getAllByRole("button", {
        name: /on this passage$/,
      });
      expect(found).toHaveLength(2);
      return found;
    });

    // The two-comment block collapses into one marker; the stale comment on
    // line 9 produces none (only the sent one there does).
    const groupPin = pins.find((p) =>
      p.getAttribute("aria-label")?.startsWith("2 comments"),
    )!;
    const soloPin = pins.find((p) =>
      p.getAttribute("aria-label")?.startsWith("1 comment"),
    )!;
    expect(groupPin).toBeDefined();
    expect(soloPin).toBeDefined();

    fireEvent.click(groupPin);
    expect(onOpenComment).toHaveBeenCalledWith("overview-1");
    fireEvent.click(soloPin);
    expect(onOpenComment).toHaveBeenCalledWith("details-sent");
  });

  it("re-synchronizes the gutter and annotator once the deferred document mounts", async () => {
    const { container } = renderAnnotated({ comments: COMMENTS });
    await findSourceRoot(container);

    // The document root mounts a tick after first render (its renderer is
    // deferred). The callback ref bumps renderTick, which both re-measures the
    // gutter (markers appear) and re-feeds the annotator's sync signal.
    await waitFor(() => {
      const viewport = container.querySelector<HTMLElement>(
        "[data-markdown-viewport]",
      )!;
      expect(
        within(viewport).getAllByRole("button", { name: /on this passage$/ }),
      ).toHaveLength(2);
    });
    expect(annotatorProps.syncSignal).toMatch(/#[1-9]\d*$/);
    expect(annotatorProps.comments).toEqual(COMMENTS);
  });

  it("offers the comment affordance after a pointer-completed selection", async () => {
    const { container } = renderAnnotated();
    await findSourceRoot(container);
    stubSelectionOverPassage(container, "agent-produced markdown");

    act(() => {
      fireEvent.pointerUp(document);
    });

    expect(screen.getByRole("button", { name: "Comment" })).toBeInTheDocument();
  });

  it("offers the comment affordance after a keyboard-completed selection", async () => {
    const { container } = renderAnnotated();
    await findSourceRoot(container);
    stubSelectionOverPassage(container, "selection commenting");

    act(() => {
      fireEvent.keyUp(document, { key: "ArrowRight", shiftKey: true });
    });

    expect(screen.getByRole("button", { name: "Comment" })).toBeInTheDocument();
  });

  it("shows the viewport loading state and renders no document or gutter", () => {
    const { container } = renderAnnotated({ content: null, isLoading: true });
    expect(screen.getByRole("status")).toHaveTextContent("Loading...");
    expect(
      container.querySelector('[data-markdown-source-mapped="true"]'),
    ).toBeNull();
    expect(container.querySelector('[data-fake-annotator="true"]')).toBeNull();
  });

  it("renders the viewport empty state and no gutter when there is no content", () => {
    const { container } = renderAnnotated({ content: null, isLoading: false });
    expect(container.querySelector("[data-markdown-viewport]")).not.toBeNull();
    expect(container.querySelector('[data-fake-annotator="true"]')).toBeNull();
    expect(
      screen.queryByRole("button", { name: /on this passage$/ }),
    ).toBeNull();
  });
});
