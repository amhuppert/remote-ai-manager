import { StatusChip } from "@/components/ui/StatusChip";
import type { SpecDetailView } from "@/lib/specs/queries";

import {
  deliveryLabel,
  deliveryTone,
  phaseLabels,
  phaseTones,
} from "./presentation";

export default function SpecPhaseFacets({
  status,
}: {
  status: SpecDetailView["status"];
}): React.JSX.Element {
  return (
    <div
      className="flex flex-wrap items-center gap-xs"
      data-testid="spec-phase-facets"
      aria-label="Spec phase facets"
    >
      <StatusChip tone={phaseTones[status.phase.primary]}>
        {phaseLabels[status.phase.primary]}
      </StatusChip>
      {status.phase.authoringFacet === undefined ? (
        <StatusChip tone="neutral">Authoring settled</StatusChip>
      ) : (
        <StatusChip tone={phaseTones[status.phase.authoringFacet]}>
          {phaseLabels[status.phase.authoringFacet]}
        </StatusChip>
      )}
      <StatusChip tone={deliveryTone(status.delivery)}>
        {deliveryLabel(status.delivery)}
      </StatusChip>
    </div>
  );
}
