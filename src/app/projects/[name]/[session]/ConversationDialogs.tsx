"use client";

import { memo } from "react";
import ConfirmDialog from "@/components/ConfirmDialog";
import {
  useCancelCommit,
  useCancelDeleteSessionDetail,
  useCancelMerge,
  useShowCommitDialog,
  useShowDeleteConfirm,
  useShowMergeDialog,
} from "@/stores/session-detail.store";
import CommitDialog from "./CommitDialog";
import SmartMergeDialog from "./SmartMergeDialog";

interface PendingConcurrentSubmission {
  busyNames: string[];
}

interface ConversationDialogsProps {
  projectName: string;
  sessionName: string;
  branchName: string;
  targetBranch: string;
  commitCount: number;
  hasUncommittedChanges: boolean;
  /** Pending submission while user decides whether to interrupt another agent. */
  pendingConcurrentSubmission: PendingConcurrentSubmission | null;
  onDeleteConfirm: () => void;
  onConcurrentConfirm: () => void;
  onConcurrentCancel: () => void;
}

/**
 * Hosts the four modal dialogs for the conversation page. Self-subscribes to
 * the Zustand `show*` flags so the parent does not need to and therefore does
 * not re-render when a dialog opens or closes.
 */
function ConversationDialogs({
  projectName,
  sessionName,
  branchName,
  targetBranch,
  commitCount,
  hasUncommittedChanges,
  pendingConcurrentSubmission,
  onDeleteConfirm,
  onConcurrentConfirm,
  onConcurrentCancel,
}: ConversationDialogsProps): React.JSX.Element {
  const showDeleteConfirm = useShowDeleteConfirm();
  const showCommitDialog = useShowCommitDialog();
  const showMergeDialog = useShowMergeDialog();
  const cancelDelete = useCancelDeleteSessionDetail();
  const cancelCommit = useCancelCommit();
  const cancelMerge = useCancelMerge();

  return (
    <>
      <ConfirmDialog
        open={showDeleteConfirm}
        title="Delete Session"
        message={`This will remove the worktree and session state for "${sessionName}". The git branch and transcripts will be preserved. This action cannot be undone.`}
        confirmLabel="Delete"
        danger
        onConfirm={onDeleteConfirm}
        onCancel={cancelDelete}
      />

      <ConfirmDialog
        open={pendingConcurrentSubmission !== null}
        title="Another agent is working"
        message={
          pendingConcurrentSubmission
            ? `${
                pendingConcurrentSubmission.busyNames.length === 1
                  ? `${pendingConcurrentSubmission.busyNames[0]} is currently running`
                  : `${pendingConcurrentSubmission.busyNames.length} other conversations are currently running`
              } in this session. If this new agent edits files, its changes can conflict with the other agent's work in the same worktree. Continue anyway?`
            : ""
        }
        confirmLabel="Send anyway"
        onConfirm={onConcurrentConfirm}
        onCancel={onConcurrentCancel}
      />

      <CommitDialog
        open={showCommitDialog}
        onClose={cancelCommit}
        onSuccess={cancelCommit}
        projectName={projectName}
        sessionName={sessionName}
      />

      <SmartMergeDialog
        open={showMergeDialog}
        onClose={cancelMerge}
        projectName={projectName}
        sessionName={sessionName}
        branchName={branchName}
        targetBranch={targetBranch}
        commitCount={commitCount}
        hasUncommittedChanges={hasUncommittedChanges}
      />
    </>
  );
}

export default memo(ConversationDialogs);
