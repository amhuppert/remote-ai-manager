"use client";

import type { ContextProvenanceDisplay } from "@/components/workflow-graph/derive-graph";
import {
  GroupHeader,
  formatInspectorTimestamp,
  inspectorSectionClass,
} from "./chrome";

/**
 * Tasks tab → Provenance (§11): why a context that is not in the authored
 * definition exists — which context asked for it, on what grounds, and the
 * request it was accepted under. The ledger across the run is in Overview.
 */
export default function ProvenanceSection({
  provenance,
}: {
  provenance: ContextProvenanceDisplay | null;
}): React.JSX.Element | null {
  if (!provenance) return null;
  return (
    <section className={inspectorSectionClass} data-testid="context-provenance">
      <GroupHeader label="Provenance" />
      <div className="text-[0.72rem] leading-snug text-text-secondary">
        <div>
          Added at runtime by{" "}
          <span className="font-mono text-text-primary">
            {provenance.invokerContextId}
          </span>{" "}
          on {formatInspectorTimestamp(provenance.acceptedAt)}
        </div>
        <div className="mt-1 text-text-primary">{provenance.rationale}</div>
        <div className="mt-1 font-mono text-[0.7rem] text-text-tertiary">
          request {provenance.requestId} · payload{" "}
          {provenance.payloadHash.slice(0, 12)}…
        </div>
      </div>
    </section>
  );
}
