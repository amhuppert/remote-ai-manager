"use client";

import { Button } from "@/components/ui/Button";
import {
  useApproveCharterMutation,
  useRejectCharterMutation,
} from "@/lib/session-alignment/mutations";
import type { AlignmentVersion } from "@/lib/session-alignment/schemas";

export type CharterPendingAction = "approve" | "reject";

export interface ApproveCharterBannerViewProps {
  onApprove(): void;
  onReject(): void;
  /** Which action's mutation is in flight, so its button shows progress. */
  pendingAction: CharterPendingAction | null;
}

/**
 * The "Approve Charter" human gate (R4.1). Approve activates the draft as a new
 * version; reject discards it and leaves the active charter unchanged.
 */
export function ApproveCharterBannerView({
  onApprove,
  onReject,
  pendingAction,
}: ApproveCharterBannerViewProps): React.JSX.Element {
  const isSubmitting = pendingAction !== null;
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
          loading={pendingAction === "reject"}
          disabled={isSubmitting}
        >
          {pendingAction === "reject" ? "Rejecting…" : "Reject"}
        </Button>
        <Button
          variant="primary"
          size="sm"
          touch
          onClick={onApprove}
          loading={pendingAction === "approve"}
          disabled={isSubmitting}
        >
          {pendingAction === "approve" ? "Approving…" : "Approve"}
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
  const pendingAction: CharterPendingAction | null = approve.isPending
    ? "approve"
    : reject.isPending
      ? "reject"
      : null;

  return (
    <ApproveCharterBannerView
      onApprove={() => approve.mutate({ draftId: draft.id })}
      onReject={() => reject.mutate({ draftId: draft.id })}
      pendingAction={pendingAction}
    />
  );
}
