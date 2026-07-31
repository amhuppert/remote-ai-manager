"use client";

import { useCallback } from "react";

import ConfirmDialog from "@/components/ConfirmDialog";
import { useUpdateTicketMutation } from "@/lib/tickets/mutations";
import { formatTicketIdentifier } from "@/lib/tickets/references";
import {
  useDismissMergeDonePrompt,
  useMergeDonePromptQueue,
} from "@/stores/notification.store";
import { pushToast } from "@/stores/toast.store";

/**
 * Post-merge Done suggestion for a ticket-linked session, mounted globally so
 * it reaches the operator wherever they are when the merge lands.
 *
 * The queue is filled only by merges that fully succeeded, so accepting here
 * can never mark a ticket Done off a merge that failed, hit conflicts, or is
 * still parked awaiting Land. Declining writes nothing.
 */
export default function MergeDoneTicketPromptHost(): React.JSX.Element | null {
  const queue = useMergeDonePromptQueue();
  const dismiss = useDismissMergeDonePrompt();
  const updateTicket = useUpdateTicketMutation();
  const current = queue[0];

  const handleConfirm = useCallback(() => {
    if (!current) return;
    const identifier = formatTicketIdentifier(
      current.projectName,
      current.ticketNumber,
    );
    const moveToDone = () => {
      void updateTicket
        .mutateAsync({
          projectName: current.projectName,
          number: current.ticketNumber,
          fields: { status: "done" },
        })
        .catch(() => {
          // The dialog is already gone by the time the write lands, so a
          // silent rollback would read as "moved to Done" to the operator.
          pushToast(`Couldn't move ${identifier} to Done — rolled back`, {
            action: { label: "Retry", onClick: moveToDone },
          });
        });
    };
    moveToDone();
    dismiss();
  }, [current, dismiss, updateTicket]);

  if (!current) return null;

  const identifier = formatTicketIdentifier(
    current.projectName,
    current.ticketNumber,
  );

  return (
    <ConfirmDialog
      open
      title="Move ticket to Done?"
      message={`${identifier} — ${current.ticketTitle}. The linked session merged into its target branch; this sets the ticket status to Done.`}
      confirmLabel="Move to Done"
      cancelLabel="Not now"
      onConfirm={handleConfirm}
      onCancel={dismiss}
    />
  );
}
