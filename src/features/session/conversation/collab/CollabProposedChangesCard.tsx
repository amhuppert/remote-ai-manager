"use client";

import type {
  CollaborationAgent,
  CollaborationAgentModelSettings,
  CollaborationArtifactAgreement,
  CollaborationArtifactDisagreement,
  CollaborationChangeProposal,
  CollaborationGeneratedArtifact,
  CollaborationReference,
} from "@/lib/workflows/collaboration/types";
import CollabAgentModelMeta, {
  AGENT_LABEL,
} from "@/features/session/conversation/collab/CollabAgentModelMeta";
import CollabArtifactRefs from "@/features/session/conversation/collab/CollabArtifactRefs";
import CollabClaimsList from "@/features/session/conversation/collab/CollabClaimsList";
import CollabCollapsibleCard from "@/features/session/conversation/collab/CollabCollapsibleCard";
import CollabMarkdownText from "@/features/session/conversation/collab/CollabMarkdownText";
import {
  cardAgent,
  cardEyebrow,
  cardNarrative,
  cardRound,
  cardSummary,
  changeList,
  changeListAddresses,
  changeListAddressesId,
  changeListAddressesLabel,
  changeListChange,
  changeListId,
  changeListItem,
  changeListRationale,
  cardSection,
  cardSectionTitle,
} from "@/features/session/conversation/collab/card-chrome";

export interface CollabProposedChangesCardProps {
  fromAgent: CollaborationAgent;
  fromModelSettings?: CollaborationAgentModelSettings;
  round: number;
  summary: string;
  artifacts: CollaborationGeneratedArtifact[];
  accepted_from_other_agent_draft: CollaborationArtifactAgreement[];
  proposed_changes: CollaborationChangeProposal[];
  remaining_disagreements: CollaborationArtifactDisagreement[];
  defaultOpen?: boolean;
  onRefClick?: (ref: CollaborationReference) => void;
}

export default function CollabProposedChangesCard({
  fromAgent,
  fromModelSettings,
  round,
  summary,
  artifacts,
  accepted_from_other_agent_draft,
  proposed_changes,
  remaining_disagreements,
  defaultOpen,
  onRefClick,
}: CollabProposedChangesCardProps): React.JSX.Element {
  const headerSummary = [
    `${proposed_changes.length} ${proposed_changes.length === 1 ? "change" : "changes"}`,
    remaining_disagreements.length > 0
      ? `${remaining_disagreements.length} disagree`
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
            <CollabAgentModelMeta settings={fromModelSettings} />
          </span>
          <span className={cardEyebrow}>Proposed changes</span>
          <span className={cardRound} aria-label={`Round ${round}`}>
            R{round}
          </span>
          <span className={cardSummary}>{headerSummary}</span>
        </>
      }
    >
      <CollabMarkdownText content={summary} className={cardNarrative} />

      {accepted_from_other_agent_draft.length > 0 ? (
        <CollabClaimsList
          agree={accepted_from_other_agent_draft}
          onRefClick={onRefClick}
        />
      ) : null}

      {proposed_changes.length > 0 ? (
        <section className={cardSection}>
          <h4 className={cardSectionTitle}>
            Proposed changes ({proposed_changes.length})
          </h4>
          <ul className={changeList}>
            {proposed_changes.map((change) => (
              <li className={changeListItem} key={change.id}>
                <span className={changeListId}>{change.id}</span>
                <span className={changeListChange}>{change.change}</span>
                <span className={changeListRationale}>
                  rationale: {change.rationale}
                </span>
                {change.addresses_disagreement_ids.length > 0 ? (
                  <span className={changeListAddresses}>
                    <span className={changeListAddressesLabel}>addresses:</span>
                    {change.addresses_disagreement_ids.map((id) => (
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

      {remaining_disagreements.length > 0 ? (
        <CollabClaimsList
          disagree={remaining_disagreements}
          onRefClick={onRefClick}
        />
      ) : null}

      <CollabArtifactRefs artifacts={artifacts} />
    </CollabCollapsibleCard>
  );
}
