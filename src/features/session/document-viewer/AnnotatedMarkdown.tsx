"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentType,
  type RefAttributes,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { AnnotatedClipAction } from "@/components/notepad-capture/AnnotatedClipAction";
import { SourceMappedDocumentMarkdown } from "@/components/markdown/Markdown";
import MarkdownViewport from "@/components/markdown/MarkdownViewport";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/Popover";
import { Button } from "@/components/ui/Button";
import type { DocumentRef } from "@/lib/document-comments/schemas";
import type {
  ClipCaptureCapability,
  ClipSelectionContext,
  CommentComposerCapability,
  MarkdownAnnotationTarget,
  MarkdownAnnotationTone,
  ResolvedMarkdownAnnotation,
} from "@/components/document-viewer/annotation-contract";
import type { ClipFragmentInput } from "@/lib/notepads/capture-fragment";
import { groupResolvedAnnotations } from "./anchor-dom";
import CommentGutterPin from "./CommentGutterPin";
import CommentPopover from "./CommentPopover";
import RecogitoAnnotatorBoundary from "./recogito/RecogitoAnnotatorBoundary";
import {
  useTextSelectionComment,
  type SelectionDraft,
} from "./use-text-selection-comment";

/**
 * Renders the host's content as annotatable DOM. Whatever it renders MUST carry
 * the canonical source-position stamps (`data-cc-line`/`data-cc-section`) the
 * anchor resolution locates blocks by, and mark non-selectable content with
 * `NOT_ANNOTATABLE_CLASS`; the forwarded ref must reach that DOM's root.
 */
export type AnnotatedDocumentRenderer = ComponentType<
  { content: string } & RefAttributes<HTMLDivElement>
>;

export interface AnnotatedMarkdownProps {
  docRef: DocumentRef;
  content: string | null;
  isLoading: boolean;
  annotations: readonly ResolvedMarkdownAnnotation[];
  annotationNoun?: { singular: string; plural: string };
  onActivateAnnotation?: (target: MarkdownAnnotationTarget) => void;
  composer?: CommentComposerCapability;
  /**
   * The host's opt-in to clipping a selection into a notepad. Supplying it adds
   * Clip to the one selection affordance beside Comment; omitting it leaves the
   * affordance exactly as it was.
   */
  clip?: ClipCaptureCapability;
  /**
   * The document rendering itself. Defaults to the canonical source-mapped
   * document adapter — a host whose content is a DIALECT of Markdown (the
   * notepad body, whose reference XML and image tokens render as chips) supplies
   * its own renderer so the annotated DOM is the one the reader actually reads.
   */
  renderDocument?: AnnotatedDocumentRenderer;
}

interface GutterPin {
  key: string;
  top: number;
  tone: MarkdownAnnotationTone;
  count: number;
  ids: readonly string[];
  title: string;
}

interface SelectionTriggerPosition {
  draft: SelectionDraft;
  top: number;
  left: number;
}

const SELECTION_TRIGGER_EDGE_GAP = 8;
const SELECTION_TRIGGER_SELECTION_GAP = 6;
const SELECTION_TRIGGER_FALLBACK_WIDTH = 112;
const SELECTION_TRIGGER_FALLBACK_HEIGHT = 44;

function selectionTriggerPosition(
  draft: SelectionDraft,
  trigger: HTMLElement | null,
): SelectionTriggerPosition {
  const triggerRect = trigger?.getBoundingClientRect();
  const triggerWidth =
    triggerRect && triggerRect.width > 0
      ? triggerRect.width
      : SELECTION_TRIGGER_FALLBACK_WIDTH;
  const triggerHeight =
    triggerRect && triggerRect.height > 0
      ? triggerRect.height
      : SELECTION_TRIGGER_FALLBACK_HEIGHT;
  const visualViewport = window.visualViewport;
  const viewportLeft = visualViewport?.offsetLeft ?? 0;
  const viewportTop = visualViewport?.offsetTop ?? 0;
  const viewportWidth = visualViewport?.width ?? window.innerWidth;
  const viewportHeight = visualViewport?.height ?? window.innerHeight;
  const minimumLeft = viewportLeft + SELECTION_TRIGGER_EDGE_GAP;
  const minimumTop = viewportTop + SELECTION_TRIGGER_EDGE_GAP;
  const maximumLeft = Math.max(
    minimumLeft,
    viewportLeft + viewportWidth - triggerWidth - SELECTION_TRIGGER_EDGE_GAP,
  );
  const maximumTop = Math.max(
    minimumTop,
    viewportTop + viewportHeight - triggerHeight - SELECTION_TRIGGER_EDGE_GAP,
  );

  return {
    draft,
    left: Math.min(Math.max(draft.rect.left, minimumLeft), maximumLeft),
    top: Math.min(
      Math.max(draft.rect.bottom + SELECTION_TRIGGER_SELECTION_GAP, minimumTop),
      maximumTop,
    ),
  };
}

