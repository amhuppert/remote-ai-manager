import { TICKET_STATUS_VISUALS } from "@/lib/tickets/ticket-visuals";
import { ticketDetailHref } from "@/lib/tickets/hrefs";
import {
  buildTicketReadCommand,
  formatTicketIdentifier,
} from "@/lib/tickets/references";
import { conversationsPageHref } from "@/lib/conversations/hrefs";
import { resolveDisplayLabel } from "@/lib/conversations/display-label";
import { quoteAgentCommandArgument } from "@/lib/tickets/command-arguments";
import type { LiveReferenceReader } from "./service";
import type { LiveReferenceSummary } from "./schemas";

const ticketTones = {
  not_started: "neutral",
  in_progress: "cyan",
  done: "green",
  blocked: "red",
  closed: "neutral",
} as const;
const conversationStates = {
  new: { status: "New", tone: "neutral" },
  running: { status: "Running", tone: "cyan" },
  awaiting: { status: "Awaiting", tone: "amber" },
  waiting_for_input: { status: "Waiting for input", tone: "amber" },
} as const;

export const liveReferenceReader: LiveReferenceReader = {
  async read(target): Promise<LiveReferenceSummary | null> {
    if (target.kind === "conversation") {
      const { findConversationById } =
        await import("@/lib/conversations/cross-project-list");
      const conversation = await findConversationById(target.id);
      if (!conversation || conversation.projectName !== target.projectName)
        return null;
      return {
        title: resolveDisplayLabel(conversation),
        identity: conversation.conversationId,
        ...conversationStates[conversation.status],
        href: conversationsPageHref({ conversationId: target.id }),
        readCommand: `cctl conversation read ${quoteAgentCommandArgument(target.id)}`,
        attentionCount: 0,
        details: [
          { label: "Project", value: conversation.projectName },
          {
            label: "Scope",
            value:
              conversation.scope === "session"
                ? conversation.sessionName
                : "Project conversation",
          },
          { label: "Agent", value: conversation.backend },
          { label: "Last activity", value: conversation.lastActivityAt },
        ],
      };
    }
    const { getTicketProjectResolver, getTicketsRepo } =
      await import("@/lib/tickets/storage-production");
    const projectPath =
      await getTicketProjectResolver().resolveKnownProjectPath(
        target.projectName,
      );
    if (!projectPath) return null;
    if (target.kind === "ticket") {
      const number = Number(target.id);
      if (!Number.isSafeInteger(number) || number <= 0) return null;
      const ticket = await getTicketsRepo().findListItem(projectPath, number);
      if (!ticket) return null;
      const identity = formatTicketIdentifier(target.projectName, number);
      return {
        title: ticket.title,
        identity,
        status: TICKET_STATUS_VISUALS[ticket.status].label,
        tone: ticketTones[ticket.status],
        href: ticketDetailHref(target.projectName, number),
        readCommand: buildTicketReadCommand(identity),
        attentionCount: 0,
        details: [
          { label: "Project", value: target.projectName },
          { label: "Work type", value: ticket.workType },
        ],
      };
    }
    return null;
  },
};
