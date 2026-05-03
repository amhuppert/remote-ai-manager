"use client";

import type {
  CollaborationAgent,
  CollaborationArtifactAgreement,
  CollaborationArtifactDisagreement,
  CollaborationChangeProposal,
  CollaborationReference,
} from "@/lib/workflows/collaboration/types";
import CollabClaimsList from "./CollabClaimsList";
import CollabCollapsibleCard from "./CollabCollapsibleCard";

export interface CollabCounterProposalCardProps {
  fromAgent: CollaborationAgent;
  round: number;
  narrative: string;
  acceptedProposedChangeIds: string[];
  rejectedProposedChangeIds: string[];
  alternativeChanges: CollaborationChangeProposal[];
  agree: CollaborationArtifactAgreement[];
  disagree: CollaborationArtifactDisagreement[];
  supporting: string[];
  defaultOpen?: boolean;
  onRefClick?: (ref: CollaborationReference) => void;
}

const AGENT_LABEL: Record<CollaborationAgent, string> = {
  claude: "Claude",
  codex: "Codex",
};

function IdList({
  ids,
  label,
}: {
  ids: string[];
  label: string;
}): React.JSX.Element | null {
  if (ids.length === 0) return null;
  return (
    <section className="collab-artifact-card-section">
      <h4 className="collab-artifact-card-section-title">
        {label} ({ids.length})
      </h4>
      <ul className="collab-id-list">
        {ids.map((id) => (
          <li key={id} className="collab-id-list-item">
            {id}
          </li>
        ))}
      </ul>
    </section>
  );
}

export default function CollabCounterProposalCard({
  fromAgent,
  round,
  narrative,
  acceptedProposedChangeIds,
  rejectedProposedChangeIds,
  alternativeChanges,
  agree,
  disagree,
  supporting,
  defaultOpen,
  onRefClick,
}: CollabCounterProposalCardProps): React.JSX.Element {
  const summary = [
    acceptedProposedChangeIds.length > 0
      ? `${acceptedProposedChangeIds.length} accepted`
      : null,
    rejectedProposedChangeIds.length > 0
      ? `${rejectedProposedChangeIds.length} rejected`
      : null,
    alternativeChanges.length > 0
      ? `${alternativeChanges.length} alternative`
      : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <CollabCollapsibleCard
      agent={fromAgent}
      kind="counter_proposal"
      ariaLabel={`Counter-proposal round ${round} from ${AGENT_LABEL[fromAgent]}`}
      defaultOpen={defaultOpen}
      header={
        <>
          <span className="collab-artifact-card-agent" data-agent={fromAgent}>
            {AGENT_LABEL[fromAgent]}
          </span>
          <span className="collab-artifact-card-eyebrow">Counter-proposal</span>
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
      <p className="collab-artifact-card-narrative">{narrative}</p>

      <IdList ids={acceptedProposedChangeIds} label="Accepted" />
      <IdList ids={rejectedProposedChangeIds} label="Rejected" />

      {alternativeChanges.length > 0 ? (
        <section className="collab-artifact-card-section">
          <h4 className="collab-artifact-card-section-title">
            Alternative changes ({alternativeChanges.length})
          </h4>
          <ul className="collab-change-list">
            {alternativeChanges.map((change) => (
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

      <CollabClaimsList
        agree={agree}
        disagree={disagree}
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
