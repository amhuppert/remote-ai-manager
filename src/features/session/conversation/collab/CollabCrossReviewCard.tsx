"use client";

import type {
  CollaborationAgent,
  CollaborationArtifactAgreement,
  CollaborationArtifactDisagreement,
  CollaborationGeneratedArtifact,
  CollaborationReference,
  CollaborationReviseSelfArtifact,
} from "@/lib/workflows/collaboration/types";
import CollabArtifactRefs from "@/features/session/conversation/collab/CollabArtifactRefs";
import CollabClaimsList from "@/features/session/conversation/collab/CollabClaimsList";
import CollabCollapsibleCard from "@/features/session/conversation/collab/CollabCollapsibleCard";
import CollabMarkdownText from "@/features/session/conversation/collab/CollabMarkdownText";
import {
  cardAgent,
  cardEyebrow,
  cardNarrative,
  cardSummary,
} from "@/features/session/conversation/collab/card-chrome";

export interface CollabCrossReviewCardProps {
  reviewerAgent: CollaborationAgent;
  targetAgent: CollaborationAgent;
  summary: string;
  artifacts: CollaborationGeneratedArtifact[];
  agree: CollaborationArtifactAgreement[];
  disagree: CollaborationArtifactDisagreement[];
  revise_self: CollaborationReviseSelfArtifact[];
  defaultOpen?: boolean;
  onRefClick?: (ref: CollaborationReference) => void;
}

const AGENT_LABEL: Record<CollaborationAgent, string> = {
  claude: "Claude",
  codex: "Codex",
};

export default function CollabCrossReviewCard({
  reviewerAgent,
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
      ariaLabel={`Review of ${AGENT_LABEL[targetAgent]}'s draft by ${AGENT_LABEL[reviewerAgent]}`}
      defaultOpen={defaultOpen}
      header={
        <>
          <span className={cardAgent} data-agent={reviewerAgent}>
            {AGENT_LABEL[reviewerAgent]}
          </span>
          <span className={cardEyebrow}>
            Review of {AGENT_LABEL[targetAgent]}&rsquo;s draft
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
