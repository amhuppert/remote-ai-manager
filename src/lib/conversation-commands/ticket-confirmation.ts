import type { RunCommandOutcome } from "./service";

export function ticketConfirmationFallbackMessage(identifier: string): string {
  return `Created ticket ${identifier}, but its confirmation could not be saved to this conversation.`;
}

export function ticketFailureFallbackMessage(reason: string): string {
  return `/ticket failed: ${reason} — no ticket was created. The failure notice could not be saved to this conversation.`;
}

export function ticketCommandFallbackMessage(
  outcome: RunCommandOutcome,
): string | null {
  if (outcome.status === "ticket_created" && !outcome.confirmationPersisted) {
    return ticketConfirmationFallbackMessage(outcome.identifier);
  }
  if (outcome.status === "ticket_failed" && !outcome.failureNoticePersisted) {
    return ticketFailureFallbackMessage(outcome.reason);
  }
  return null;
}
