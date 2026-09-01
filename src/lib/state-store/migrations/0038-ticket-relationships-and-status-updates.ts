import path from "node:path";

import { createLogger } from "@/lib/logging";
import { z } from "zod";

import {
  enforceCurrentSchemaCompatibility,
  publishSchemaCompatibilityBarrier,
} from "../schema-compatibility";
import { TICKET_RELATIONSHIPS_AND_STATUS_UPDATES_SCHEMA_DDL } from "../state-db";
import type { StateMigration } from "./types";

const logger = createLogger(
  "state-store/migrations/ticket-relationships-and-status-updates",
);

export const TICKET_RELATIONSHIPS_AND_STATUS_UPDATES_SCHEMA_VERSION = 13;
const MIGRATION_SCHEMA_DESCRIPTION =
  "ticket relationships and append-only status updates";

const legacyRelatedTicketPayloadSchema = z
  .object({
    kind: z.literal("related_ticket"),
    ticketId: z.string().min(1),
    identifierSnapshot: z.string().min(1),
  })
  .strict();
type LegacyRelatedTicketPayload = z.infer<
  typeof legacyRelatedTicketPayloadSchema
>;

const canonicalNotePayloadSchema = z
  .object({
    kind: z.literal("note"),
    markdown: z.string(),
  })
  .strict();

interface LegacyAttachmentRow {
  readonly id: string;
  readonly ticket_id: string;
  readonly description: string;
  readonly payload_json: string;
  readonly created_at: string;
  readonly updated_at: string;
}

interface TicketIdentity {
  readonly id: string;
  readonly project_path: string;
  readonly ticket_number: number;
}

interface ValidLegacyAttachment {
  readonly row: LegacyAttachmentRow;
  readonly host: TicketIdentity;
  readonly target: TicketIdentity;
}

interface RelationshipGroup {
  readonly sourceTicketId: string;
  readonly targetTicketId: string;
  readonly attachments: ValidLegacyAttachment[];
}

interface ConvertedLegacyAttachment {
  readonly row: LegacyAttachmentRow;
  readonly payload: LegacyRelatedTicketPayload;
  readonly reason: "missing" | "self";
}

interface MigrationCounts {
  readonly legacyAttachmentCount: number;
  readonly relationshipCount: number;
  readonly aliasCount: number;
  readonly convertedNoteCount: number;
}

class TicketRelationshipMigrationError extends Error {
  constructor(readonly reasonCode: string) {
    super(`Ticket relationship migration preflight failed: ${reasonCode}`);
    this.name = "TicketRelationshipMigrationError";
  }
}

function compareLegacyAttachments(
  left: ValidLegacyAttachment,
  right: ValidLegacyAttachment,
): number {
  if (left.row.created_at !== right.row.created_at) {
    return left.row.created_at < right.row.created_at ? -1 : 1;
  }
  if (left.row.id === right.row.id) return 0;
  return left.row.id < right.row.id ? -1 : 1;
}

function readTickets(
  db: MigrationContextDb,
): ReadonlyMap<string, TicketIdentity> {
  const rows = db
    .prepare("SELECT id, project_path, ticket_number FROM tickets")
    .all() as TicketIdentity[];
  return new Map(rows.map((row) => [row.id, row]));
}

type MigrationContextDb = Parameters<
  typeof enforceCurrentSchemaCompatibility
>[0];

