"use client";

import type {
  CollaborationAgent,
  CollaborationArtifactAgreement,
  CollaborationReference,
} from "@/lib/workflows/collaboration/types";
import CollabCollapsibleCard from "./CollabCollapsibleCard";
import CollabMarkdownText from "./CollabMarkdownText";

export interface CollabInitialDraftCardProps {
  agent: CollaborationAgent;
  isPrimary: boolean;
  narrative: string;
  supporting: string[];
  assumptions: string[];
  keyClaims: CollaborationArtifactAgreement[];
  defaultOpen?: boolean;
  onRefClick?: (ref: CollaborationReference) => void;
}

const AGENT_LABEL: Record<CollaborationAgent, string> = {
  claude: "Claude",
  codex: "Codex",
};

function refLabel(ref: CollaborationReference): string {
  return ref.locator ? `${ref.artifact}#${ref.locator}` : ref.artifact;
}

export default function CollabInitialDraftCard({
  agent,
  isPrimary,
  narrative,
  supporting,
  assumptions,
  keyClaims,
  defaultOpen,
  onRefClick,
}: CollabInitialDraftCardProps): React.JSX.Element {
  const summary = [
    `${keyClaims.length} ${keyClaims.length === 1 ? "claim" : "claims"}`,
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
          <span className="collab-artifact-card-agent" data-agent={agent}>
            {AGENT_LABEL[agent]}
          </span>
          <span className="collab-artifact-card-eyebrow">Initial Draft</span>
          {isPrimary ? (
            <span className="collab-artifact-card-primary-flag">Primary</span>
          ) : null}
          <span className="collab-artifact-card-summary">{summary}</span>
        </>
      }
    >
      <CollabMarkdownText
        content={narrative}
        className="collab-artifact-card-narrative"
      />

      {keyClaims.length > 0 ? (
        <section className="collab-artifact-card-section">
          <h4 className="collab-artifact-card-section-title">
            Key claims ({keyClaims.length})
          </h4>
          <ul className="collab-artifact-card-list">
            {keyClaims.map((claim) => (
              <li key={claim.id}>
                {claim.claim}
                {claim.ref ? (
                  onRefClick ? (
                    <>
                      {" "}
                      <button
                        type="button"
                        className="collab-claims-list-ref collab-claims-list-ref--button"
                        onClick={() => onRefClick(claim.ref!)}
                      >
                        → {refLabel(claim.ref)}
                      </button>
                    </>
                  ) : (
                    <span className="collab-claims-list-ref">
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
        <section className="collab-artifact-card-section">
          <h4 className="collab-artifact-card-section-title">
            Assumptions ({assumptions.length})
          </h4>
          <ul className="collab-artifact-card-list">
            {assumptions.map((assumption, idx) => (
              <li key={`assumption-${idx}`}>{assumption}</li>
            ))}
          </ul>
        </section>
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
