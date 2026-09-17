import { z } from "zod";
import {
  renderAttachmentIndexLines,
  type AttachmentIndexEntry,
} from "@/lib/tickets/attachment-index";
import { invocation } from "cli-for-agents";
import { renderInvocation } from "cli-for-agents/runtime";
import {
  relationGetCommand,
  relationListCommand,
  statusGetCommand,
  statusListCommand,
} from "./definitions";
import {
  TICKET_PAGE_DEFAULT_LIMIT,
  TICKET_RELATIONSHIP_OUTLINE_LIMIT,
  TICKET_STATUS_UPDATE_RECENT_LIMIT,
} from "@/lib/tickets/disclosure-limits";
import { relationshipDescriptionPreview } from "@/lib/tickets/relationship-index";
import { compareRelationshipViews } from "@/lib/tickets/relationship-semantics";
import {
  ticketDetailSchema,
  ticketRelationshipPageSchema,
  ticketRelationshipViewSchema,
  ticketStatusUpdatePageSchema,
  ticketStatusUpdateSchema,
  ticketStatusSchema,
  type TicketDetail,
  type TicketRelationshipPage,
  type TicketRelationshipView,
  type TicketStatusUpdate,
  type TicketStatusUpdatePage,
} from "@/lib/tickets/schemas";
import { statusUpdateBodyPreview } from "@/lib/tickets/status-update-index";
const ticketDisclosureNextSchema = z
  .object({
    cursor: z.string().min(1).nullable(),
    command: z.string().min(1),
  })
  .strict();

const completeDisclosureMetadataSchema = z
  .object({
    total: z.number().int().nonnegative(),
    returned: z.number().int().nonnegative(),
    truncated: z.literal(false),
  })
  .strict()
  .superRefine((metadata, context) => {
    if (metadata.returned > metadata.total) {
      context.addIssue({
        code: "custom",
        path: ["returned"],
        message: "returned cannot exceed total",
      });
    }
  });

const truncatedDisclosureMetadataSchema = z
  .object({
    total: z.number().int().nonnegative(),
    returned: z.number().int().nonnegative(),
    truncated: z.literal(true),
    next: ticketDisclosureNextSchema,
  })
  .strict()
  .superRefine((metadata, context) => {
    if (metadata.returned > metadata.total) {
      context.addIssue({
        code: "custom",
        path: ["returned"],
        message: "returned cannot exceed total",
      });
    }
  });

export const ticketDisclosureMetadataSchema = z.union([
  completeDisclosureMetadataSchema,
  truncatedDisclosureMetadataSchema,
]);
export type TicketDisclosureMetadata = z.infer<
  typeof ticketDisclosureMetadataSchema
>;

export const ticketRelationshipOutlineSchema = z
  .object({
    id: z.string().min(1),
    role: ticketRelationshipViewSchema.shape.role,
    otherTicket: z.string().min(1),
    otherStatus: ticketStatusSchema,
    otherTitle: z.string().min(1),
    descriptionPreview: z.string(),
    updatedAt: z.string().min(1),
    getCommand: z.string().min(1),
  })
  .strict();
export type TicketRelationshipOutline = z.infer<
  typeof ticketRelationshipOutlineSchema
>;

export const ticketStatusUpdateOutlineSchema = z
  .object({
    id: z.string().min(1),
    createdAt: z.string().min(1),
    authorKind: z.enum(["user", "agent"]),
    authorLabel: z.string().min(1),
    backend: z.string().min(1).nullable(),
    conversationId: z.string().min(1).nullable(),
    bodyPreview: z.string(),
    getCommand: z.string().min(1),
  })
  .strict();
export type TicketStatusUpdateOutline = z.infer<
  typeof ticketStatusUpdateOutlineSchema
>;

const relationshipPageCompleteSchema =
  completeDisclosureMetadataSchema.safeExtend({
    items: z.array(ticketRelationshipOutlineSchema),
  });
const relationshipPageTruncatedSchema =
  truncatedDisclosureMetadataSchema.safeExtend({
    items: z.array(ticketRelationshipOutlineSchema),
  });
export const ticketRelationshipPageProjectionSchema = z.union([
  relationshipPageCompleteSchema,
  relationshipPageTruncatedSchema,
]);
export type TicketRelationshipPageProjection = z.infer<
  typeof ticketRelationshipPageProjectionSchema
>;

const statusUpdatePageCompleteSchema =
  completeDisclosureMetadataSchema.safeExtend({
    items: z.array(ticketStatusUpdateOutlineSchema),
  });
const statusUpdatePageTruncatedSchema =
  truncatedDisclosureMetadataSchema.safeExtend({
    items: z.array(ticketStatusUpdateOutlineSchema),
  });
