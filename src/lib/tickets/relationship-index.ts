import {
  RELATIONSHIP_DESCRIPTION_PREVIEW_CHARS,
  TICKET_RELATIONSHIP_OUTLINE_LIMIT,
} from "./disclosure-limits";
import { normalizedBoundedPreview } from "./preview-text";
import type { TicketRelationshipView } from "./schemas";
import { quoteAgentCommandArgument } from "./command-arguments";
import { formatTicketIdentifier } from "./references";
import { compareRelationshipViews } from "./relationship-semantics";

export interface RelationshipIndexEntry {
  relationshipId: string;
  role: TicketRelationshipView["role"];
  otherTicketIdentifier: string;
  status: TicketRelationshipView["otherTicket"]["status"];
  title: string;
  descriptionPreview: string;
  command: string;
}

export interface RelationshipIndex {
  entries: RelationshipIndexEntry[];
  total: number;
  returned: number;
  truncated: boolean;
  listCommand: string;
}

export function buildRelationshipIndex(input: {
  identifier: string;
  relationships: readonly TicketRelationshipView[];
}): RelationshipIndex {
  const selected = [...input.relationships]
    .sort(compareRelationshipViews)
    .slice(0, TICKET_RELATIONSHIP_OUTLINE_LIMIT);
  const entries = selected.map((relationship) => ({
    relationshipId: relationship.id,
    role: relationship.role,
    otherTicketIdentifier: formatTicketIdentifier(
      relationship.otherTicket.projectName,
      relationship.otherTicket.number,
    ),
    status: relationship.otherTicket.status,
    title: relationship.otherTicket.title,
    descriptionPreview:
      relationshipDescriptionPreview(relationship.description) ?? "",
    command: `cctl ticket relation get ${quoteAgentCommandArgument(input.identifier)} ${quoteAgentCommandArgument(relationship.id)}`,
  }));
  return {
    entries,
    total: input.relationships.length,
    returned: entries.length,
    truncated: entries.length < input.relationships.length,
    listCommand: `cctl ticket relation list ${quoteAgentCommandArgument(input.identifier)}`,
  };
}

export function renderRelationshipIndexLines(
  index: RelationshipIndex,
): string[] {
  const entries = index.entries.map((entry) => {
    const rationale =
      entry.descriptionPreview === "" ? "none" : entry.descriptionPreview;
    return `- ${entry.relationshipId} ${entry.role} ${entry.otherTicketIdentifier} [${entry.status}] — ${entry.title} — rationale: ${rationale} — ${entry.command}`;
  });
  const summary = `relationships: ${index.total} total, ${index.returned} returned, truncated=${index.truncated ? "yes" : "no"}${index.truncated ? `; rest: ${index.listCommand}` : ""}`;
  return [...entries, summary];
}

export function relationshipDescriptionPreview(
  description: string | null,
): string | null {
  if (description === null) {
    return null;
  }
  return normalizedBoundedPreview(
    description,
    RELATIONSHIP_DESCRIPTION_PREVIEW_CHARS,
  );
}
