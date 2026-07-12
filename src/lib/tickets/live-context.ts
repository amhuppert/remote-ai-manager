import { createLogger } from "@/lib/logging";
import {
  projectNameFromPath,
  type LinkedTicketContext,
} from "@/lib/state-store/tickets-repo";
import {
  buildAttachmentIndex,
  renderAttachmentIndexLines,
} from "./attachment-index";
import { ticketFollowCommand } from "./attachment-commands";
import type { TicketStatus } from "./schemas";
import { formatTicketIdentifier } from "./references";

const logger = createLogger("tickets.live-context");

/** Human-readable status wording used inside agent-facing prompt text. */
const TICKET_STATUS_LABELS: Record<TicketStatus, string> = {
  not_started: "Not Started",
  in_progress: "In Progress",
  done: "Done",
  blocked: "Blocked",
  closed: "Closed",
};

export interface LiveTicketContextProviderDeps {
  findLinkedTicket(
    projectPath: string,
    sessionName: string,
  ): Promise<LinkedTicketContext | null>;
}

export interface LiveTicketContextProvider {
  /**
   * Current `<active-ticket>` block for the session's linked ticket, or null
   * when the session is not linked. Re-reads ticket rows on every call so
   * attachment mutations appear on the next turn with no refresh step.
   */
  getForSession(
    projectPath: string,
    sessionName: string,
  ): Promise<string | null>;
}

/**
 * Renders the complete typed attachment index (entries never omitted;
 * bounded per-entry descriptions with an explicit ellipsis) plus exact
 * retrieval commands. Attachment bodies are never inlined — agents fetch
 * content through the listed commands.
 */
export function renderActiveTicketBlock(ticket: LinkedTicketContext): string {
  const identifier = formatTicketIdentifier(
    projectNameFromPath(ticket.projectPath),
    ticket.number,
  );
  const entries = buildAttachmentIndex({
    identifier,
    attachments: ticket.attachments,
    mode: "bounded",
  });
  const attachmentLines =
    entries.length === 0
      ? ["attachments: none"]
      : ["attachments:", ...renderAttachmentIndexLines(entries)];
  return [
    "<active-ticket>",
    `identifier: ${identifier}`,
    `title: ${ticket.title}`,
    `status: ${TICKET_STATUS_LABELS[ticket.status]}`,
    ...attachmentLines,
    `refresh: ${ticketFollowCommand(identifier)}`,
    "</active-ticket>",
  ].join("\n");
}

export function createLiveTicketContextProvider(
  deps: LiveTicketContextProviderDeps,
): LiveTicketContextProvider {
  return {
    async getForSession(projectPath, sessionName) {
      const startedAt = performance.now();
      const ticket = await deps.findLinkedTicket(projectPath, sessionName);
      if (ticket === null) {
        logger.debug("tickets.live-context.unlinked", {
          projectPath,
          sessionName,
          durationMs: performance.now() - startedAt,
        });
        return null;
      }
      const block = renderActiveTicketBlock(ticket);
      logger.debug("tickets.live-context.rendered", {
        identifier: formatTicketIdentifier(
          projectNameFromPath(ticket.projectPath),
          ticket.number,
        ),
        entryCount: ticket.attachments.length,
        renderedChars: block.length,
        durationMs: performance.now() - startedAt,
      });
      return block;
    },
  };
}
