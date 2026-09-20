"use client";

import { backendLabel } from "@/lib/agent-backends/catalog";

import type {
  CollaborationAgent,
  CollaborationAgentModelSettings,
  CollaborationArtifactAgreement,
  CollaborationArtifactDisagreement,
  CollaborationGeneratedArtifact,
  CollaborationReference,
  CollaborationReviseSelfArtifact,
} from "@/lib/workflows/collaboration/types";
import CollabAgentModelMeta from "@/features/session/conversation/collab/CollabAgentModelMeta";
import CollabArtifactRefs from "@/features/session/conversation/collab/CollabArtifactRefs";
import CollabClaimsList from "@/features/session/conversation/collab/CollabClaimsList";
import CollabCollapsibleCard from "@/features/session/conversation/collab/CollabCollapsibleCard";
import CollabMarkdownText from "@/features/session/conversation/collab/CollabMarkdownText";
import {
  cardAgent,
  cardEyebrow,
  cardNarrative,
  cardSummary,
  collabAgentTone,
} from "@/features/session/conversation/collab/card-chrome";

export interface CollabCrossReviewCardProps {
  reviewerAgent: CollaborationAgent;
  reviewerModelSettings?: CollaborationAgentModelSettings;
  targetAgent: CollaborationAgent;
  summary: string;
  artifacts: CollaborationGeneratedArtifact[];
  agree: CollaborationArtifactAgreement[];
  disagree: CollaborationArtifactDisagreement[];
  revise_self: CollaborationReviseSelfArtifact[];
  defaultOpen?: boolean;
  onRefClick?: (ref: CollaborationReference) => void;
}

export default function CollabCrossReviewCard({
  reviewerAgent,
  reviewerModelSettings,
  targetAgent,
  summary,
  artifacts,
  agree,
  disagree,
  revise_self,
  defaultOpen,
  onRefClick,
}: CollabCrossReviewCardProps): React.JSX.Element {
  const headerSummary = [
    `${agree.length} agree`,
    `${disagree.length} disagree`,
    revise_self.length > 0 ? `${revise_self.length} revise` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <CollabCollapsibleCard
      agent={reviewerAgent}
      kind="cross_review"
      ariaLabel={`Review of ${backendLabel(targetAgent)}'s draft by ${backendLabel(reviewerAgent)}`}
      defaultOpen={defaultOpen}
      header={
        <>
          <span
            className={cardAgent}
            data-agent={reviewerAgent}
            data-tone={collabAgentTone(reviewerAgent)}
          >
            {backendLabel(reviewerAgent)}
            <CollabAgentModelMeta settings={reviewerModelSettings} />
          </span>
          <span className={cardEyebrow}>
            Review of {backendLabel(targetAgent)}&rsquo;s draft
          </span>
          <span className={cardSummary}>{headerSummary}</span>
        </>
      }
    >
      <CollabMarkdownText content={summary} className={cardNarrative} />

      <CollabClaimsList
        agree={agree}
        disagree={disagree}
        reviseSelf={revise_self}
        onRefClick={onRefClick}
      />

      <CollabArtifactRefs artifacts={artifacts} />
    </CollabCollapsibleCard>
  );
}
