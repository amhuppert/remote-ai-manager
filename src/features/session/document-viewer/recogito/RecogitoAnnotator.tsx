"use client";

import { Annotorious, useAnnotator } from "@annotorious/react";
import { TextAnnotator } from "@recogito/react-text-annotator";
import type {
  RecogitoTextAnnotator,
  TextAnnotation,
} from "@recogito/react-text-annotator";
import "@recogito/react-text-annotator/react-text-annotator.css";
import { useEffect, useMemo, type ReactNode } from "react";
import type {
  MarkdownAnnotationTarget,
  ResolvedMarkdownAnnotation,
} from "@/components/document-viewer/annotation-contract";
import {
  highlightStyleForAnnotations,
  markdownAnnotationsToTextAnnotations,
} from "./build-annotations";

interface RecogitoAnnotatorProps {
  /** The rendered markdown (or any DOM) the annotator selects over. */
  children: ReactNode;
  /** Resolved comments to paint as status-styled highlights. */
  annotations?: readonly ResolvedMarkdownAnnotation[];
  /** Invoked with the comment id when a highlighted passage is clicked. */
  onActivateAnnotation?: (target: MarkdownAnnotationTarget) => void;
  /** Any change re-syncs highlights against the current DOM (e.g. content). */
  syncSignal?: string | null;
}

/**
 * Keeps the annotator's painted highlights in sync with the resolved comments.
 * Renders nothing — it sits inside the `Annotorious` provider purely to reach
 * the annotator handle via `useAnnotator` and push annotations into its store
 * whenever the comments or the underlying document content change.
 */
function AnnotationSync({
  annotations,
  onActivateAnnotation,
  syncSignal,
}: {
  annotations: readonly ResolvedMarkdownAnnotation[];
  onActivateAnnotation?: (target: MarkdownAnnotationTarget) => void;
  syncSignal?: string | null;
}): null {
  const anno = useAnnotator<RecogitoTextAnnotator>();

  useEffect(() => {
    if (!anno) return;
    const next = markdownAnnotationsToTextAnnotations(
      annotations,
      anno.element,
    );
    anno.setAnnotations(next, true);
  }, [anno, annotations, syncSignal]);

  useEffect(() => {
    if (!anno || !onActivateAnnotation) return;
    const handler = (annotation: TextAnnotation): void => {
      onActivateAnnotation({ kind: "annotation", id: annotation.id });
    };
    anno.on("clickAnnotation", handler);
    return () => anno.off("clickAnnotation", handler);
  }, [anno, onActivateAnnotation]);

  return null;
}

/**
 * Mounts the recogito text annotator over its children and paints status-styled
 * comment highlights. Statically imports the recogito React stack (provider +
 * highlight engine), which reaches browser-only APIs (Selection, client rects,
 * the CSS Custom Highlight API) at load and on mount — so this module must only
 * ever be reached through a client-only, SSR-disabled boundary
 * (`RecogitoAnnotatorBoundary`), never rendered on the server.
 *
 * `TextAnnotator` reads `AnnotoriousContext`, so it must sit inside the
 * `Annotorious` provider; `AnnotationSync` is a sibling under the same provider
 * so it can reach the annotator handle. Selection→comment creation is layered
 * on in a later task.
 */
export default function RecogitoAnnotator({
  children,
  annotations = [],
  onActivateAnnotation,
  syncSignal,
}: RecogitoAnnotatorProps): React.JSX.Element {
  const style = useMemo(
    () => highlightStyleForAnnotations(annotations),
    [annotations],
  );
  return (
    <Annotorious>
      {/* TextAnnotator renders an `.r6o-annotatable` wrapper around `children`.
          recogito's renderer only paints the annotations whose ranges intersect
          the window viewport (expressed relative to this wrapper's own
          `getBoundingClientRect`), and re-resolves them on scroll by re-reading
          that rect. So scroll tracking works ONLY when the wrapper itself MOVES
          on scroll — i.e. the scroll container must be an ANCESTOR, with the
          wrapper at full content height moving inside it. If the wrapper is the
          scroller (fixed rect) or wraps an inner scroller, its rect never
          changes and only the annotations visible at the initial scroll position
          ever paint (the rest show a gutter pin but no highlight). The scroll
          lives on `AnnotatedMarkdown`'s `MarkdownViewport`; this wrapper and the
          inner source-mapped document root stay content-height (no
          `overflow`/`flex-1`).

          Display-only configuration:
          - `annotatingEnabled={false}`: selection→comment is driven by our own
            flow (`useTextSelectionComment` + the affordance), so recogito must
            NOT paint or persist the live selection as a pending annotation
            (otherwise the selection style sticks after release and re-selecting
            layers more highlight on the same passage).
          - `renderer="CSS_HIGHLIGHTS"`: paint via the CSS Custom Highlight API,
            directly on the text ranges, so highlights track the text on scroll
            instead of an absolutely-positioned span layer. */}
      <TextAnnotator
        style={style}
        className=""
        annotatingEnabled={false}
        renderer="CSS_HIGHLIGHTS"
      >
        {children}
      </TextAnnotator>
      <AnnotationSync
        annotations={annotations}
        onActivateAnnotation={onActivateAnnotation}
        syncSignal={syncSignal}
      />
    </Annotorious>
  );
}
