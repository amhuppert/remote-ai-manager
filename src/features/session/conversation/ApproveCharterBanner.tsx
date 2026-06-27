"use client";

import { Button } from "@/components/ui/Button";
import {
  useApproveCharterMutation,
  useRejectCharterMutation,
} from "@/lib/session-alignment/mutations";
import type { AlignmentVersion } from "@/lib/session-alignment/schemas";

export interface ApproveCharterBannerViewProps {
  onApprove(): void;
  onReject(): void;
  isSubmitting: boolean;
}

/**
 * The "Approve Charter" human gate (R4.1). Approve activates the draft as a new
 * version; reject discards it and leaves the active charter unchanged.
 */
export function ApproveCharterBannerView({
  onApprove,
  onReject,
  isSubmitting,
}: ApproveCharterBannerViewProps): React.JSX.Element {
  return (
    <div className="flex shrink-0 items-center justify-between gap-md border-x-0 border-t border-b-0 border-solid border-border-subtle bg-bg-surface px-lg py-sm">
      <div className="flex min-w-0 flex-col gap-[2px]">
        <span className="font-mono text-[0.7rem] font-semibold tracking-[0.06em] text-cyan uppercase">
          Approve Charter
        </span>
        <span className="truncate font-mono text-[0.72rem] text-text-secondary">
          A charter draft is ready — approve it to govern this session, or
          reject to discard it.
        </span>
      </div>
      <div className="flex shrink-0 items-center gap-sm">
        <Button
          variant="danger"
          size="sm"
          touch
          onClick={onReject}
          disabled={isSubmitting}
        >
          Reject
        </Button>
        <Button
          variant="primary"
          size="sm"
          touch
          onClick={onApprove}
          disabled={isSubmitting}
        >
          Approve
        </Button>
      </div>
    </div>
  );
}

interface ApproveCharterBannerProps {
  projectName: string;
  sessionName: string;
  draft: AlignmentVersion;
}

export default function ApproveCharterBanner({
  projectName,
  sessionName,
  draft,
}: ApproveCharterBannerProps): React.JSX.Element {
  const approve = useApproveCharterMutation(projectName, sessionName);
  const reject = useRejectCharterMutation(projectName, sessionName);
  const isSubmitting = approve.isPending || reject.isPending;

  return (
    <ApproveCharterBannerView
      onApprove={() => approve.mutate({ draftId: draft.id })}
      onReject={() => reject.mutate({ draftId: draft.id })}
      isSubmitting={isSubmitting}
    />
  );
}
