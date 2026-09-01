// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useEffect, useRef, type ReactNode } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type {
  CommentStatus,
  DocumentComment,
  DocumentRef,
} from "@/lib/document-comments/schemas";
import type {
  ClipCaptureCapability,
  ClipSelectionContext,
  CommentComposerCapability,
  MarkdownAnnotationSource,
  MarkdownAnnotationTarget,
  ResolvedMarkdownAnnotation,
} from "@/components/document-viewer/annotation-contract";
import { selectionLiesWithinCode } from "@/components/notepad-capture/clip-code-ancestry";
import { renderWithQuery } from "@/test/component-mocks";
import { useLiveMarkdownAnchorResolution } from "./use-live-markdown-anchor-resolution";
import {
  blockAnnotatableText,
  findCommentBlock,
  rangeFromBlockOffsets,
} from "./anchor-dom";
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
const SOURCES: MarkdownAnnotationSource[] = COMMENTS.map((comment) => ({
  id: comment.id,
  anchor: comment.anchor,
  tone: comment.status === "pending" ? "active" : "settled",
  accessibleLabel: `Comment ${comment.id}`,
}));

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
  annotations?: readonly ResolvedMarkdownAnnotation[];
  syncSignal?: string | null;
} = {};

function PassthroughAnnotator({
  children,
  comments,
  annotations,
  onActivateAnnotation,
  syncSignal,
}: {
  children: ReactNode;
  comments?: ResolvedComment[];
  annotations?: readonly ResolvedMarkdownAnnotation[];
  onOpenComment?: (commentId: string) => void;
  onActivateAnnotation?: (target: MarkdownAnnotationTarget) => void;
  syncSignal?: string | null;
}): React.JSX.Element {
  useEffect(() => {
    annotatorProps.comments = comments;
    annotatorProps.annotations = annotations;
    annotatorProps.syncSignal = syncSignal;
  }, [annotations, comments, syncSignal]);
  return (
    <div className="r6o-annotatable" data-fake-annotator="true">
      {children}
      {annotations?.[0] ? (
        <button
          type="button"
          onClick={() =>
            onActivateAnnotation?.({
              kind: "annotation",
              id: annotations[0]!.id,
            })
          }
        >
          Activate first highlight
        </button>
      ) : null}
    </div>
  );
}

/** jsdom's Range has no `getBoundingClientRect`; the selection hook reads it. */
function withRect(range: Range, overrides: Partial<DOMRect> = {}): Range {
  range.getBoundingClientRect = () =>
    ({
      bottom: 0,
      left: 0,
      top: 0,
      right: 0,
      width: 0,
      height: 0,
      x: 0,
      y: 0,
      toJSON: () => ({}),
      ...overrides,
    }) as DOMRect;
  return range;
}

function stubSelectionOverPassage(
  container: HTMLElement,
  quote: string,
  rect: Partial<DOMRect> = {},
): HTMLElement {
  const block = findCommentBlock(container, {
    line: 5,
    sectionId: "overview",
  })!;
  const text = block.textContent ?? "";
  const start = text.indexOf(quote);
  const range = withRect(
    rangeFromBlockOffsets(block, start, start + quote.length)!,
    rect,
  );
  vi.spyOn(window, "getSelection").mockReturnValue({
    isCollapsed: false,
    rangeCount: 1,
    getRangeAt: () => range,
    removeAllRanges: vi.fn(),
  } as unknown as Selection);
  return block;
}

function ResolvedAnnotationHarness({
  sources,
  ...props
}: Omit<React.ComponentProps<typeof AnnotatedMarkdown>, "annotations"> & {
  sources: readonly MarkdownAnnotationSource[];
}): React.JSX.Element {
  const contentRef = useRef<HTMLDivElement>(null);
  const annotations = useLiveMarkdownAnchorResolution(
    sources,
    props.content,
    contentRef,
  );
  return (
    <div ref={contentRef}>
      <AnnotatedMarkdown {...props} annotations={annotations} />
    </div>
  );
}

