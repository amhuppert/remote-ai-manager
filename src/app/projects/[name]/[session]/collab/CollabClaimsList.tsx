"use client";

import type {
  CollaborationArtifactAgreement,
  CollaborationArtifactDisagreement,
  CollaborationReference,
  CollaborationReviseSelfArtifact,
} from "@/lib/workflows/collaboration/types";
import CollabSeverityCategoryChip from "./CollabSeverityCategoryChip";

export interface CollabClaimsListProps {
  agree?: CollaborationArtifactAgreement[];
  disagree?: CollaborationArtifactDisagreement[];
  reviseSelf?: CollaborationReviseSelfArtifact[];
  onRefClick?: (ref: CollaborationReference) => void;
}

function refLabel(ref: CollaborationReference): string {
  return ref.locator ? `${ref.artifact}#${ref.locator}` : ref.artifact;
}

function RefButton({
  refValue,
  onRefClick,
}: {
  refValue?: CollaborationReference;
  onRefClick?: (ref: CollaborationReference) => void;
}): React.JSX.Element | null {
  if (!refValue) return null;
  const label = refLabel(refValue);
  if (!onRefClick) {
    return <span className="collab-claims-list-ref">→ {label}</span>;
  }
  return (
    <button
      type="button"
      className="collab-claims-list-ref collab-claims-list-ref--button"
      onClick={() => onRefClick(refValue)}
    >
      → {label}
    </button>
  );
}

export default function CollabClaimsList({
  agree,
  disagree,
  reviseSelf,
  onRefClick,
}: CollabClaimsListProps): React.JSX.Element | null {
  const agreeItems = agree ?? [];
  const disagreeItems = disagree ?? [];
  const reviseItems = reviseSelf ?? [];

  if (
    agreeItems.length === 0 &&
    disagreeItems.length === 0 &&
    reviseItems.length === 0
  ) {
    return null;
  }

  return (
    <div className="collab-claims-list" aria-label="Claims">
      {agreeItems.length > 0 ? (
        <section className="collab-claims-list-section" data-accent="green">
          <h4 className="collab-claims-list-section-title">
            <span aria-hidden="true">+</span> AGREE ({agreeItems.length})
          </h4>
          <dl className="collab-claims-list-items">
            {agreeItems.map((item) => (
              <div className="collab-claims-list-item" key={`agree-${item.id}`}>
                <dt className="collab-claims-list-claim">{item.claim}</dt>
                {item.ref ? (
                  <dd className="collab-claims-list-meta">
                    <RefButton refValue={item.ref} onRefClick={onRefClick} />
                  </dd>
                ) : null}
              </div>
            ))}
          </dl>
        </section>
      ) : null}

      {disagreeItems.length > 0 ? (
        <section className="collab-claims-list-section" data-accent="red">
          <h4 className="collab-claims-list-section-title">
            <span aria-hidden="true">−</span> DISAGREE ({disagreeItems.length})
          </h4>
          <dl className="collab-claims-list-items">
            {disagreeItems.map((item) => (
              <div
                className="collab-claims-list-item"
                key={`disagree-${item.id}`}
              >
                <dt className="collab-claims-list-claim">
                  <span className="collab-claims-list-claim-text">
                    {item.claim}
                  </span>{" "}
                  <CollabSeverityCategoryChip
                    severity={item.severity}
                    category={item.category}
                  />
                </dt>
                <dd className="collab-claims-list-meta">
                  <span className="collab-claims-list-reason">
                    because {item.reason}
                  </span>
                  {item.proposedResolution ? (
                    <span className="collab-claims-list-proposal">
                      proposed: {item.proposedResolution}
                    </span>
                  ) : null}
                  <RefButton refValue={item.ref} onRefClick={onRefClick} />
                </dd>
              </div>
            ))}
          </dl>
        </section>
      ) : null}

      {reviseItems.length > 0 ? (
        <section className="collab-claims-list-section" data-accent="cyan-dim">
          <h4 className="collab-claims-list-section-title">
            <span aria-hidden="true">~</span> REVISE SELF ({reviseItems.length})
          </h4>
          <dl className="collab-claims-list-items">
            {reviseItems.map((item, idx) => (
              <div className="collab-claims-list-item" key={`revise-${idx}`}>
                <dt className="collab-claims-list-claim">{item.change}</dt>
                <dd className="collab-claims-list-meta">
                  <span className="collab-claims-list-reason">
                    because “{item.because}”
                  </span>
                </dd>
              </div>
            ))}
          </dl>
        </section>
      ) : null}
    </div>
  );
}
