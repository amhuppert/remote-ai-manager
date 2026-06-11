"use client";

import { memo } from "react";
import ConfirmDialog from "@/components/ConfirmDialog";
import {
  useCancelDeleteSessionDetail,
  useShowDeleteConfirm,
} from "@/stores/session-detail.store";

interface PendingConcurrentSubmission {
  busyNames: string[];
}

interface ConversationDialogsProps {
  sessionName: string;
  /** Pending submission while user decides whether to interrupt another agent. */
  pendingConcurrentSubmission: PendingConcurrentSubmission | null;
  onDeleteConfirm: () => void;
  onConcurrentConfirm: () => void;
  onConcurrentCancel: () => void;
}

/**
 * Hosts the modal dialogs for the conversation page. Self-subscribes to
 * the Zustand `show*` flags so the parent does not need to and therefore does
 * not re-render when a dialog opens or closes.
 */
function ConversationDialogs({
  sessionName,
  pendingConcurrentSubmission,
  onDeleteConfirm,
  onConcurrentConfirm,
  onConcurrentCancel,
}: ConversationDialogsProps): React.JSX.Element {
  const showDeleteConfirm = useShowDeleteConfirm();
  const cancelDelete = useCancelDeleteSessionDetail();

  return (
    <>
      <ConfirmDialog
        open={showDeleteConfirm}
        title="Delete session?"
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
    </>
  );
}

export default memo(ConversationDialogs);
