import type { SpecDetailView } from "@/lib/specs/queries";
import { cn } from "@/lib/ui/cn";

import { phaseLabels } from "./presentation";

const phaseClass = {
  draft: "text-amber",
  approved: "text-green",
  abandoned: "text-red",
} as const;

const phaseDotClass = {
  draft: "bg-amber shadow-[0_0_7px_var(--color-amber-glow)]",
  approved: "bg-green shadow-[0_0_7px_var(--color-green-glow)]",
  abandoned: "bg-red shadow-[0_0_7px_var(--color-red-glow)]",
} as const;

export default function SpecPhaseFacets({
  status,
}: {
  status: SpecDetailView["status"];
}): React.JSX.Element {
  const phase = status.phase.primary;
  const authoringFacet = status.phase.authoringFacet;
  const authoringStage = status.phase.authoringStage;
  const hasFacet = authoringFacet !== undefined || authoringStage !== undefined;

  return (
    <div
      role="group"
      className="flex flex-wrap items-center gap-sm"
      data-testid="spec-phase-facets"
      aria-label="Spec phase facets"
    >
      <span
        className={cn(
          "inline-flex items-center gap-xs font-mono text-[0.7rem] font-semibold tracking-[0.06em] uppercase",
          phaseClass[phase],
        )}
      >
        <span
          aria-hidden="true"
          className={cn("h-[6px] w-[6px] rounded-full", phaseDotClass[phase])}
        />
        {phaseLabels[phase]}
      </span>
      {hasFacet && (
        <span className="inline-flex items-center gap-xs rounded-full border border-solid border-border-subtle bg-bg-raised px-sm py-2xs font-mono text-[0.66rem] text-text-secondary">
          {authoringFacet !== undefined && (
            <span>{phaseLabels[authoringFacet]}</span>
          )}
          {authoringFacet !== undefined && authoringStage !== undefined && (
            <span aria-hidden="true">·</span>
          )}
          {authoringStage !== undefined && <span>{authoringStage} stage</span>}
        </span>
      )}
    </div>
  );
}
