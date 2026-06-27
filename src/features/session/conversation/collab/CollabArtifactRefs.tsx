"use client";

import type { CollaborationGeneratedArtifact } from "@/lib/workflows/collaboration/types";
import {
  cardList,
  cardSection,
  cardSectionTitle,
} from "@/features/session/conversation/collab/card-chrome";

export interface CollabArtifactRefsProps {
  artifacts: CollaborationGeneratedArtifact[];
  title?: string;
}

export default function CollabArtifactRefs({
  artifacts,
  title = "Artifacts",
}: CollabArtifactRefsProps): React.JSX.Element | null {
  if (artifacts.length === 0) return null;

  return (
    <section className={cardSection}>
      <h4 className={cardSectionTitle}>
        {title} ({artifacts.length})
      </h4>
      <ul className={cardList}>
        {artifacts.map((artifact) => (
          <li key={`${artifact.id}-${artifact.path}`}>
            <span className="font-mono text-[0.72rem] text-cyan-dim">
              {artifact.id}
            </span>
            {": "}
            <span>{artifact.summary}</span>{" "}
            <span className="font-mono text-[0.72rem] [overflow-wrap:anywhere] text-text-secondary">
              {artifact.path}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