/**
 * Measures the vertical position of each anchored comment's block within the
 * scroll container and renders a left-gutter marker there. Lives inside the
 * scroll container (passed as `MarkdownViewport`'s overlay) so markers track
 * their passage on scroll. Re-measures on comment/content change and on resize.
 */
function CommentGutter({
  annotations,
  annotationNoun,
  content,
  contentRef,
  renderTick,
  onActivateAnnotation,
}: {
  annotations: readonly ResolvedMarkdownAnnotation[];
  annotationNoun: { singular: string; plural: string };
  content: string | null;
  contentRef: RefObject<HTMLDivElement | null>;
  /** Bumps when the deferred document root mounts, so measurement re-runs against
   *  the stamped DOM rather than the not-yet-rendered fallback. */
  renderTick: number;
  onActivateAnnotation?: (target: MarkdownAnnotationTarget) => void;
}): React.JSX.Element | null {
  const [pins, setPins] = useState<GutterPin[]>([]);

  useLayoutEffect(() => {
    const measure = (): void => {
      const contentEl = contentRef.current;
      const scrollEl = contentEl?.closest<HTMLElement>(
        "[data-markdown-viewport]",
      );
      if (!contentEl || !scrollEl) {
        setPins([]);
        return;
      }
      const scrollRect = scrollEl.getBoundingClientRect();
      const next: GutterPin[] = [];
      for (const group of groupResolvedAnnotations(annotations)) {
        const block = group.block;
        const top =
          block.getBoundingClientRect().top -
          scrollRect.top +
          scrollEl.scrollTop;
        next.push({
          key: group.key,
          top,
          tone: group.tone,
          count: group.count,
          ids: group.ids,
          title:
            group.count > 1
              ? `${group.count} ${annotationNoun.plural} on this passage`
              : `1 ${annotationNoun.singular} on this passage`,
        });
      }
      setPins(next);
    };

    measure();
    const contentEl = contentRef.current;
    if (!contentEl) return;
    const observer = new ResizeObserver(measure);
    observer.observe(contentEl);
    return () => observer.disconnect();
  }, [annotations, annotationNoun, content, contentRef, renderTick]);

  if (pins.length === 0) return null;

  return (
    <div className="pointer-events-none absolute top-0 left-0 z-[1] h-full w-[50px]">
      {pins.map((pin) => (
        <CommentGutterPin
          key={pin.key}
          top={pin.top}
          tone={pin.tone}
          count={pin.count}
          title={pin.title}
          onClick={() =>
            onActivateAnnotation?.({ kind: "block-group", ids: pin.ids })
          }
        />
      ))}
    </div>
  );
}

/**
 * The one affordance a selection raises on an annotated host: Comment, Clip, or
 * both, in a single positioned trigger. Anchors Radix Popover to the current
 * selection for the comment composer and keeps dismissal coordinated with
 * asynchronous persistence so a pending write cannot discard its draft.
 *
 * A host that supplies neither capability never mounts this layer, so a
 * read-only surface still raises nothing at all.
 */
