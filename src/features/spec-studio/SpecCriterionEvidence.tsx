import { StatusChip, type StatusChipTone } from "@/components/ui/StatusChip";
import type { SpecCriterionDisposition } from "@/lib/specs/schemas";

export interface CriterionEvidenceStatusInput {
  revisionApproved: boolean;
  disposition: SpecCriterionDisposition | null;
  evidenceCount: number;
  currentVerdictCount: number;
  waiverCurrent: boolean;
}

export function criterionEvidenceStatus(input: CriterionEvidenceStatusInput): {
  label: string;
  tone: StatusChipTone;
} {
  if (!input.revisionApproved)
    return { label: "Not approved", tone: "neutral" };
  if (input.disposition === "delivered_elsewhere") {
    return { label: "Delivered elsewhere", tone: "green" };
  }
  if (input.disposition === "deferred") {
    return { label: "Deferred", tone: "neutral" };
  }
  if (input.disposition === "waived" || input.waiverCurrent) {
    return { label: "Waived", tone: "amber" };
  }
  if (input.currentVerdictCount > 0) return { label: "Proven", tone: "green" };
  if (input.evidenceCount > 0) {
    return { label: "Partially proven", tone: "amber" };
  }
  return { label: "Needs proof", tone: "neutral" };
}

export default function SpecCriterionEvidence({
  revisionApproved,
  disposition,
  evidence,
  currentVerdictCount,
  waiverCurrent,
  validationKinds,
  validationNote,
}: {
  revisionApproved: boolean;
  disposition: SpecCriterionDisposition | null;
  evidence: readonly string[];
  currentVerdictCount: number;
  waiverCurrent: boolean;
  validationKinds: readonly string[];
  validationNote?: string;
}): React.JSX.Element {
  const status = criterionEvidenceStatus({
    revisionApproved,
    disposition,
    evidenceCount: evidence.length,
    currentVerdictCount,
    waiverCurrent,
  });
  return (
    <details className="rounded-sm border border-solid border-border-dim bg-bg-surface px-sm py-xs">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-sm font-mono text-[0.68rem] text-text-tertiary">
        <span>Evidence</span>
        <StatusChip tone={status.tone}>{status.label}</StatusChip>
      </summary>
      <div className="mt-sm grid gap-xs border-x-0 border-t border-b-0 border-solid border-border-dim pt-sm font-mono text-[0.68rem] text-text-secondary">
        <p className="m-0">
          Validation:{" "}
          {validationKinds.length > 0
            ? validationKinds.join(", ")
            : "unspecified"}
        </p>
        {validationNote && <p className="m-0">{validationNote}</p>}
        {evidence.length > 0 && (
          <ul className="m-0 list-none p-0">
            {evidence.map((record) => (
              <li key={record}>{record}</li>
            ))}
          </ul>
        )}
      </div>
    </details>
  );
}
