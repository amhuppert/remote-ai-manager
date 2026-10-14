import { StatusChip, type StatusChipTone } from "@/components/ui/StatusChip";
import type { SpecDetailView } from "@/lib/specs/queries";
import type { SpecRevisionState } from "@/lib/specs/schemas";

const revisionTone: Record<SpecRevisionState, StatusChipTone> = {
  draft: "cyan",
  approved: "green",
  withdrawn: "neutral",
};

const stateLabel: Record<SpecRevisionState, string> = {
  draft: "Draft",
  approved: "Approved",
  withdrawn: "Withdrawn",
};

export default function SpecLifecycleLanes({
  detail,
}: {
  detail: SpecDetailView;
}): React.JSX.Element {
  const approved = detail.currentApprovedRevision?.revision ?? null;
  const current = detail.currentRevision?.revision ?? null;
  const extension =
    current && approved && current.id !== approved.id ? current : null;
  return (
    <section
      aria-label="Spec lifecycle"
      className="grid gap-2xs border-x-0 border-t-0 border-b border-solid border-border-dim bg-bg-base px-xl py-sm max-768:px-md"
    >
      <div
        role="group"
        aria-label="Spec lifecycle"
        className="flex min-h-[32px] flex-wrap items-center gap-sm"
      >
        <span className="w-[72px] font-mono text-[0.62rem] font-semibold tracking-[0.1em] text-text-tertiary uppercase">
          Spec
        </span>
        {approved && (
          <span className="font-mono text-[0.7rem] text-text-secondary">
            Approved baseline · revision {approved.number}
          </span>
        )}
        {extension ? (
          <>
            <span className="text-text-tertiary" aria-hidden="true">
              →
            </span>
            <span className="font-mono text-[0.7rem] text-text-primary">
              {extension.authoringStage === "requirements"
                ? "Requirements extension"
                : "Design extension"}{" "}
              · revision {extension.number}
            </span>
            <StatusChip tone={revisionTone[extension.state]}>
              {stateLabel[extension.state]}
            </StatusChip>
          </>
        ) : current ? (
          <StatusChip tone={revisionTone[current.state]}>
            {stateLabel[current.state]}
          </StatusChip>
        ) : null}
      </div>
    </section>
  );
}
