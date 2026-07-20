/**
 * Canonical retrieval/follow command strings for ticket attachments. Every
 * surface that shows an attachment (index renderer, resolution payloads, live
 * ticket block, kickoff prompt, CLI) formats commands through these helpers so
 * the wording never forks per surface. The `cctl` invocations must match the
 * command registrations in `src/cli/commands/`.
 */

import { quoteAgentCommandArgument } from "./command-arguments";

export function conversationCompactionGetCommand(
  conversationId: string,
): string {
  return `cctl conversation compaction get ${quoteAgentCommandArgument(conversationId)}`;
}

export function conversationReadOutlineCommand(conversationId: string): string {
  return `cctl conversation read ${quoteAgentCommandArgument(conversationId)} --outline`;
}

export function conversationReadRangeCommand(conversationId: string): string {
  return `cctl conversation read ${quoteAgentCommandArgument(conversationId)} --message-range A:B`;
}

export interface ConversationReadCommandScope {
  projectName: string;
  sessionName: string | null;
}

function conversationScopeFlags(scope: ConversationReadCommandScope): string {
  const project = ` --project ${quoteAgentCommandArgument(scope.projectName)}`;
  return scope.sessionName === null
    ? project
    : `${project} --session ${quoteAgentCommandArgument(scope.sessionName)}`;
}

/**
 * Ordered cheapest-first: compaction summary, outline, then a read window.
 * Explicit source coordinates keep every command valid from another project or
 * from a ticket session whose ambient session does not own the conversation.
 */
export function conversationReadCommands(
  conversationId: string,
  scope: ConversationReadCommandScope,
): string[] {
  const commands = [
    conversationCompactionGetCommand(conversationId),
    conversationReadOutlineCommand(conversationId),
    conversationReadRangeCommand(conversationId),
  ];
  const flags = conversationScopeFlags(scope);
  return commands.map((command) => `${command}${flags}`);
}

/** Follow command for a ticket reference (`<project>#<number>` identifier). */
export function ticketFollowCommand(identifier: string): string {
  return `cctl ticket get ${quoteAgentCommandArgument(identifier)}`;
}

/** Retrieval command for one attachment of a ticket. */
export function attachmentGetCommand(
  identifier: string,
  attachmentId: string,
): string {
  return `cctl ticket attachment get ${quoteAgentCommandArgument(identifier)} ${quoteAgentCommandArgument(attachmentId)}`;
}

/** Retry command for a conversation attachment snapshot. */
export function attachmentRefreshCommand(
  identifier: string,
  attachmentId: string,
): string {
  return `cctl ticket attachment refresh ${quoteAgentCommandArgument(identifier)} ${quoteAgentCommandArgument(attachmentId)}`;
}
