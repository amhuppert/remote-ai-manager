"use client";

import RecogitoAnnotatorBoundary from "@/features/session/document-viewer/recogito/RecogitoAnnotatorBoundary";

/**
 * Build/SSR spike surface for the recogito text annotator. Keeping a route that
 * actually mounts the annotator holds it in the Next build graph, so every
 * `bun run build` re-proves the inherited `openseadragon` peer resolves under
 * the bundler — the dependency-resolution regression this dependency set risks.
 * Mirrors the `perf-fixture-markdown` fixture-route pattern.
 */
export default function RecogitoBuildSpikePage(): React.JSX.Element {
  return (
    <div style={{ padding: "2rem" }}>
      <RecogitoAnnotatorBoundary>
        <p data-testid="recogito-spike-content">
          Select this passage to confirm the annotator mounts client-side.
        </p>
      </RecogitoAnnotatorBoundary>
    </div>
  );
}