function buildMigrationPlan(db: MigrationContextDb): {
  legacyAttachmentCount: number;
  groups: RelationshipGroup[];
  conversions: ConvertedLegacyAttachment[];
} {
  const tickets = readTickets(db);
  const rows = db
    .prepare(
      `SELECT id, ticket_id, description, payload_json, created_at, updated_at
       FROM ticket_attachments
       ORDER BY created_at, id`,
    )
    .all() as LegacyAttachmentRow[];
  const groups = new Map<string, RelationshipGroup>();
  const conversions: ConvertedLegacyAttachment[] = [];
  let legacyAttachmentCount = 0;

  for (const row of rows) {
    let rawPayload: unknown;
    try {
      rawPayload = JSON.parse(row.payload_json);
    } catch {
      throw new TicketRelationshipMigrationError("malformed_attachment_json");
    }
    if (
      typeof rawPayload !== "object" ||
      rawPayload === null ||
      !("kind" in rawPayload) ||
      rawPayload.kind !== "related_ticket"
    ) {
      continue;
    }

    legacyAttachmentCount += 1;
    const payload = legacyRelatedTicketPayloadSchema.safeParse(rawPayload);
    if (!payload.success) {
      throw new TicketRelationshipMigrationError(
        "invalid_related_ticket_payload",
      );
    }
    const host = tickets.get(row.ticket_id);
    if (host === undefined) {
      throw new TicketRelationshipMigrationError("missing_host_ticket");
    }
    const target = tickets.get(payload.data.ticketId);
    if (target === undefined) {
      conversions.push({ row, payload: payload.data, reason: "missing" });
      continue;
    }
    if (target.id === host.id) {
      conversions.push({ row, payload: payload.data, reason: "self" });
      continue;
    }

    const [sourceTicketId, targetTicketId] =
      host.id < target.id ? [host.id, target.id] : [target.id, host.id];
    const key = `${sourceTicketId}\u0000${targetTicketId}`;
    const group = groups.get(key);
    const attachment = { row, host, target };
    if (group === undefined) {
      groups.set(key, {
        sourceTicketId,
        targetTicketId,
        attachments: [attachment],
      });
    } else {
      group.attachments.push(attachment);
    }
  }

  return {
    legacyAttachmentCount,
    groups: [...groups.values()],
    conversions,
  };
}

function relationshipDescription(
  attachments: readonly ValidLegacyAttachment[],
): string {
  const distinct = new Map<string, ValidLegacyAttachment>();
  for (const attachment of attachments) {
    if (attachment.row.description === "") continue;
    if (!distinct.has(attachment.row.description)) {
      distinct.set(attachment.row.description, attachment);
    }
  }
  if (distinct.size === 0) return "";
  if (distinct.size === 1) return distinct.keys().next().value ?? "";
  return [...distinct.entries()]
    .map(([description, attachment]) => {
      const projectName = path.basename(attachment.host.project_path);
      return `### From ${projectName}#${attachment.host.ticket_number}\n\n${description}`;
    })
    .join("\n\n---\n\n");
}

function assertRelationship(
  db: MigrationContextDb,
  expected: {
    id: string;
    sourceTicketId: string;
    targetTicketId: string;
    description: string;
    createdAt: string;
    updatedAt: string;
  },
): void {
  const row = db
    .prepare(
      `SELECT id, description, created_at, updated_at
       FROM ticket_relationships
       WHERE relation_type = 'related'
         AND source_ticket_id = ?
         AND target_ticket_id = ?`,
    )
    .get(expected.sourceTicketId, expected.targetTicketId) as
    | {
        id: string;
        description: string;
        created_at: string;
        updated_at: string;
      }
    | undefined;
  if (
    row?.id !== expected.id ||
    row.description !== expected.description ||
    row.created_at !== expected.createdAt ||
    row.updated_at !== expected.updatedAt
  ) {
    throw new TicketRelationshipMigrationError(
      "relationship_convergence_failed",
    );
  }
}

function migrateRelationshipGroup(
  db: MigrationContextDb,
  group: RelationshipGroup,
): number {
  group.attachments.sort(compareLegacyAttachments);
  const first = group.attachments[0];
  if (first === undefined) {
    throw new TicketRelationshipMigrationError("empty_relationship_group");
  }
  const description = relationshipDescription(group.attachments);
  const updatedAt = group.attachments.reduce(
    (latest, attachment) =>
      attachment.row.updated_at > latest ? attachment.row.updated_at : latest,
    first.row.updated_at,
  );
  db.prepare(
    `INSERT OR IGNORE INTO ticket_relationships (
       id, relation_type, source_ticket_id, target_ticket_id, description,
       created_at, updated_at
     ) VALUES (?, 'related', ?, ?, ?, ?, ?)`,
  ).run(
    first.row.id,
    group.sourceTicketId,
    group.targetTicketId,
    description,
    first.row.created_at,
    updatedAt,
  );
  assertRelationship(db, {
    id: first.row.id,
    sourceTicketId: group.sourceTicketId,
    targetTicketId: group.targetTicketId,
    description,
    createdAt: first.row.created_at,
    updatedAt,
  });

  for (const attachment of group.attachments) {
    db.prepare(
      `INSERT OR IGNORE INTO ticket_relationship_legacy_aliases (
         legacy_attachment_id, relationship_id, anchor_ticket_id
       ) VALUES (?, ?, ?)`,
    ).run(attachment.row.id, first.row.id, attachment.host.id);
    const alias = db
      .prepare(
        `SELECT relationship_id, anchor_ticket_id
         FROM ticket_relationship_legacy_aliases
         WHERE legacy_attachment_id = ?`,
      )
      .get(attachment.row.id) as
      | { relationship_id: string; anchor_ticket_id: string }
      | undefined;
    if (
      alias?.relationship_id !== first.row.id ||
      alias.anchor_ticket_id !== attachment.host.id
    ) {
      throw new TicketRelationshipMigrationError("alias_convergence_failed");
    }
  }

  for (const attachment of group.attachments) {
    const deleted = db
      .prepare(
        `DELETE FROM ticket_attachments
         WHERE id = ? AND payload_json = ?`,
      )
      .run(attachment.row.id, attachment.row.payload_json);
    if (deleted.changes !== 1) {
      throw new TicketRelationshipMigrationError(
        "legacy_attachment_delete_failed",
      );
    }
  }
  return group.attachments.length;
}