function renderAnnotated(
  overrides: Partial<
    Omit<React.ComponentProps<typeof AnnotatedMarkdown>, "annotations">
  > & { sources?: readonly MarkdownAnnotationSource[] } = {},
) {
  const onActivateAnnotation = vi.fn();
  const submit = vi.fn<CommentComposerCapability["submit"]>();
  submit.mockResolvedValue(undefined);
  const composer: CommentComposerCapability = {
    kind: "persist-or-send",
    submit,
  };
  const utils = renderWithQuery(
    <ResolvedAnnotationHarness
      docRef={DOC_REF}
      content={DOC}
      isLoading={false}
      sources={[]}
      onActivateAnnotation={onActivateAnnotation}
      composer={composer}
      {...overrides}
    />,
  );
  return { ...utils, onActivateAnnotation, submit };
}

/** A host capability that records every selection the seam describes to it. */
function recordingClipCapability(
  overrides: Partial<ClipCaptureCapability> = {},
): {
  capability: ClipCaptureCapability;
  seen: ClipSelectionContext[];
} {
  const seen: ClipSelectionContext[] = [];
  return {
    seen,
    capability: {
      enabled: true,
      buildProvenance: (selection) => {
        seen.push(selection);
        return { kind: "path", path: "docs/design-review.md" };
      },
      deriveIsCode: (selection) => {
        seen.push(selection);
        return false;
      },
      ...overrides,
    },
  };
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
  annotatorProps.annotations = undefined;
  annotatorProps.syncSignal = undefined;
});

