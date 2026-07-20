import {
  buildTicketRefXml,
  formatTicketIdentifier,
} from "@/lib/tickets/references";
import { pushToast } from "@/stores/toast.store";

export interface CopyTicketReferenceInput {
  projectName: string;
  number: number;
  title: string;
}

export interface CopyTicketReferenceOptions {
  /** The detail button carries its own transient "Copied" confirmation. */
  announceSuccess?: boolean;
}

export async function copyTicketReference(
  item: CopyTicketReferenceInput,
  options: CopyTicketReferenceOptions = {},
): Promise<boolean> {
  const identifier = formatTicketIdentifier(item.projectName, item.number);
  try {
    await navigator.clipboard.writeText(
      buildTicketRefXml({
        projectName: item.projectName,
        ticketNumber: item.number,
        title: item.title,
      }),
    );
  } catch {
    pushToast(`Couldn't copy reference to ${identifier}`);
    return false;
  }

  if (options.announceSuccess !== false) {
    pushToast(`Copied reference to ${identifier}`);
  }
  return true;
}
