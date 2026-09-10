import { TICKET_STATUS_VISUALS } from "@/lib/tickets/ticket-visuals";
import { ticketDetailHref } from "@/lib/tickets/hrefs";
import {
  buildTicketReadCommand,
  formatTicketIdentifier,
} from "@/lib/tickets/references";
import { conversationsPageHref } from "@/lib/conversations/hrefs";
import { resolveDisplayLabel } from "@/lib/conversations/display-label";
import { quoteAgentCommandArgument } from "@/lib/tickets/command-arguments";
import { buildExecutionReadCommand } from "@/lib/workflow-graph/references";
import { deriveExecutionGates } from "@/lib/workflow-graph/execution-gates";
import { deriveExecutionStatusSummary } from "@/lib/workflow-graph/execution-status-summary";
import { originFallbackName } from "@/lib/workflow-graph/execution-origin";
import { awaitsDefinitionApproval } from "@/lib/workflow-graph/lifecycle-classifier";
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
const executionStates = {
  pending: { status: "Pending", tone: "neutral" },
  running: { status: "Running", tone: "cyan" },
  paused: { status: "Paused", tone: "amber" },
  halted: { status: "Halted", tone: "red" },
  completed: { status: "Completed", tone: "green" },
  aborted: { status: "Aborted", tone: "neutral" },
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
      await import("@/lib/tickets/service-factory");
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
    const { getGraphWorkflowExecutionById } = await import("@/lib/state-store");
    const execution = await getGraphWorkflowExecutionById(
      projectPath,
      target.sessionName,
      target.id,
    );
    if (!execution) return null;
    const gates = deriveExecutionGates(execution);
    const pendingDefinition = awaitsDefinitionApproval(
      execution.status,
      execution.definitionApproval,
    );
    const activity = deriveExecutionStatusSummary(execution)
      .map((part) => part.text)
      .join("");
    return {
      title:
        execution.launchDocument?.name ?? originFallbackName(execution.origin),
      identity: execution.id,
      ...executionStates[execution.status],
      href: `/projects/${encodeURIComponent(target.projectName)}/${encodeURIComponent(target.sessionName)}/workflow?execution=${encodeURIComponent(target.id)}`,
      readCommand: buildExecutionReadCommand(
        target.projectName,
        target.sessionName,
        target.id,
      ),
      attentionCount: gates.length + (pendingDefinition ? 1 : 0),
      details: [
        { label: "Project", value: target.projectName },
        { label: "Session", value: target.sessionName },
        { label: "Activity", value: activity },
        ...(pendingDefinition
          ? [{ label: "Awaiting you", value: "Definition approval" }]
          : []),
        ...gates.map((gate) => ({
          label: "Awaiting you",
          value: `${gate.contextTitle} · ${gate.detail}`,
        })),
      ],
    };
  },
};