export const ticketStatusUpdatePageProjectionSchema = z.union([
  statusUpdatePageCompleteSchema,
  statusUpdatePageTruncatedSchema,
]);
export type TicketStatusUpdatePageProjection = z.infer<
  typeof ticketStatusUpdatePageProjectionSchema
>;

const attachmentIndexEntrySchema = z
  .object({
    attachmentId: z.string().min(1),
    kind: z.enum(["file", "conversation", "session", "note"]),
    description: z.string(),
    truncated: z.boolean(),
    commands: z.array(z.string().min(1)).min(1),
  })
  .strict();

const ticketGetItemSchema = ticketDetailSchema
  .omit({ relationships: true, statusUpdates: true })
  .extend({
    relationships: ticketRelationshipPageProjectionSchema,
    statusUpdates: ticketStatusUpdatePageProjectionSchema,
  })
  .strict();

export const ticketGetProjectionSchema = z
  .object({
    ticket: ticketGetItemSchema,
    attachmentIndex: z.array(attachmentIndexEntrySchema),
  })
  .strict();
export type TicketGetProjection = z.infer<typeof ticketGetProjectionSchema>;

export interface TicketPageCommandOptions {
  readonly role?: TicketRelationshipView["role"];
  readonly limit: number;
  readonly cursor?: string;
  readonly server?: string;
}

function ticketIdentifier(
  ticket: Pick<TicketDetail, "projectName" | "number">,
): string {
  return `${ticket.projectName}#${ticket.number}`;
}

export function relationshipGetCommand(
  identifier: string,
  relationshipId: string,
  server?: string,
): string {
  return renderInvocation(
    invocation(relationGetCommand, {
      args: { ticket: identifier, "relationship-id": relationshipId },
      flags: server === undefined ? {} : { server },
    }),
    "cctl",
  );
}

export function statusUpdateGetCommand(
  identifier: string,
  updateId: string,
  server?: string,
): string {
  return renderInvocation(
    invocation(statusGetCommand, {
      args: { ticket: identifier, "update-id": updateId },
      flags: server === undefined ? {} : { server },
    }),
    "cctl",
  );
}

export function relationshipListCommand(
  identifier: string,
  options: TicketPageCommandOptions,
): string {
  return renderInvocation(
    invocation(relationListCommand, {
      args: { ticket: identifier },
      flags: { ...options },
    }),
    "cctl",
  );
}

export function statusUpdateListCommand(
  identifier: string,
  options: Omit<TicketPageCommandOptions, "role">,
): string {
  return renderInvocation(
    invocation(statusListCommand, {
      args: { ticket: identifier },
      flags: { ...options },
    }),
    "cctl",
  );
}

export function buildRelationshipOutline(
  relationship: TicketRelationshipView,
  identifier: string,
  server?: string,
): TicketRelationshipOutline {
  return ticketRelationshipOutlineSchema.parse({
    id: relationship.id,
    role: relationship.role,
    otherTicket: ticketIdentifier(relationship.otherTicket),
    otherStatus: relationship.otherTicket.status,
    otherTitle: relationship.otherTicket.title,
    descriptionPreview:
      relationshipDescriptionPreview(relationship.description) ?? "",
    updatedAt: relationship.updatedAt,
    getCommand: relationshipGetCommand(identifier, relationship.id, server),
  });
}

function statusUpdateAuthorOutline(
  update: TicketStatusUpdate,
): Pick<
  TicketStatusUpdateOutline,
  "authorKind" | "authorLabel" | "backend" | "conversationId"
> {
  if (update.author.kind === "user") {
    return {
      authorKind: "user",
      authorLabel: "User",
      backend: null,
      conversationId: null,
    };
  }
  return {
    authorKind: "agent",
    authorLabel: update.author.redactedProfileSnapshot?.name ?? "Agent",
    backend: update.author.backend,
    conversationId: update.author.conversationId,
  };
}

export function buildStatusUpdateOutline(
  update: TicketStatusUpdate,
  identifier: string,
  server?: string,
): TicketStatusUpdateOutline {
  return ticketStatusUpdateOutlineSchema.parse({
    id: update.id,
    createdAt: update.createdAt,
    ...statusUpdateAuthorOutline(update),
    bodyPreview: statusUpdateBodyPreview(update.bodyMarkdown),
    getCommand: statusUpdateGetCommand(identifier, update.id, server),
  });
}

function completeMetadata(
  total: number,
  returned: number,
): TicketDisclosureMetadata {
  return ticketDisclosureMetadataSchema.parse({
    total,
    returned,
    truncated: false,
  });
}