function SelectionAffordanceLayer({
  draft,
  clear,
  composer,
  clip,
  projectName,
}: {
  draft: SelectionDraft | null;
  clear: () => void;
  composer?: CommentComposerCapability;
  clip?: ClipCaptureCapability;
  /** Where a clip's destination resolves — the annotated document's project. */
  projectName: string;
}): React.JSX.Element | null {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLSpanElement>(null);
  const restoreSourceFocusRef = useRef(false);
  const [triggerPosition, setTriggerPosition] =
    useState<SelectionTriggerPosition | null>(null);

  const placeTrigger = useCallback((): void => {
    if (!draft) return;
    const next = selectionTriggerPosition(draft, triggerRef.current);
    setTriggerPosition((current) =>
      current?.draft === next.draft &&
      current.top === next.top &&
      current.left === next.left
        ? current
        : next,
    );
  }, [draft]);

  useLayoutEffect(() => {
    if (!draft) return;
    const visualViewport = window.visualViewport;
    placeTrigger();
    window.addEventListener("resize", placeTrigger);
    visualViewport?.addEventListener("resize", placeTrigger);
    visualViewport?.addEventListener("scroll", placeTrigger);
    return () => {
      window.removeEventListener("resize", placeTrigger);
      visualViewport?.removeEventListener("resize", placeTrigger);
      visualViewport?.removeEventListener("scroll", placeTrigger);
    };
  }, [draft, placeTrigger]);

  useEffect(() => {
    if (!draft) return;
    const onScroll = (event: Event): void => {
      const eventTarget = event.target;
      const isEditorScroll =
        eventTarget instanceof Node &&
        contentRef.current?.contains(eventTarget) === true;
      if (pending || isEditorScroll) return;
      if (!open) {
        clear();
        return;
      }
      restoreSourceFocusRef.current = false;
      setOpen(false);
    };
    window.addEventListener("scroll", onScroll, true);
    return () => window.removeEventListener("scroll", onScroll, true);
  }, [clear, draft, open, pending]);

  if (!draft) return null;

  function closeAndRestoreSource(): void {
    if (pending) return;
    restoreSourceFocusRef.current = true;
    setOpen(false);
  }

  function closeAfterSuccess(): void {
    restoreSourceFocusRef.current = true;
    setOpen(false);
  }

  const placedTrigger =
    triggerPosition?.draft === draft ? triggerPosition : null;

  // Described the moment the affordance appears rather than on click: the
  // capability answers from the live block, which is on screen exactly while
  // the affordance is. The host returns provenance DATA; the fragment shape is
  // rendered downstream by the capture builder alone (D20).
  const clipSelection: ClipSelectionContext = {
    anchor: draft.anchor,
    text: draft.anchor.quote,
    block: draft.block,
    range: draft.range,
  };
  const clipInput: ClipFragmentInput | null = clip?.enabled
    ? {
        text: clipSelection.text,
        isCode: clip.deriveIsCode(clipSelection),
        provenance: clip.buildProvenance(clipSelection),
      }
    : null;

  return (
    <Popover
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && pending) return;
        setOpen(nextOpen);
      }}
    >
      {/* Portal to <body>: the trigger is `position: fixed` against the viewport
          (snapped under the selection's viewport rect), but hosts mount this seam
          inside `.conversation-docked-stage`, whose transform would otherwise
          become its containing block and offset the affordance away from the text
          it belongs to — the same reason the comment card portals. */}
      {createPortal(
        <span
          ref={triggerRef}
          className="fixed z-popover inline-flex items-center gap-xs"
          style={
            placedTrigger
              ? { top: placedTrigger.top, left: placedTrigger.left }
              : { visibility: "hidden" }
          }
        >
          {composer ? (
            <PopoverTrigger asChild>
              <Button type="button" variant="default" size="touch">
                <span
                  aria-hidden="true"
                  className="text-[0.85rem] leading-none"
                >
                  +
                </span>
                Comment
              </Button>
            </PopoverTrigger>
          ) : null}
          {clipInput ? (
            <AnnotatedClipAction
              projectName={projectName}
              clip={clipInput}
              onClipped={clear}
            />
          ) : null}
        </span>,
        document.body,
      )}
      {composer ? (
        <PopoverContent
          ref={contentRef}
          aria-label="Add comment"
          unstyled
          contentClassName="z-popover outline-none"
          onEscapeKeyDown={(event) => {
            if (pending) event.preventDefault();
            else restoreSourceFocusRef.current = true;
          }}
          onInteractOutside={(event) => {
            if (pending) event.preventDefault();
            else restoreSourceFocusRef.current = false;
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            if (restoreSourceFocusRef.current) {
              const sourceBlock = draft.block;
              if (!sourceBlock.hasAttribute("tabindex")) {
                sourceBlock.setAttribute("tabindex", "-1");
              }
              sourceBlock.focus();
            }
            clear();
          }}
        >
          <CommentPopover
            anchor={draft.anchor}
            composer={composer}
            onCancel={closeAndRestoreSource}
            onSuccess={closeAfterSuccess}
            onPendingChange={setPending}
          />
        </PopoverContent>
      ) : null}
    </Popover>
  );
}

