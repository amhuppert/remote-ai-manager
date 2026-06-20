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
import {
  cardAgent,
  cardEyebrow,
  cardList,
  cardNarrative,
  cardRound,
  cardSection,
  cardSectionTitle,
  cardSummary,
  changeList,
  changeListAddresses,
  changeListAddressesId,
  changeListAddressesLabel,
  changeListChange,
  changeListId,
  changeListItem,
  changeListRationale,
  idList,
  idListItem,
} from "@/features/session/conversation/collab/card-chrome";

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
    <section className={cardSection}>
      <h4 className={cardSectionTitle}>
        {label} ({ids.length})
      </h4>
      <ul className={idList}>
        {ids.map((id) => (
          <li key={id} className={idListItem}>
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
          <span className={cardAgent} data-agent={fromAgent}>
            {AGENT_LABEL[fromAgent]}
          </span>
          <span className={cardEyebrow}>Counter-proposal</span>
          <span className={cardRound} aria-label={`Round ${round}`}>
            R{round}
          </span>
          <span className={cardSummary}>{summary}</span>
        </>
      }
    >
      <CollabMarkdownText content={narrative} className={cardNarrative} />

      <IdList ids={acceptedProposedChangeIds} label="Accepted" />
      <IdList ids={rejectedProposedChangeIds} label="Rejected" />

      {alternativeChanges.length > 0 ? (
        <section className={cardSection}>
          <h4 className={cardSectionTitle}>
            Alternative changes ({alternativeChanges.length})
          </h4>
          <ul className={changeList}>
            {alternativeChanges.map((change) => (
              <li className={changeListItem} key={change.id}>
                <span className={changeListId}>{change.id}</span>
                <span className={changeListChange}>{change.change}</span>
                <span className={changeListRationale}>
                  rationale: {change.rationale}
                </span>
                {change.addressesDisagreementIds.length > 0 ? (
                  <span className={changeListAddresses}>
                    <span className={changeListAddressesLabel}>addresses:</span>
                    {change.addressesDisagreementIds.map((id) => (
                      <span key={id} className={changeListAddressesId}>
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
        <section className={cardSection}>
          <h4 className={cardSectionTitle}>Evidence ({supporting.length})</h4>
          <ul className={cardList}>
            {supporting.map((item, idx) => (
              <li key={`supporting-${idx}`}>{item}</li>
            ))}
          </ul>
        </section>
      ) : null}
    </CollabCollapsibleCard>
  );
}