function truncatedMetadata(
  total: number,
  returned: number,
  cursor: string | null,
  command: string,
): TicketDisclosureMetadata {
  return ticketDisclosureMetadataSchema.parse({
    total,
    returned,
    truncated: true,
    next: { cursor, command },
  });
}

export function buildRelationshipPageProjection(
  page: TicketRelationshipPage,
  identifier: string,
  options: TicketPageCommandOptions,
): TicketRelationshipPageProjection {
  const parsed = ticketRelationshipPageSchema.parse(page);
  const items = parsed.items.map((item) =>
    buildRelationshipOutline(item, identifier, options.server),
  );
  const metadata =
    parsed.nextCursor === null
      ? completeMetadata(parsed.total, items.length)
      : truncatedMetadata(
          parsed.total,
          items.length,
          parsed.nextCursor,
          relationshipListCommand(identifier, {
            ...options,
            cursor: parsed.nextCursor,
          }),
        );
  return ticketRelationshipPageProjectionSchema.parse({ items, ...metadata });
}

export function buildStatusUpdatePageProjection(
  page: TicketStatusUpdatePage,
  identifier: string,
  options: Omit<TicketPageCommandOptions, "role">,
): TicketStatusUpdatePageProjection {
  const parsed = ticketStatusUpdatePageSchema.parse(page);
  const items = parsed.items.map((item) =>
    buildStatusUpdateOutline(item, identifier, options.server),
  );
  const metadata =
    parsed.nextCursor === null
      ? completeMetadata(parsed.total, items.length)
      : truncatedMetadata(
          parsed.total,
          items.length,
          parsed.nextCursor,
          statusUpdateListCommand(identifier, {
            ...options,
            cursor: parsed.nextCursor,
          }),
        );
  return ticketStatusUpdatePageProjectionSchema.parse({ items, ...metadata });
}

export function buildTicketGetProjection(
  detail: TicketDetail,
  attachmentIndex: AttachmentIndexEntry[],
  server?: string,
): TicketGetProjection {
  const parsed = ticketDetailSchema.parse(detail);
  const identifier = ticketIdentifier(parsed);
  const relationshipItems = [...parsed.relationships]
    .sort(compareRelationshipViews)
    .slice(0, TICKET_RELATIONSHIP_OUTLINE_LIMIT)
    .map((item) => buildRelationshipOutline(item, identifier, server));
  const relationshipMetadata =
    relationshipItems.length < parsed.relationships.length
      ? truncatedMetadata(
          parsed.relationships.length,
          relationshipItems.length,
          null,
          relationshipListCommand(identifier, {
            limit: TICKET_RELATIONSHIP_OUTLINE_LIMIT,
            ...(server === undefined ? {} : { server }),
          }),
        )
      : completeMetadata(parsed.relationships.length, relationshipItems.length);

  const recent = parsed.statusUpdates.recent.slice(
    0,
    TICKET_STATUS_UPDATE_RECENT_LIMIT,
  );
  const statusItems = recent.map((item) =>
    buildStatusUpdateOutline(item, identifier, server),
  );
  const statusMetadata =
    statusItems.length < parsed.statusUpdates.total
      ? truncatedMetadata(
          parsed.statusUpdates.total,
          statusItems.length,
          null,
          statusUpdateListCommand(identifier, {
            limit: TICKET_PAGE_DEFAULT_LIMIT,
            ...(server === undefined ? {} : { server }),
          }),
        )
      : completeMetadata(parsed.statusUpdates.total, statusItems.length);

  const {
    relationships: _relationships,
    statusUpdates: _statusUpdates,
    ...base
  } = parsed;
  return ticketGetProjectionSchema.parse({
    ticket: {
      ...base,
      relationships: { items: relationshipItems, ...relationshipMetadata },
      statusUpdates: { items: statusItems, ...statusMetadata },
    },
    attachmentIndex,
  });
}

function disclosureSummary(
  label: string,
  projection: TicketDisclosureMetadata,
): string {
  const base = `${label}: total=${projection.total} returned=${projection.returned} truncated=${projection.truncated}`;
  return projection.truncated
    ? `${base} — next: ${projection.next.command}`
    : base;
}

function relationshipOutlineLines(
  outline: TicketRelationshipOutline,
): string[] {
  const rationale =
    outline.descriptionPreview === "" ? "" : ` — ${outline.descriptionPreview}`;
  return [
    `- ${outline.id} ${outline.role} — ${outline.otherTicket} [${outline.otherStatus}] ${outline.otherTitle}${rationale}`,
    `  get: ${outline.getCommand}`,
  ];
}

