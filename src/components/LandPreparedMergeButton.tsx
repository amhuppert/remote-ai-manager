"use client";

import { useCallback } from "react";
import { Button } from "@/components/ui/Button";
import type { BackgroundJob } from "@/lib/jobs/schemas";
import {
  useLandPreparedMergeMutation,
  useDiscardPreparedMergeMutation,
} from "@/lib/git/mutations";

interface LandPreparedMergeButtonProps {
  job: BackgroundJob;
  /** Override mutations for Storybook (idle / in-flight states) */
  override?: {
    landPending?: boolean;
    discardPending?: boolean;
    onLand?: () => void;
    onDiscard?: () => void;
  };
}

function shortSha(sha: string | undefined): string {
  if (!sha) return "";
  return sha.length > 7 ? sha.slice(0, 7) : sha;
}

export default function LandPreparedMergeButton({
  job,
  override,
}: LandPreparedMergeButtonProps): React.JSX.Element {
  const landMutation = useLandPreparedMergeMutation(
    job.projectName,
    job.sessionName,
  );
  const discardMutation = useDiscardPreparedMergeMutation(
    job.projectName,
    job.sessionName,
  );

  const landPending = override?.landPending ?? landMutation.isPending;
  const discardPending = override?.discardPending ?? discardMutation.isPending;

  const handleLand = useCallback(() => {
    if (override?.onLand) {
      override.onLand();
      return;
    }
    landMutation.mutate();
  }, [landMutation, override]);

  const handleDiscard = useCallback(() => {
    if (override?.onDiscard) {
      override.onDiscard();
      return;
    }
    discardMutation.mutate();
  }, [discardMutation, override]);

  const disableLand = landPending || discardPending;
  const disableDiscard = landPending || discardPending;

  return (
    <div className="land-prepared-merge">
      <div className="land-prepared-merge-meta">
        <code className="land-prepared-merge-branch">{job.branchName}</code>
        {job.preparedSha && (
          <span className="land-prepared-merge-sha">
            {shortSha(job.preparedSha)}
          </span>
        )}
      </div>
      <div className="land-prepared-merge-actions">
        <Button
          variant="primary"
          size="sm"
          touch
          onClick={handleLand}
          disabled={disableLand}
          type="button"
        >
          {landPending ? "Landing..." : "Land"}
        </Button>
        <Button
          size="sm"
          touch
          onClick={handleDiscard}
          disabled={disableDiscard}
          type="button"
        >
          {discardPending ? "Discarding..." : "Discard"}
        </Button>
      </div>
    </div>
  );
}
