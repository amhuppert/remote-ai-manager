"use client";

import CopyableId from "@/components/CopyableId";

interface BranchChipProps {
  branch: string;
}

export default function BranchChip({
  branch,
}: BranchChipProps): React.JSX.Element {
  return (
    <CopyableId
      value={branch}
      truncateAt={999}
      className="s-branch"
      ariaLabel="Copy branch name"
    />
  );
}