function convertLegacyAttachmentToNote(
  db: MigrationContextDb,
  conversion: ConvertedLegacyAttachment,
): void {
  const reason =
    conversion.reason === "missing"
      ? "The structural target is unavailable."
      : "The structural target is invalid because a ticket cannot relate to itself.";
  const payload = {
    kind: "note" as const,
    markdown: `Formerly related ticket: ${conversion.payload.identifierSnapshot}\n\n${reason}`,
  };
  canonicalNotePayloadSchema.parse(payload);
  const payloadJson = JSON.stringify(payload);
  const updated = db
    .prepare(
      `UPDATE ticket_attachments
       SET payload_json = ?
       WHERE id = ? AND payload_json = ?`,
    )
    .run(payloadJson, conversion.row.id, conversion.row.payload_json);
  if (updated.changes !== 1) {
    throw new TicketRelationshipMigrationError("note_conversion_failed");
  }
  const stored = db
    .prepare("SELECT payload_json FROM ticket_attachments WHERE id = ?")
    .pluck()
    .get(conversion.row.id);
  if (typeof stored !== "string") {
    throw new TicketRelationshipMigrationError("note_verification_failed");
  }
  try {
    canonicalNotePayloadSchema.parse(JSON.parse(stored));
  } catch {
    throw new TicketRelationshipMigrationError("note_verification_failed");
  }
}

function migrateDatabase(db: MigrationContextDb): MigrationCounts {
  enforceCurrentSchemaCompatibility(
    db,
    db.name,
    TICKET_RELATIONSHIPS_AND_STATUS_UPDATES_SCHEMA_VERSION,
  );
  db.exec(TICKET_RELATIONSHIPS_AND_STATUS_UPDATES_SCHEMA_DDL);
  const plan = buildMigrationPlan(db);
  let aliasCount = 0;
  for (const group of plan.groups) {
    aliasCount += migrateRelationshipGroup(db, group);
  }
  for (const conversion of plan.conversions) {
    convertLegacyAttachmentToNote(db, conversion);
  }
  const remaining = buildMigrationPlan(db);
  if (remaining.legacyAttachmentCount !== 0) {
    throw new TicketRelationshipMigrationError(
      "legacy_attachment_postcondition_failed",
    );
  }
  db.prepare(
    `INSERT OR IGNORE INTO schema_migrations (version, description)
     VALUES (?, ?)`,
  ).run(
    TICKET_RELATIONSHIPS_AND_STATUS_UPDATES_SCHEMA_VERSION,
    MIGRATION_SCHEMA_DESCRIPTION,
  );
  return {
    legacyAttachmentCount: plan.legacyAttachmentCount,
    relationshipCount: plan.groups.length,
    aliasCount,
    convertedNoteCount: plan.conversions.length,
  };
}

export const ticketRelationshipsAndStatusUpdates: StateMigration = {
  name: "0038-ticket-relationships-and-status-updates",
  up: async ({ context }) => {
    if (context.configDir !== null) {
      await publishSchemaCompatibilityBarrier(
        context.configDir,
        TICKET_RELATIONSHIPS_AND_STATUS_UPDATES_SCHEMA_VERSION,
      );
    }

    let counts: MigrationCounts;
    try {
      counts = context.db
        .transaction(() => migrateDatabase(context.db))
        .immediate();
    } catch (error) {
      logger.error("ticket_relationships.migration_refused", {
        legacyAttachmentCount: 0,
        invalidAttachmentCount:
          error instanceof TicketRelationshipMigrationError ? 1 : 0,
      });
      throw error;
    }

    logger.info("ticket_relationships.migration_completed", {
      ...counts,
    });
  },
};