afterEach(() => {
  cleanup();
  _resetAnnotatorBoundaryForTesting();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("AnnotatedMarkdown composition", () => {
  it("renders neutral annotation tones, grouping, nouns, and activation targets", async () => {
    const onActivateAnnotation = vi.fn();
    const view = render(
      <AnnotatedMarkdown
        docRef={DOC_REF}
        content={DOC}
        isLoading={false}
        annotations={[]}
        annotationNoun={{ singular: "review thread", plural: "review threads" }}
        onActivateAnnotation={onActivateAnnotation}
      />,
    );
    await findSourceRoot(view.container);
    const overviewBlock = findCommentBlock(view.container, {
      line: 5,
      sectionId: "overview",
    })!;
    const detailsBlock = findCommentBlock(view.container, {
      line: 9,
      sectionId: "details",
    })!;
    const annotation = (
      id: string,
      block: HTMLElement | null,
      tone: "active" | "settled",
      quote: string,
    ): ResolvedMarkdownAnnotation => {
      const text = block?.textContent ?? "";
      const charStart = text.indexOf(quote);
      return {
        id,
        tone,
        accessibleLabel: `Review thread ${id}`,
        anchor: {
          sectionId: block === overviewBlock ? "overview" : "details",
          headingLabel: block === overviewBlock ? "Overview" : "Details",
          line: block === overviewBlock ? 5 : 9,
          charStart,
          charEnd: charStart + quote.length,
          quote,
          prefix: "",
          suffix: "",
          docRevision: "revision-1",
        },
        anchorState:
          block === null
            ? { status: "stale" }
            : {
                status: "anchored",
                charStart,
                charEnd: charStart + quote.length,
              },
        block,
      };
    };
    const annotations = [
      annotation(
        "overview-active",
        overviewBlock,
        "active",
        "agent-produced markdown",
      ),
      annotation(
        "overview-settled",
        overviewBlock,
        "settled",
        "selection commenting",
      ),
      annotation(
        "details-settled",
        detailsBlock,
        "settled",
        "precise source reference",
      ),
      annotation("stale", null, "active", "missing quote"),
    ];

    view.rerender(
      <AnnotatedMarkdown
        docRef={DOC_REF}
        content={DOC}
        isLoading={false}
        annotations={annotations}
        annotationNoun={{ singular: "review thread", plural: "review threads" }}
        onActivateAnnotation={onActivateAnnotation}
      />,
    );

    const groupPin = await screen.findByRole("button", {
      name: "2 review threads on this passage",
    });
    const settledPin = screen.getByRole("button", {
      name: "1 review thread on this passage",
    });
    expect(groupPin.className).toContain("text-cyan");
    expect(settledPin.className).toContain("text-green");
    expect(annotatorProps.annotations).toEqual(annotations);

    fireEvent.click(groupPin);
    expect(onActivateAnnotation).toHaveBeenCalledWith({
      kind: "block-group",
      ids: ["overview-active", "overview-settled"],
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Activate first highlight" }),
    );
    expect(onActivateAnnotation).toHaveBeenCalledWith({
      kind: "annotation",
      id: "overview-active",
    });
  });

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
    const { container, onActivateAnnotation } = renderAnnotated({
      sources: SOURCES,
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
    expect(onActivateAnnotation).toHaveBeenCalledWith({
      kind: "block-group",
      ids: ["overview-1", "overview-2"],
    });
    fireEvent.click(soloPin);
    expect(onActivateAnnotation).toHaveBeenCalledWith({
      kind: "block-group",
      ids: ["details-sent"],
    });
  });

  it("re-synchronizes the gutter and annotator once the deferred document mounts", async () => {
    const { container } = renderAnnotated({ sources: SOURCES });
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
    expect(annotatorProps.annotations?.map(({ id }) => id)).toEqual([
      "overview-1",
      "overview-2",
      "details-sent",
      "details-stale",
    ]);
  });

  it("offers the comment affordance after a pointer-completed selection", async () => {
    const { container } = renderAnnotated();
    await findSourceRoot(container);
    stubSelectionOverPassage(container, "agent-produced markdown");

    act(() => {
      fireEvent.pointerUp(document);
    });

    expect(screen.getByRole("button", { name: "Comment" })).toHaveClass(
      "min-h-[44px]",
      "min-w-[44px]",
      "text-text-primary",
    );
  });

  it("anchors the selection affordance to the body, clear of a transformed ancestor", async () => {
    const { container } = renderAnnotated();
    await findSourceRoot(container);
    stubSelectionOverPassage(container, "agent-produced markdown");

    act(() => {
      fireEvent.pointerUp(document);
    });

    const trigger = screen.getByRole("button", {
      name: "Comment",
    }).parentElement!;
    expect(container.contains(trigger)).toBe(false);
    expect(trigger.parentElement).toBe(document.body);
  });

  it("keeps the unopened selection affordance inside the zoomed visual viewport", async () => {
    vi.spyOn(window, "innerWidth", "get").mockReturnValue(195);
    vi.spyOn(window, "innerHeight", "get").mockReturnValue(422);
    const { container } = renderAnnotated();
    await findSourceRoot(container);
    stubSelectionOverPassage(container, "agent-produced markdown", {
      bottom: 410,
      left: 190,
    });

    fireEvent.pointerUp(document);

    const trigger = screen.getByRole("button", {
      name: "Comment",
    }).parentElement!;
    vi.spyOn(trigger, "getBoundingClientRect").mockReturnValue({
      bottom: 44,
      height: 44,
      left: 0,
      right: 110,
      top: 0,
      width: 110,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    fireEvent(window, new Event("resize"));

    await waitFor(() => {
      expect(trigger).toHaveStyle({ left: "77px", top: "370px" });
    });
  });

  it("repositions the selection affordance when the visual viewport pans", async () => {
    const visualViewport = Object.assign(new EventTarget(), {
      height: 422,
      offsetLeft: 12,
      offsetTop: 20,
      width: 195,
    });
    vi.stubGlobal("visualViewport", visualViewport);
    const { container } = renderAnnotated();
    await findSourceRoot(container);
    stubSelectionOverPassage(container, "agent-produced markdown", {
      bottom: 410,
      left: 190,
    });
    fireEvent.pointerUp(document);

    const trigger = screen.getByRole("button", {
      name: "Comment",
    }).parentElement!;
    vi.spyOn(trigger, "getBoundingClientRect").mockReturnValue({
      bottom: 44,
      height: 44,
      left: 0,
      right: 110,
      top: 0,
      width: 110,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    visualViewport.offsetLeft = 30;
    visualViewport.offsetTop = 40;
    act(() => {
      visualViewport.dispatchEvent(new Event("scroll"));
    });

    await waitFor(() => {
      expect(trigger).toHaveStyle({ left: "107px", top: "410px" });
    });
  });

  it("dismisses an unopened selection affordance when its source scrolls", async () => {
    const { container } = renderAnnotated();
    await findSourceRoot(container);
    stubSelectionOverPassage(container, "agent-produced markdown");
    fireEvent.pointerUp(document);
    expect(screen.getByRole("button", { name: "Comment" })).toBeInTheDocument();

    fireEvent.scroll(window);

    await waitFor(() => {
      expect(
        screen.queryByRole("button", { name: "Comment" }),
      ).not.toBeInTheDocument();
    });
  });

  it("keeps selection commenting unavailable when no create handler is provided", async () => {
    const { container } = renderAnnotated({ composer: undefined });
    await findSourceRoot(container);
    stubSelectionOverPassage(container, "agent-produced markdown");

    act(() => {
      fireEvent.pointerUp(document);
    });

    expect(screen.queryByRole("button", { name: "Comment" })).toBeNull();
    expect(screen.queryByRole("textbox", { name: "Comment note" })).toBeNull();
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

  it("gives the open selection composer dialog an accessible name", async () => {
    const user = userEvent.setup();
    const { container } = renderAnnotated();
    await findSourceRoot(container);
    stubSelectionOverPassage(container, "agent-produced markdown");
    fireEvent.pointerUp(document);

    await user.click(screen.getByRole("button", { name: "Comment" }));

    expect(
      screen.getByRole("dialog", { name: "Add comment" }),
    ).toBeInTheDocument();
  });

  it("dismisses an idle selection composer through a real outside interaction", async () => {
    const user = userEvent.setup();
    const { container } = renderAnnotated();
    await findSourceRoot(container);
    stubSelectionOverPassage(container, "agent-produced markdown");
    fireEvent.pointerUp(document);
    await user.click(screen.getByRole("button", { name: "Comment" }));

    await user.click(document.body);

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: "Comment" }),
      ).not.toBeInTheDocument();
    });
  });

  it("keeps the selection composer mounted through pending outside and Escape dismissal", async () => {
    const user = userEvent.setup();
    const submit = vi.fn(
      () =>
        new Promise<void>(() => {
          // The pending promise deliberately stays unsettled for this assertion.
        }),
    );
    const { container } = renderAnnotated({
      composer: { kind: "persist-only", submit },
    });
    await findSourceRoot(container);
    stubSelectionOverPassage(container, "agent-produced markdown");
    fireEvent.pointerUp(document);
    await user.click(screen.getByRole("button", { name: "Comment" }));
    await user.type(screen.getByRole("textbox"), "retain while pending");
    await user.click(screen.getByRole("button", { name: "Add comment" }));

    fireEvent.pointerDown(document.body);
    expect(screen.getByRole("textbox")).toHaveValue("retain while pending");
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Escape" });
    expect(screen.getByRole("textbox")).toHaveValue("retain while pending");
  });

  it("retains a rejected selection draft and clears it only after success", async () => {
    const user = userEvent.setup();
    const rejected = renderAnnotated({
      composer: {
        kind: "persist-only",
        submit: vi.fn().mockRejectedValue(new Error("Proposal changed")),
      },
    });
    await findSourceRoot(rejected.container);
    stubSelectionOverPassage(rejected.container, "agent-produced markdown");
    fireEvent.pointerUp(document);
    await user.click(screen.getByRole("button", { name: "Comment" }));
    await user.type(screen.getByRole("textbox"), "keep rejected draft");
    await user.click(screen.getByRole("button", { name: "Add comment" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Proposal changed",
    );
    expect(screen.getByRole("textbox")).toHaveValue("keep rejected draft");

    rejected.unmount();
    const successful = renderAnnotated({
      composer: {
        kind: "persist-only",
        submit: vi.fn().mockResolvedValue(undefined),
      },
    });
    await findSourceRoot(successful.container);
    const sourceBlock = stubSelectionOverPassage(
      successful.container,
      "selection commenting",
    );
    fireEvent.keyUp(document, { key: "ArrowRight", shiftKey: true });
    await user.click(screen.getByRole("button", { name: "Comment" }));
    await user.type(screen.getByRole("textbox"), "successful draft");
    await user.keyboard("{Control>}{Enter}{/Control}");

    await waitFor(() =>
      expect(screen.queryByRole("textbox")).not.toBeInTheDocument(),
    );
    expect(document.activeElement).toBe(sourceBlock);
  });

  it("closes and restores the selected passage after delayed persistence succeeds", async () => {
    const user = userEvent.setup();
    let settle: (() => void) | undefined;
    const successful = renderAnnotated({
      composer: {
        kind: "persist-only",
        submit: () =>
          new Promise<void>((resolve) => {
            settle = resolve;
          }),
      },
    });
    await findSourceRoot(successful.container);
    const sourceBlock = stubSelectionOverPassage(
      successful.container,
      "selection commenting",
    );
    fireEvent.pointerUp(document);
    await user.click(screen.getByRole("button", { name: "Comment" }));
    await user.type(screen.getByRole("textbox"), "successful delayed draft");
    await user.click(screen.getByRole("button", { name: "Add comment" }));
    expect(screen.getByRole("button", { name: "Adding…" })).toBeDisabled();

    await act(async () => settle?.());

    await waitFor(() =>
      expect(screen.queryByRole("textbox")).not.toBeInTheDocument(),
    );
    expect(document.activeElement).toBe(sourceBlock);
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

/**
 * A document whose code arrives the way production renders it: a fenced block
 * (whose source stamps land on the renderer's WRAPPING container, not on the
 * <pre> inside it) and an inline code span inside a prose block.
 */
const CODE_DOC = [
  "# Guide", // 1
  "", // 2
  "## Usage", // 3
  "", // 4
  "Read it with `cctl notepad get np-1` from any conversation.", // 5
  "", // 6
  "```ts", // 7
  "const landed = await land(fragment);", // 8
  "```", // 9
  "",
].join("\n");

/** Select `quote` within the stamped block at `line`, as a reader's drag would. */
function stubSelectionInBlock(
  container: HTMLElement,
  line: number,
  sectionId: string,
  quote: string,
): HTMLElement {
  const block = findCommentBlock(container, { line, sectionId });
  if (block === null) throw new Error(`no stamped block at line ${line}`);
  const text = blockAnnotatableText(block);
  const start = text.indexOf(quote);
  if (start < 0) throw new Error(`block at line ${line} has no ${quote}`);
  const range = withRect(
    rangeFromBlockOffsets(block, start, start + quote.length)!,
  );
  vi.spyOn(window, "getSelection").mockReturnValue({
    isCollapsed: false,
    rangeCount: 1,
    getRangeAt: () => range,
    removeAllRanges: vi.fn(),
  } as unknown as Selection);
  return block;
}

describe("AnnotatedMarkdown — code ancestry as production renders it", () => {
  it("classifies a fenced-code selection as code, though the stamp sits on the wrapper", async () => {
    const { capability, seen } = recordingClipCapability();
    const { container } = renderAnnotated({
      content: CODE_DOC,
      clip: capability,
    });
    await findSourceRoot(container);
    const block = stubSelectionInBlock(container, 7, "usage", "const landed");

    act(() => {
      fireEvent.pointerUp(document);
    });

    // The production renderer stamps the WRAPPING container, so the block the
    // seam resolves is not the <pre> — the exact shape the check must survive.
    expect(block.tagName).toBe("DIV");
    expect(block.hasAttribute("data-markdown-code-block")).toBe(true);
    const selection = seen[0];
    if (selection === undefined) throw new Error("capability never consulted");
    expect(selectionLiesWithinCode(selection)).toBe(true);
  });

  it("classifies an inline-code selection inside prose as code", async () => {
    const { capability, seen } = recordingClipCapability();
    const { container } = renderAnnotated({
      content: CODE_DOC,
      clip: capability,
    });
    await findSourceRoot(container);
    // A substring strictly inside the span, which is what a real drag or
    // double-click produces: browsers resolve both endpoints to the deepest
    // text node, so the range sits within <code> rather than touching the
    // paragraph text on either side of it.
    stubSelectionInBlock(container, 5, "usage", "notepad get");

    act(() => {
      fireEvent.pointerUp(document);
    });

    const selection = seen[0];
    if (selection === undefined) throw new Error("capability never consulted");
    expect(selection.block.tagName).toBe("P");
    expect(selectionLiesWithinCode(selection)).toBe(true);
  });

  it("classifies ordinary prose as not code", async () => {
    const { capability, seen } = recordingClipCapability();
    const { container } = renderAnnotated({
      content: CODE_DOC,
      clip: capability,
    });
    await findSourceRoot(container);
    stubSelectionInBlock(container, 5, "usage", "from any conversation");

    act(() => {
      fireEvent.pointerUp(document);
    });

    const selection = seen[0];
    if (selection === undefined) throw new Error("capability never consulted");
    expect(selectionLiesWithinCode(selection)).toBe(false);
  });
});

describe("AnnotatedMarkdown — the one selection affordance offers comment and clip", () => {
  it("offers both actions from a single affordance when the host opts into clip", async () => {
    const { capability } = recordingClipCapability();
    const { container } = renderAnnotated({ clip: capability });
    await findSourceRoot(container);
    stubSelectionOverPassage(container, "agent-produced markdown");

    act(() => {
      fireEvent.pointerUp(document);
    });

    const comment = screen.getByRole("button", { name: "Comment" });
    const clip = screen.getByRole("button", { name: "Clip" });
    // One affordance, not two: both actions share the single positioned,
    // body-portaled trigger, so no second floating surface competes for the
    // same selection.
    expect(clip.parentElement).toBe(comment.parentElement);
    expect(comment.parentElement?.parentElement).toBe(document.body);
    expect(container.contains(comment)).toBe(false);
  });

  it("offers comment alone when the host supplies no clip capability", async () => {
    const { container } = renderAnnotated();
    await findSourceRoot(container);
    stubSelectionOverPassage(container, "agent-produced markdown");

    act(() => {
      fireEvent.pointerUp(document);
    });

    expect(screen.getByRole("button", { name: "Comment" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Clip" })).toBeNull();
  });

  it("withholds clip while the host's capability is disabled", async () => {
    const { capability } = recordingClipCapability({ enabled: false });
    const { container } = renderAnnotated({ clip: capability });
    await findSourceRoot(container);
    stubSelectionOverPassage(container, "agent-produced markdown");

    act(() => {
      fireEvent.pointerUp(document);
    });

    expect(screen.getByRole("button", { name: "Comment" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Clip" })).toBeNull();
  });

  it("offers clip alone on a host that cannot take comments", async () => {
    const { capability } = recordingClipCapability();
    const { container } = renderAnnotated({
      composer: undefined,
      clip: capability,
    });
    await findSourceRoot(container);
    stubSelectionOverPassage(container, "agent-produced markdown");

    act(() => {
      fireEvent.pointerUp(document);
    });

    expect(screen.getByRole("button", { name: "Clip" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Comment" })).toBeNull();
  });

  it("describes the live selection to the capability as anchor, rendered text, and block", async () => {
    const { capability, seen } = recordingClipCapability();
    const { container } = renderAnnotated({ clip: capability });
    await findSourceRoot(container);
    const block = stubSelectionOverPassage(
      container,
      "agent-produced markdown",
    );

    act(() => {
      fireEvent.pointerUp(document);
    });

    expect(seen.length).toBeGreaterThan(0);
    for (const selection of seen) {
      expect(selection.text).toBe("agent-produced markdown");
      expect(selection.anchor.quote).toBe("agent-produced markdown");
      expect(selection.anchor.line).toBe(5);
      expect(selection.block).toBe(block);
    }
  });
});
