"use client";

import { backendLabel } from "@/lib/agent-backends/catalog";

import type {
  CollaborationAgent,
  CollaborationAgentModelSettings,
  CollaborationArtifactAgreement,
  CollaborationArtifactDisagreement,
  CollaborationChangeProposal,
  CollaborationGeneratedArtifact,
  CollaborationReference,
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
  collabAgentTone,
} from "@/features/session/conversation/collab/card-chrome";

export interface CollabCounterProposalCardProps {
  fromAgent: CollaborationAgent;
  fromModelSettings?: CollaborationAgentModelSettings;
  round: number;
  summary: string;
  artifacts: CollaborationGeneratedArtifact[];
  accepted_change_ids: string[];
  rejected_change_ids: string[];
  alternative_changes: CollaborationChangeProposal[];
  agree: CollaborationArtifactAgreement[];
  disagree: CollaborationArtifactDisagreement[];
  defaultOpen?: boolean;
  onRefClick?: (ref: CollaborationReference) => void;
}

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
  fromModelSettings,
  round,
  summary,
  artifacts,
  accepted_change_ids,
  rejected_change_ids,
  alternative_changes,
  agree,
  disagree,
  defaultOpen,
  onRefClick,
}: CollabCounterProposalCardProps): React.JSX.Element {
  const headerSummary = [
    accepted_change_ids.length > 0
      ? `${accepted_change_ids.length} accepted`
      : null,
    rejected_change_ids.length > 0
      ? `${rejected_change_ids.length} rejected`
      : null,
    alternative_changes.length > 0
      ? `${alternative_changes.length} alternative`
      : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <CollabCollapsibleCard
      agent={fromAgent}
      kind="counter_proposal"
      ariaLabel={`Counter-proposal round ${round} from ${backendLabel(fromAgent)}`}
      defaultOpen={defaultOpen}
      header={
        <>
          <span
            className={cardAgent}
            data-agent={fromAgent}
            data-tone={collabAgentTone(fromAgent)}
          >
            {backendLabel(fromAgent)}
            <CollabAgentModelMeta settings={fromModelSettings} />
          </span>
          <span className={cardEyebrow}>Counter-proposal</span>
          <span className={cardRound} aria-label={`Round ${round}`}>
            R{round}
          </span>
          <span className={cardSummary}>{headerSummary}</span>
        </>
      }
    >
      <CollabMarkdownText content={summary} className={cardNarrative} />

      <IdList ids={accepted_change_ids} label="Accepted" />
      <IdList ids={rejected_change_ids} label="Rejected" />

      {alternative_changes.length > 0 ? (
        <section className={cardSection}>
          <h4 className={cardSectionTitle}>
            Alternative changes ({alternative_changes.length})
          </h4>
          <ul className={changeList}>
            {alternative_changes.map((change) => (
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

      <CollabClaimsList
        agree={agree}
        disagree={disagree}
        onRefClick={onRefClick}
      />

      <CollabArtifactRefs artifacts={artifacts} />
    </CollabCollapsibleCard>
  );
}
