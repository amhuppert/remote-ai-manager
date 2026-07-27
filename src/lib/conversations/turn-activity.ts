import type { ConversationState } from "@/lib/conversations/schemas";

/**
 * Whether a conversation header offers a turn-abort control.
 *
 * Domain-level rather than feature-level because stopping a turn is the same
 * decision at either scope: the session panel, the split-screen pane, and the
 * project cockpit all gate their Stop on this one rule.
 *
 * `waiting_for_input` means no turn is running — a question pends and the
 * answer arrives as the next turn (docs/design/cc-cli/03 §4.3) — so status
 * alone never enables stop there. The one exception is the asking turn still
 * streaming in THIS tab (`sending`): the status has already flipped but a live
 * turn exists to abort. Workflow-driven turns are never stoppable from the
 * conversation header.
 */
export function canStopTurn(input: {
  sending: boolean;
  status: ConversationState["status"] | undefined;
  drivenByWorkflow: boolean;
}): boolean {
  if (input.drivenByWorkflow) return false;
  return input.sending || input.status === "running";
}
