"use client";

import type {
  CollaborationAgent,
  CollaborationArtifactAgreement,
  CollaborationArtifactDisagreement,
  CollaborationReference,
  CollaborationReviseSelfArtifact,
} from "@/lib/workflows/collaboration/types";
import CollabClaimsList from "./CollabClaimsList";
import CollabCollapsibleCard from "./CollabCollapsibleCard";

export interface CollabCrossReviewCardProps {
  reviewerAgent: CollaborationAgent;
  targetAgent: CollaborationAgent;
  narrative: string;
  supporting: string[];
  agree: CollaborationArtifactAgreement[];
  disagree: CollaborationArtifactDisagreement[];
  reviseSelf: CollaborationReviseSelfArtifact[];
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
  narrative,
  supporting,
  agree,
  disagree,
  reviseSelf,
  defaultOpen,
  onRefClick,
}: CollabCrossReviewCardProps): React.JSX.Element {
  const summary = [
    `${agree.length} agree`,
    `${disagree.length} disagree`,
    reviseSelf.length > 0 ? `${reviseSelf.length} revise` : null,
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
          <span
            className="collab-artifact-card-agent"
            data-agent={reviewerAgent}
          >
            {AGENT_LABEL[reviewerAgent]}
          </span>
          <span className="collab-artifact-card-eyebrow">
            Review of {AGENT_LABEL[targetAgent]}&rsquo;s draft
          </span>
          <span className="collab-artifact-card-summary">{summary}</span>
        </>
      }
    >
      <p className="collab-artifact-card-narrative">{narrative}</p>

      <CollabClaimsList
        agree={agree}
        disagree={disagree}
        reviseSelf={reviseSelf}
        onRefClick={onRefClick}
      />

      {supporting.length > 0 ? (
        <section className="collab-artifact-card-section">
          <h4 className="collab-artifact-card-section-title">
            Evidence ({supporting.length})
          </h4>
          <ul className="collab-artifact-card-list">
            {supporting.map((item, idx) => (
              <li key={`supporting-${idx}`}>{item}</li>
            ))}
          </ul>
        </section>
      ) : null}
    </CollabCollapsibleCard>
  );
}
