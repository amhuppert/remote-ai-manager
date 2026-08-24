"use client";

import dynamic from "next/dynamic";
import type { ReactNode } from "react";
import type {
  MarkdownAnnotationTarget,
  ResolvedMarkdownAnnotation,
} from "@/components/document-viewer/annotation-contract";

/**
 * SSR-safe seam for the recogito text annotator. The annotator stack
 * (`@recogito/react-text-annotator` → `@annotorious/react` → its `openseadragon`
 * peer) touches browser-only globals at module load, so it is pulled in via
 * `next/dynamic` with `ssr: false`: the server bundle never references it and the
 * client lazily loads the chunk after hydration. Mirrors the canonical Markdown
 * module's client-only dynamic-import pattern for its Mermaid dispatch.
 */
const RecogitoAnnotator = dynamic(() => import("./RecogitoAnnotator"), {
  ssr: false,
});

interface RecogitoAnnotatorBoundaryProps {
  /** The rendered markdown (or any DOM) the annotator selects over. */
  children: ReactNode;
  /** Resolved comments to paint as status-styled highlights. */
  annotations?: readonly ResolvedMarkdownAnnotation[];
  /** Invoked with the comment id when a highlighted passage is clicked. */
  onActivateAnnotation?: (target: MarkdownAnnotationTarget) => void;
  /** Any change re-syncs highlights against the current DOM (e.g. content). */
  syncSignal?: string | null;
}

export default function RecogitoAnnotatorBoundary({
  children,
  annotations,
  onActivateAnnotation,
  syncSignal,
}: RecogitoAnnotatorBoundaryProps): React.JSX.Element {
  return (
    <RecogitoAnnotator
      annotations={annotations}
      onActivateAnnotation={onActivateAnnotation}
      syncSignal={syncSignal}
    >
      {children}
    </RecogitoAnnotator>
  );
}