/**
 * Reserves the left gutter that holds the comment pins. Ordinary documents
 * reserve no annotation space, so the annotation host adds this inset on top of
 * the canonical document adapter's own left padding — sized so the document text
 * always begins at the 50px gutter overlay's right edge and never under the pins.
 *
 * The canonical adapter pads px-xl (24px) at desktop and px-md (12px) below 640px,
 * so the inset compensates at the SAME breakpoint (26px+24px = 50px, 38px+12px =
 * 50px). Without the responsive step the text would begin at 38px on narrow
 * viewports — inside the 50px gutter — and overlap the pins.
 */
const GUTTER_INSET = "pl-[26px] max-640:pl-[38px]";
const DEFAULT_ANNOTATION_NOUN = {
  singular: "comment",
  plural: "comments",
};

/**
 * The browser-only recogito annotator boundary, swappable for tests. The
 * annotator paints via the CSS Custom Highlight API and cannot mount under jsdom,
 * so component tests inject a passthrough that renders the annotatable subtree
 * directly — exercising the viewport composition, gutter, deferred sync, and
 * selection without the highlight engine. Production always uses the real
 * boundary.
 */
type AnnotatorBoundary = typeof RecogitoAnnotatorBoundary;

let annotatorBoundary: AnnotatorBoundary = RecogitoAnnotatorBoundary;

export function _setAnnotatorBoundaryForTesting(
  boundary: AnnotatorBoundary,
): void {
  annotatorBoundary = boundary;
}

export function _resetAnnotatorBoundaryForTesting(): void {
  annotatorBoundary = RecogitoAnnotatorBoundary;
}

/**
 * Comment-enabled markdown renderer shared by the Docs and Specs surfaces: the
 * canonical `MarkdownViewport` + `SourceMappedDocumentMarkdown` (document
 * typography + source-position metadata) with the recogito annotation overlay
 * painting status-styled highlights and a left-gutter marker per anchored
 * comment. Keyed by `docRef.docPath` so the annotator fully re-syncs when the
 * open document changes.
 */
export default function AnnotatedMarkdown({
  docRef,
  content,
  isLoading,
  annotations,
  annotationNoun = DEFAULT_ANNOTATION_NOUN,
  onActivateAnnotation,
  composer,
  clip,
  renderDocument: DocumentRenderer = SourceMappedDocumentMarkdown,
}: AnnotatedMarkdownProps): React.JSX.Element {
  const contentRef = useRef<HTMLDivElement>(null);
  const [renderTick, setRenderTick] = useState(0);
  const { draft, clear } = useTextSelectionComment(contentRef, content);
  const AnnotatorBoundary = annotatorBoundary;

  // The source-mapped document renders behind a deferred boundary (its renderer
  // loads after a fallback), so its root — and the stamped blocks the gutter and
  // annotator anchor to — mount a tick after this component first renders. This
  // callback ref captures that mount and bumps `renderTick` so gutter measurement
  // and highlight sync re-run against the real DOM instead of the fallback.
  const attachContentRef = useCallback((node: HTMLDivElement | null) => {
    contentRef.current = node;
    if (node) setRenderTick((tick) => tick + 1);
  }, []);

  return (
    <div key={docRef.docPath} className="flex min-h-0 flex-1 flex-col">
      {/* MarkdownViewport is the document's scroll container. recogito tracks
          scroll by re-reading its annotatable wrapper's bounding rect, which only
          changes when that wrapper MOVES — so the scroll must live on an ANCESTOR
          of the wrapper (the viewport), not on the wrapper or an inner element, or
          only the comments visible at the initial scroll position ever highlight.
          The inner `.r6o-annotatable` and the source-mapped document root stay
          content-height and move inside this scroller. The gutter markers render
          as the viewport's overlay so they share its positioning context and
          scroll with the content. */}
      <MarkdownViewport
        isLoading={isLoading}
        overlay={
          <CommentGutter
            annotations={annotations}
            annotationNoun={annotationNoun}
            content={content}
            contentRef={contentRef}
            renderTick={renderTick}
            onActivateAnnotation={onActivateAnnotation}
          />
        }
      >
        {content === null ? null : (
          <div className={GUTTER_INSET}>
            <AnnotatorBoundary
              annotations={annotations}
              onActivateAnnotation={onActivateAnnotation}
              syncSignal={`${content}#${renderTick}`}
            >
              <DocumentRenderer ref={attachContentRef} content={content} />
            </AnnotatorBoundary>
          </div>
        )}
      </MarkdownViewport>
      {composer || clip?.enabled ? (
        <SelectionAffordanceLayer
          draft={draft}
          clear={clear}
          composer={composer}
          clip={clip}
          projectName={docRef.projectName}
        />
      ) : null}
    </div>
  );
}
