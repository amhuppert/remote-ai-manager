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
} from "@/features/session/conversation/collab/card-chrome";

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
          <span className={cardAgent} data-agent={fromAgent}>
            {AGENT_LABEL[fromAgent]}
          </span>
          <span className={cardEyebrow}>Proposed changes</span>
          <span className={cardRound} aria-label={`Round ${round}`}>
            R{round}
          </span>
          <span className={cardSummary}>{summary}</span>
        </>
      }
    >
      <CollabMarkdownText content={narrative} className={cardNarrative} />

      {acceptedFromAgentTwoDraft.length > 0 ? (
        <CollabClaimsList
          agree={acceptedFromAgentTwoDraft}
          onRefClick={onRefClick}
        />
      ) : null}

      {proposedChanges.length > 0 ? (
        <section className={cardSection}>
          <h4 className={cardSectionTitle}>
            Proposed changes ({proposedChanges.length})
          </h4>
          <ul className={changeList}>
            {proposedChanges.map((change) => (
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

      {remainingDisagreements.length > 0 ? (
        <CollabClaimsList
          disagree={remainingDisagreements}
          onRefClick={onRefClick}
        />
      ) : null}

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
