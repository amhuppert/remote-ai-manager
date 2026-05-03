"use client";

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

export default function CollabSeverityCategoryChip({
  severity,
  category,
}: CollabSeverityCategoryChipProps): React.JSX.Element {
  const categoryText = CATEGORY_LABEL[category];
  const severityText = SEVERITY_LABEL[severity];

  return (
    <span
      className="collab-sev-cat-chip"
      data-severity={severity}
      data-category={category}
      aria-label={`${categoryText} ${severityText}`}
    >
      <span className="collab-sev-cat-chip-segment collab-sev-cat-chip-category">
        {categoryText}
      </span>
      <span className="collab-sev-cat-chip-divider" aria-hidden="true">
        ·
      </span>
      <span className="collab-sev-cat-chip-segment collab-sev-cat-chip-severity">
        {severityText}
      </span>
    </span>
  );
}
