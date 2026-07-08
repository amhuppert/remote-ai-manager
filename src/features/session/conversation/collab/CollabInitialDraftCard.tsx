"use client";

import type {
  CollaborationAgent,
  CollaborationAgentModelSettings,
  CollaborationArtifactAgreement,
  CollaborationGeneratedArtifact,
  CollaborationReference,
} from "@/lib/workflows/collaboration/types";
import CollabAgentModelMeta, {
  AGENT_LABEL,
} from "@/features/session/conversation/collab/CollabAgentModelMeta";
import CollabArtifactRefs from "@/features/session/conversation/collab/CollabArtifactRefs";
import CollabCollapsibleCard from "@/features/session/conversation/collab/CollabCollapsibleCard";
import CollabMarkdownText from "@/features/session/conversation/collab/CollabMarkdownText";
import {
  claimsRefButtonClass,
  claimsRefSpanClass,
} from "@/features/session/conversation/collab/CollabClaimsList";
import {
  cardAgent,
  cardEyebrow,
  cardList,
  cardNarrative,
  cardPrimaryFlag,
  cardSection,
  cardSectionTitle,
  cardSummary,
} from "@/features/session/conversation/collab/card-chrome";

export interface CollabInitialDraftCardProps {
  agent: CollaborationAgent;
  modelSettings?: CollaborationAgentModelSettings;
  isPrimary: boolean;
  summary: string;
  artifacts: CollaborationGeneratedArtifact[];
  assumptions: string[];
  key_claims: CollaborationArtifactAgreement[];
  defaultOpen?: boolean;
  onRefClick?: (ref: CollaborationReference) => void;
}

function refLabel(ref: CollaborationReference): string {
  return ref.locator ? `${ref.artifact}#${ref.locator}` : ref.artifact;
}

export default function CollabInitialDraftCard({
  agent,
  modelSettings,
  isPrimary,
  summary,
  artifacts,
  assumptions,
  key_claims,
  defaultOpen,
  onRefClick,
}: CollabInitialDraftCardProps): React.JSX.Element {
  const headerSummary = [
    `${key_claims.length} ${key_claims.length === 1 ? "claim" : "claims"}`,
    `${assumptions.length} ${assumptions.length === 1 ? "assumption" : "assumptions"}`,
  ].join(" · ");

  return (
    <CollabCollapsibleCard
      agent={agent}
      kind="initial_draft"
      ariaLabel={`Initial draft from ${AGENT_LABEL[agent]}`}
      defaultOpen={defaultOpen}
      header={
        <>
          <span className={cardAgent} data-agent={agent}>
            {AGENT_LABEL[agent]}
            <CollabAgentModelMeta settings={modelSettings} />
          </span>
          <span className={cardEyebrow}>Initial Draft</span>
          {isPrimary ? <span className={cardPrimaryFlag}>Primary</span> : null}
          <span className={cardSummary}>{headerSummary}</span>
        </>
      }
    >
      <CollabMarkdownText content={summary} className={cardNarrative} />

      {key_claims.length > 0 ? (
        <section className={cardSection}>
          <h4 className={cardSectionTitle}>Key claims ({key_claims.length})</h4>
          <ul className={cardList}>
            {key_claims.map((claim) => (
              <li key={claim.id}>
                {claim.claim}
                {claim.ref ? (
                  onRefClick ? (
                    <>
                      {" "}
                      <button
                        type="button"
                        className={claimsRefButtonClass}
                        onClick={() => onRefClick(claim.ref!)}
                      >
                        → {refLabel(claim.ref)}
                      </button>
                    </>
                  ) : (
                    <span className={claimsRefSpanClass}>
                      {" "}
                      → {refLabel(claim.ref)}
                    </span>
                  )
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {assumptions.length > 0 ? (
        <section className={cardSection}>
          <h4 className={cardSectionTitle}>
            Assumptions ({assumptions.length})
          </h4>
          <ul className={cardList}>
            {assumptions.map((assumption, idx) => (
              <li key={`assumption-${idx}`}>{assumption}</li>
            ))}
          </ul>
        </section>
      ) : null}

      <CollabArtifactRefs artifacts={artifacts} />
    </CollabCollapsibleCard>
  );
}
