"use client";

import { memo } from "react";

interface FinishedBannerProps {
  targetBranch: string;
}

export const FinishedBanner = memo(function FinishedBanner({
  targetBranch,
}: FinishedBannerProps): React.JSX.Element {
  return (
    <div className="finished-banner">
      Marked as merged into {targetBranch}. You can continue working in this
      session.
    </div>
  );
});

export const IterationReadonlyBanner = memo(
  function IterationReadonlyBanner(): React.JSX.Element {
    return (
      <div className="iteration-readonly-banner">
        {"\u27F3"} This conversation is managed by a workflow execution and is
        read-only.
      </div>
    );
  },
);