function statusUpdateOutlineLines(
  outline: TicketStatusUpdateOutline,
): string[] {
  const source =
    outline.authorKind === "agent"
      ? ` (${outline.backend ?? "unknown backend"}, conversation ${outline.conversationId ?? "unknown"})`
      : "";
  return [
    `- ${outline.id} ${outline.createdAt} ${outline.authorLabel}${source} — ${outline.bodyPreview}`,
    `  get: ${outline.getCommand}`,
  ];
}

export function renderRelationshipPageText(
  projection: TicketRelationshipPageProjection,
): string {
  const parsed = ticketRelationshipPageProjectionSchema.parse(projection);
  return `${[
    disclosureSummary("relationships", parsed),
    ...parsed.items.flatMap(relationshipOutlineLines),
  ].join("\n")}\n`;
}

export function renderStatusUpdatePageText(
  projection: TicketStatusUpdatePageProjection,
): string {
  const parsed = ticketStatusUpdatePageProjectionSchema.parse(projection);
  return `${[
    disclosureSummary("status updates", parsed),
    ...parsed.items.flatMap(statusUpdateOutlineLines),
  ].join("\n")}\n`;
}

const RELATIONSHIP_GROUPS: ReadonlyArray<{
  role: TicketRelationshipOutline["role"];
  label: string;
}> = [
  { role: "parent", label: "parent" },
  { role: "child", label: "children" },
  { role: "depends_on", label: "depends on" },
  { role: "blocks", label: "blocks" },
  { role: "related", label: "related" },
];

export function renderTicketGetText(
  projection: TicketGetProjection,
  sessionText: string[],
): string {
  const parsed = ticketGetProjectionSchema.parse(projection);
  const ticket = parsed.ticket;
  const lines = [
    `${ticketIdentifier(ticket)}  ${ticket.title}`,
    `status: ${ticket.status}  type: ${ticket.workType}  created: ${ticket.createdAt}  updated: ${ticket.updatedAt}`,
    ...sessionText,
  ];
  if (ticket.description !== "") lines.push("", ticket.description);

  lines.push("", disclosureSummary("relationships", ticket.relationships));
  for (const group of RELATIONSHIP_GROUPS) {
    const items = ticket.relationships.items.filter(
      (item) => item.role === group.role,
    );
    if (items.length === 0) continue;
    lines.push(`${group.label}:`, ...items.flatMap(relationshipOutlineLines));
  }

  lines.push("", disclosureSummary("status updates", ticket.statusUpdates));
  lines.push(...ticket.statusUpdates.items.flatMap(statusUpdateOutlineLines));
  lines.push("");
  if (parsed.attachmentIndex.length === 0) {
    lines.push("attachments: none");
  } else {
    lines.push(
      "attachments:",
      ...renderAttachmentIndexLines(parsed.attachmentIndex),
    );
  }
  return `${lines.join("\n")}\n`;
}

export function renderRelationshipDetailText(
  relationship: TicketRelationshipView,
  identifier: string,
): string {
  const parsed = ticketRelationshipViewSchema.parse(relationship);
  const otherIdentifier = ticketIdentifier(parsed.otherTicket);
  const lines = [
    `${parsed.id} ${parsed.role} on ${identifier}`,
    `ticket: ${otherIdentifier} [${parsed.otherTicket.status}] ${parsed.otherTicket.title}`,
    `created: ${parsed.createdAt}  updated: ${parsed.updatedAt}`,
  ];
  if (parsed.description !== "") lines.push("", parsed.description);
  return `${lines.join("\n")}\n`;
}

export function renderStatusUpdateDetailText(
  update: TicketStatusUpdate,
  identifier: string,
): string {
  const parsed = ticketStatusUpdateSchema.parse(update);
  const lines = [
    `${parsed.id} status update on ${identifier}`,
    `created: ${parsed.createdAt}`,
  ];
  if (parsed.author.kind === "user") {
    lines.push("author: User");
  } else {
    const author = parsed.author;
    lines.push(
      `author: ${author.redactedProfileSnapshot?.name ?? "Agent"} (${author.backend})`,
      `conversation: ${author.conversationId}${author.conversationName === null ? "" : ` (${author.conversationName})`}`,
      author.scope === "session"
        ? `scope: ${author.projectName}/${author.sessionName}`
        : `scope: ${author.projectName} (project)`,
    );
    const profile = author.redactedProfileSnapshot;
    if (profile !== null) {
      lines.push(
        `profile: ${profile.tier}:${profile.id}@${profile.revision}`,
        `profile source hash: ${profile.sourceContentHash}`,
        `resolved instruction hash: ${profile.resolvedInstructionHash}`,
      );
    }
  }
  lines.push("", parsed.bodyMarkdown);
  return `${lines.join("\n")}\n`;
}
