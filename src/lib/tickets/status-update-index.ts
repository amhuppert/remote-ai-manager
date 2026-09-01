import {
  STATUS_UPDATE_BODY_PREVIEW_CHARS,
  TICKET_STATUS_UPDATE_RECENT_LIMIT,
} from "./disclosure-limits";
import { normalizedBoundedPreview } from "./preview-text";
import type { TicketStatusUpdate, TicketStatusUpdateSummary } from "./schemas";
import { quoteAgentCommandArgument } from "./command-arguments";

export interface StatusUpdateIndexEntry {
  updateId: string;
  createdAt: string;
  attribution: string;
  bodyPreview: string;
  command: string;
}

export interface StatusUpdateIndex {
  entries: StatusUpdateIndexEntry[];
  total: number;
  returned: number;
  truncated: boolean;
  listCommand: string;
}

export function statusUpdateAttribution(update: TicketStatusUpdate): string {
  if (update.author.kind === "user") return "User";
  const profileName = update.author.redactedProfileSnapshot?.name ?? "Agent";
  return `${profileName} (${update.author.backend})`;
}

export function buildStatusUpdateIndex(input: {
  identifier: string;
  statusUpdates: TicketStatusUpdateSummary;
}): StatusUpdateIndex {
  const entries = [...input.statusUpdates.recent]
    .sort((left, right) => {
      const timestampOrder = right.createdAt.localeCompare(left.createdAt);
      return timestampOrder !== 0
        ? timestampOrder
        : right.id.localeCompare(left.id);
    })
    .slice(0, TICKET_STATUS_UPDATE_RECENT_LIMIT)
    .map((update) => ({
      updateId: update.id,
      createdAt: update.createdAt,
      attribution: statusUpdateAttribution(update),
      bodyPreview: statusUpdateBodyPreview(update.bodyMarkdown),
      command: `cctl ticket status-update get ${quoteAgentCommandArgument(input.identifier)} ${quoteAgentCommandArgument(update.id)}`,
    }));
  return {
    entries,
    total: input.statusUpdates.total,
    returned: entries.length,
    truncated: entries.length < input.statusUpdates.total,
    listCommand: `cctl ticket status-update list ${quoteAgentCommandArgument(input.identifier)}`,
  };
}

export function renderStatusUpdateIndexLines(
  index: StatusUpdateIndex,
): string[] {
  const entries = index.entries.map(
    (entry) =>
      `- ${entry.updateId} ${entry.createdAt} ${entry.attribution} — ${entry.bodyPreview} — ${entry.command}`,
  );
  const summary = `status updates: ${index.total} total, ${index.returned} returned, truncated=${index.truncated ? "yes" : "no"}${index.truncated ? `; rest: ${index.listCommand}` : ""}`;
  return [...entries, summary];
}

export function statusUpdateBodyPreview(bodyMarkdown: string): string {
  return normalizedBoundedPreview(
    bodyMarkdown,
    STATUS_UPDATE_BODY_PREVIEW_CHARS,
  );
}
