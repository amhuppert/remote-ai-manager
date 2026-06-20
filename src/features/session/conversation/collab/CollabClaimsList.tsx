"use client";

import { cn } from "@/lib/ui/cn";
import type {
  CollaborationArtifactAgreement,
  CollaborationArtifactDisagreement,
  CollaborationReference,
  CollaborationReviseSelfArtifact,
} from "@/lib/workflows/collaboration/types";
import CollabSeverityCategoryChip from "@/features/session/conversation/collab/CollabSeverityCategoryChip";

// Inline reference chip; the button form is reused by CollabInitialDraftCard.
export const claimsRefSpanClass = "font-mono text-[0.72rem] text-cyan-dim";
export const claimsRefButtonClass = cn(
  claimsRefSpanClass,
  "cursor-pointer border-none bg-transparent p-0 underline underline-offset-2 hover:text-cyan focus-visible:rounded-[2px] focus-visible:[outline:2px_solid_var(--cyan)] focus-visible:outline-offset-2 max-768:inline-flex max-768:min-h-[var(--touch-target-min)] max-768:min-w-[var(--touch-target-min)] max-768:items-center max-768:justify-center max-768:px-sm",
);

const sectionTitleClass =
  "m-0 font-mono text-[0.72rem] font-semibold tracking-[0.08em] uppercase";
const itemClass =
  "flex flex-col gap-[4px] border-0 border-l-2 border-solid pl-sm";
const claimClass =
  "m-0 inline-flex flex-wrap items-center gap-[6px] text-[0.82rem] font-medium text-text-primary";
const metaClass =
  "m-0 flex flex-wrap items-center gap-[8px] text-[0.78rem] text-text-secondary";

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
    return <span className={claimsRefSpanClass}>→ {label}</span>;
  }
  return (
    <button
      type="button"
      className={claimsRefButtonClass}
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
    <div className="flex flex-col gap-md" aria-label="Claims">
      {agreeItems.length > 0 ? (
        <section className="flex flex-col gap-[6px]" data-accent="green">
          <h4 className={cn(sectionTitleClass, "text-green")}>
            <span aria-hidden="true">+</span> AGREE ({agreeItems.length})
          </h4>
          <dl className="m-0 flex flex-col gap-[6px] p-0">
            {agreeItems.map((item) => (
              <div
                className={cn(itemClass, "border-l-green-dim")}
                key={`agree-${item.id}`}
              >
                <dt className={claimClass}>{item.claim}</dt>
                {item.ref ? (
                  <dd className={metaClass}>
                    <RefButton refValue={item.ref} onRefClick={onRefClick} />
                  </dd>
                ) : null}
              </div>
            ))}
          </dl>
        </section>
      ) : null}

      {disagreeItems.length > 0 ? (
        <section className="flex flex-col gap-[6px]" data-accent="red">
          <h4 className={cn(sectionTitleClass, "text-red")}>
            <span aria-hidden="true">−</span> DISAGREE ({disagreeItems.length})
          </h4>
          <dl className="m-0 flex flex-col gap-[6px] p-0">
            {disagreeItems.map((item) => (
              <div
                className={cn(itemClass, "border-l-red-dim")}
                key={`disagree-${item.id}`}
              >
                <dt className={claimClass}>
                  <span className="[word-break:break-word]">{item.claim}</span>{" "}
                  <CollabSeverityCategoryChip
                    severity={item.severity}
                    category={item.category}
                  />
                </dt>
                <dd className={metaClass}>
                  <span className="italic">because {item.reason}</span>
                  {item.proposedResolution ? (
                    <span className="font-mono text-[0.72rem] text-text-secondary">
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
        <section className="flex flex-col gap-[6px]" data-accent="cyan-dim">
          <h4 className={cn(sectionTitleClass, "text-cyan-dim")}>
            <span aria-hidden="true">~</span> REVISE SELF ({reviseItems.length})
          </h4>
          <dl className="m-0 flex flex-col gap-[6px] p-0">
            {reviseItems.map((item, idx) => (
              <div
                className={cn(itemClass, "border-l-cyan-dim")}
                key={`revise-${idx}`}
              >
                <dt className={claimClass}>{item.change}</dt>
                <dd className={metaClass}>
                  <span className="italic">because “{item.because}”</span>
                </dd>
              </div>
            ))}
          </dl>
        </section>
      ) : null}
    </div>
  );
}
