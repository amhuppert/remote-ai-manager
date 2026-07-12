import { pushToast } from "@/stores/toast.store";
import {
  ticketIdentifier,
  ticketReferenceXml,
  type TicketRefIdentity,
} from "./ticket-reference";

export interface CopyTicketReferenceOptions {
  /** The detail button carries its own transient "Copied" confirmation. */
  announceSuccess?: boolean;
}

export async function copyTicketReference(
  item: TicketRefIdentity & { title: string },
  options: CopyTicketReferenceOptions = {},
): Promise<boolean> {
  const identifier = ticketIdentifier(item);
  try {
    await navigator.clipboard.writeText(ticketReferenceXml(item));
  } catch {
    pushToast(`Couldn't copy reference to ${identifier}`);
    return false;
  }

  if (options.announceSuccess !== false) {
    pushToast(`Copied reference to ${identifier}`);
  }
  return true;
}
