"use client";

import type {
  CollaborationAgent,
  CollaborationArtifactAgreement,
  CollaborationArtifactDisagreement,
  CollaborationChangeProposal,
  CollaborationReference,
} from "@/lib/workflows/collaboration/types";
import CollabClaimsList from "@/features/session/conversation/collab/CollabClaimsList";
import CollabCollapsibleCard from "@/features/session/conversation/collab/CollabCollapsibleCard";
import CollabMarkdownText from "@/features/session/conversation/collab/CollabMarkdownText";

export interface CollabProposedChangesCardProps {
  fromAgent: CollaborationAgent;
  round: number;
  narrative: string;
  acceptedFromAgentTwoDraft: CollaborationArtifactAgreement[];
  proposedChanges: CollaborationChangeProposal[];
  remainingDisagreements: CollaborationArtifactDisagreement[];
  supporting: string[];
  defaultOpen?: boolean;
  onRefClick?: (ref: CollaborationReference) => void;
}

const AGENT_LABEL: Record<CollaborationAgent, string> = {
  claude: "Claude",
  codex: "Codex",
};

export default function CollabProposedChangesCard({
  fromAgent,
  round,
  narrative,
  acceptedFromAgentTwoDraft,
  proposedChanges,
  remainingDisagreements,
  supporting,
  defaultOpen,
  onRefClick,
}: CollabProposedChangesCardProps): React.JSX.Element {
  const summary = [
    `${proposedChanges.length} ${proposedChanges.length === 1 ? "change" : "changes"}`,
    remainingDisagreements.length > 0
      ? `${remainingDisagreements.length} disagree`
      : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <CollabCollapsibleCard
      agent={fromAgent}
      kind="proposed_changes"
      ariaLabel={`Proposed changes round ${round} from ${AGENT_LABEL[fromAgent]}`}
      defaultOpen={defaultOpen}
      header={
        <>
          <span className="collab-artifact-card-agent" data-agent={fromAgent}>
            {AGENT_LABEL[fromAgent]}
          </span>
          <span className="collab-artifact-card-eyebrow">Proposed changes</span>
          <span
            className="collab-artifact-card-round"
            aria-label={`Round ${round}`}
          >
            R{round}
          </span>
          <span className="collab-artifact-card-summary">{summary}</span>
        </>
      }
    >
      <CollabMarkdownText
        content={narrative}
        className="collab-artifact-card-narrative"
      />

      {acceptedFromAgentTwoDraft.length > 0 ? (
        <CollabClaimsList
          agree={acceptedFromAgentTwoDraft}
          onRefClick={onRefClick}
        />
      ) : null}

      {proposedChanges.length > 0 ? (
        <section className="collab-artifact-card-section">
          <h4 className="collab-artifact-card-section-title">
            Proposed changes ({proposedChanges.length})
          </h4>
          <ul className="collab-change-list">
            {proposedChanges.map((change) => (
              <li className="collab-change-list-item" key={change.id}>
                <span className="collab-change-list-id">{change.id}</span>
                <span className="collab-change-list-change">
                  {change.change}
                </span>
                <span className="collab-change-list-rationale">
                  rationale: {change.rationale}
                </span>
                {change.addressesDisagreementIds.length > 0 ? (
                  <span className="collab-change-list-addresses">
                    <span className="collab-change-list-addresses-label">
                      addresses:
                    </span>
                    {change.addressesDisagreementIds.map((id) => (
                      <span
                        key={id}
                        className="collab-change-list-addresses-id"
                      >
                        {id}
                      </span>
                    ))}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {remainingDisagreements.length > 0 ? (
        <CollabClaimsList
          disagree={remainingDisagreements}
          onRefClick={onRefClick}
        />
      ) : null}

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
