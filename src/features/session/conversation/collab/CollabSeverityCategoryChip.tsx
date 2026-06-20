"use client";

import { cn } from "@/lib/ui/cn";
import type {
  CollaborationDisagreementCategory,
  CollaborationDisagreementSeverity,
} from "@/lib/workflows/collaboration/types";

export interface CollabSeverityCategoryChipProps {
  severity: CollaborationDisagreementSeverity;
  category: CollaborationDisagreementCategory;
}

const CATEGORY_LABEL: Record<CollaborationDisagreementCategory, string> = {
  objective: "OBJ",
  implementation: "IMPL",
};

const SEVERITY_LABEL: Record<CollaborationDisagreementSeverity, string> = {
  blocking: "BLOCKING",
  major: "MAJOR",
  minor: "MINOR",
};

const chipBySeverity: Record<CollaborationDisagreementSeverity, string> = {
  blocking: "bg-red border-red text-text-inverse",
  major: "bg-transparent border-red-dim text-red",
  minor: "bg-transparent border-cyan-dim text-cyan-dim",
};

const dividerBySeverity: Record<CollaborationDisagreementSeverity, string> = {
  blocking: "text-text-inverse",
  major: "text-red opacity-70",
  minor: "text-cyan-dim",
};

export default function CollabSeverityCategoryChip({
  severity,
  category,
}: CollabSeverityCategoryChipProps): React.JSX.Element {
  const categoryText = CATEGORY_LABEL[category];
  const severityText = SEVERITY_LABEL[severity];

  return (
    <span
      className={cn(
        "inline-flex items-center gap-[4px] rounded-sm border border-solid px-[6px] py-[1px] font-mono text-[length:var(--font-size-floor)] leading-[1.4] font-bold tracking-[0.06em] uppercase",
        chipBySeverity[severity],
      )}
      data-severity={severity}
      data-category={category}
      aria-label={`${categoryText} ${severityText}`}
    >
      <span className="whitespace-nowrap">{categoryText}</span>
      <span
        className={cn("font-normal", dividerBySeverity[severity])}
        aria-hidden="true"
      >
        ·
      </span>
      <span className="whitespace-nowrap">{severityText}</span>
    </span>
  );
}
