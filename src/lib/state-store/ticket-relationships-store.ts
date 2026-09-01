import path from "node:path";
import type Database from "better-sqlite3";
import { z } from "zod";
import { createLogger } from "@/lib/logging";
import { PersistenceError } from "@/lib/shared/errors";
import { TICKET_PAGE_MAX_LIMIT } from "@/lib/tickets/disclosure-limits";
import { relationshipRoleForTicket } from "@/lib/tickets/relationship-semantics";
import {
  ticketRelationshipPageSchema,
  ticketRelationshipRoleSchema,
  ticketRelationshipDescriptionSchema,
  ticketRelationshipTypeSchema,
  ticketRelationshipViewSchema,
  ticketStatusSchema,
  type TicketRelationshipPage,
  type TicketRelationshipRole,
  type TicketRelationshipType,
  type TicketRelationshipView,
} from "@/lib/tickets/schemas";
import {
  encodeTicketKeysetCursor,
  ticketKeysetCursorSchema,
  type TicketKeysetCursor,
} from "@/lib/tickets/ticket-keyset-cursor";

type Db = InstanceType<typeof Database>;

const logger = createLogger("state-store.ticket-relationships");

const storedRelationshipInputSchema = z
  .object({
    id: z.string().min(1),
    relationType: ticketRelationshipTypeSchema,
    sourceTicketId: z.string().min(1),
    targetTicketId: z.string().min(1),
    description: ticketRelationshipDescriptionSchema,
    createdAt: z.string().min(1),
    updatedAt: z.string().min(1),
  })
  .strict();

const relationshipTableRowSchema = z
  .object({
    id: z.string(),
    relation_type: ticketRelationshipTypeSchema,
    source_ticket_id: z.string(),
    target_ticket_id: z.string(),
    description: z.string(),
    created_at: z.string(),
    updated_at: z.string(),
  })
  .strict();

const relationshipViewRowSchema = z
  .object({
    relationship_id: z.string(),
    relation_type: ticketRelationshipTypeSchema,
    source_ticket_id: z.string(),
    target_ticket_id: z.string(),
    relationship_description: z.string(),
    relationship_created_at: z.string(),
    relationship_updated_at: z.string(),
    other_ticket_id: z.string(),
    other_project_path: z.string(),
    other_ticket_number: z.number().int(),
    other_ticket_title: z.string(),
    other_ticket_status: ticketStatusSchema,
  })
  .strict();

const ticketEndpointRowSchema = z
  .object({ id: z.string(), project_path: z.string() })
  .strict();
const countRowSchema = z
  .object({ total: z.number().int().nonnegative() })
  .strict();
const neighborRowSchema = z.object({ neighbor_ticket_id: z.string() }).strict();

const pageQuerySchema = z
  .object({
    role: ticketRelationshipRoleSchema.optional(),
    limit: z.number().int().min(1).max(TICKET_PAGE_MAX_LIMIT),
    cursor: ticketKeysetCursorSchema.optional(),
  })
  .strict();

const updateDescriptionInputSchema = z
  .object({
    relationshipId: z.string().min(1),
    description: ticketRelationshipDescriptionSchema,
    updatedAt: z.string().min(1),
  })
  .strict();

const RELATIONSHIP_TABLE_COLUMNS = `
  id, relation_type, source_ticket_id, target_ticket_id, description,
  created_at, updated_at
`;

const RELATIONSHIP_VIEW_COLUMNS = `
  r.id AS relationship_id,
  r.relation_type AS relation_type,
  r.source_ticket_id AS source_ticket_id,
  r.target_ticket_id AS target_ticket_id,
  r.description AS relationship_description,
  r.created_at AS relationship_created_at,
  r.updated_at AS relationship_updated_at,
  other.id AS other_ticket_id,
  other.project_path AS other_project_path,
  other.ticket_number AS other_ticket_number,
  other.title AS other_ticket_title,
  other.status AS other_ticket_status
`;

const RELATIONSHIP_VIEW_JOIN = `
  JOIN tickets other
    ON other.id = CASE
      WHEN r.source_ticket_id = @ticket_id THEN r.target_ticket_id
      ELSE r.source_ticket_id
    END
`;

const ANCHOR_CONDITION = `
  (r.source_ticket_id = @ticket_id OR r.target_ticket_id = @ticket_id)
`;

const ROLE_ORDER_SQL = `
  CASE
    WHEN r.relation_type = 'parent_child' AND r.target_ticket_id = @ticket_id THEN 0
    WHEN r.relation_type = 'parent_child' AND r.source_ticket_id = @ticket_id THEN 1
    WHEN r.relation_type = 'depends_on' AND r.source_ticket_id = @ticket_id THEN 2
    WHEN r.relation_type = 'depends_on' AND r.target_ticket_id = @ticket_id THEN 3
    ELSE 4
  END
`;

export interface StoredTicketRelationship {
  id: string;
  relationType: TicketRelationshipType;
  sourceTicketId: string;
  targetTicketId: string;
  description: string;
  createdAt: string;
  updatedAt: string;
}

export type AddTicketRelationshipInput = StoredTicketRelationship;

export interface AddedTicketRelationship {
  relationship: StoredTicketRelationship;
  replacedParent: StoredTicketRelationship | null;
}

export interface TicketRelationshipPageQuery {
  role?: TicketRelationshipRole;
  limit: number;
  cursor?: TicketKeysetCursor;
}

export type TicketRelationshipStoreFailure =
  | { kind: "ticket_not_found"; ticketId: string }
  | {
      kind: "self_link";
      sourceTicketId: string;
      targetTicketId: string;
    }
  | {
      kind: "scope";
      sourceTicketId: string;
      targetTicketId: string;
    }
  | { kind: "duplicate"; relationshipId: string }
  | {
      kind: "cycle";
      relationType: "depends_on" | "parent_child";
      sourceTicketId: string;
      targetTicketId: string;
    };

export class TicketRelationshipStoreError extends Error {
  constructor(readonly failure: TicketRelationshipStoreFailure) {
    super(`TicketRelationshipStoreError(${failure.kind})`);
    this.name = "TicketRelationshipStoreError";
  }
}

function roleCondition(role: TicketRelationshipRole | undefined): string {
  if (role === undefined) return "";
  if (role === "related") return "AND r.relation_type = 'related'";
  if (role === "depends_on") {
    return "AND r.relation_type = 'depends_on' AND r.source_ticket_id = @ticket_id";
  }
  if (role === "blocks") {
    return "AND r.relation_type = 'depends_on' AND r.target_ticket_id = @ticket_id";
  }
  if (role === "parent") {
    return "AND r.relation_type = 'parent_child' AND r.target_ticket_id = @ticket_id";
  }
  return "AND r.relation_type = 'parent_child' AND r.source_ticket_id = @ticket_id";
}

function logAndThrowValidationFailure(
  entity: string,
  identifier: string,
  issues: unknown,
): never {
  logger.error("state-store.ticket-relationships.schema_validation_failure", {
    entity,
    identifier,
    issues,
  });
  throw new PersistenceError({
    kind: "validation",
    entity,
    identifier,
    issues,
  });
}

function parseRelationshipRow(rawRow: unknown): StoredTicketRelationship {
  const parsedRow = relationshipTableRowSchema.safeParse(rawRow);
  if (!parsedRow.success) {
    return logAndThrowValidationFailure(
      "ticket_relationship",
      "<row>",
      parsedRow.error.issues,
    );
  }
  const row = parsedRow.data;
  const parsedRelationship = storedRelationshipInputSchema.safeParse({
    id: row.id,
    relationType: row.relation_type,
    sourceTicketId: row.source_ticket_id,
    targetTicketId: row.target_ticket_id,
    description: row.description,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
  if (!parsedRelationship.success) {
    return logAndThrowValidationFailure(
      "ticket_relationship",
      row.id,
      parsedRelationship.error.issues,
    );
  }
  return parsedRelationship.data;
}

function parseRelationshipViewRow(
  rawRow: unknown,
  ticketId: string,
): TicketRelationshipView {
  const parsedRow = relationshipViewRowSchema.safeParse(rawRow);
  if (!parsedRow.success) {
    return logAndThrowValidationFailure(
      "ticket_relationship_view",
      "<row>",
      parsedRow.error.issues,
    );
  }
  const row = parsedRow.data;
  const role = relationshipRoleForTicket(
    {
      relationType: row.relation_type,
      sourceTicketId: row.source_ticket_id,
      targetTicketId: row.target_ticket_id,
    },
    ticketId,
  );
  if (role === null) {
    return logAndThrowValidationFailure(
      "ticket_relationship_view",
      row.relationship_id,
      "relationship does not touch its requested anchor",
    );
  }

  const parsedView = ticketRelationshipViewSchema.safeParse({
    id: row.relationship_id,
    role,
    otherTicket: {
      id: row.other_ticket_id,
      projectName: path.basename(row.other_project_path),
      number: row.other_ticket_number,
      title: row.other_ticket_title,
      status: row.other_ticket_status,
    },
    description: row.relationship_description,
    createdAt: row.relationship_created_at,
    updatedAt: row.relationship_updated_at,
  });
  if (!parsedView.success) {
    return logAndThrowValidationFailure(
      "ticket_relationship_view",
      row.relationship_id,
      parsedView.error.issues,
    );
  }
  return parsedView.data;
}

function parseCount(rawRow: unknown, ticketId: string): number {
  const parsed = countRowSchema.safeParse(rawRow);
  if (!parsed.success) {
    return logAndThrowValidationFailure(
      "ticket_relationship_count",
      ticketId,
      parsed.error.issues,
    );
  }
  return parsed.data.total;
}

function refuse(failure: TicketRelationshipStoreFailure): never {
  logger.warn("state-store.ticket-relationships.rejected", failure);
  throw new TicketRelationshipStoreError(failure);
}

function isSqliteConstraint(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return false;
  }
  return String(error.code).startsWith("SQLITE_CONSTRAINT");
}

function parseNeighborRows(rawRows: unknown[], identifier: string): string[] {
  return rawRows.map((rawRow) => {
    const parsed = neighborRowSchema.safeParse(rawRow);
    if (!parsed.success) {
      return logAndThrowValidationFailure(
        "ticket_relationship_neighbor",
        identifier,
        parsed.error.issues,
      );
    }
    return parsed.data.neighbor_ticket_id;
  });
}

export interface TicketRelationshipsStore {
  /** Caller owns the surrounding immediate transaction. */
  add(input: AddTicketRelationshipInput): AddedTicketRelationship;
  /** Caller verifies anchor ownership and owns the write transaction. */
  updateDescription(
    relationshipId: string,
    description: string,
    updatedAt: string,
  ): StoredTicketRelationship | null;
  /** Caller verifies anchor ownership and owns the write transaction. */
  remove(relationshipId: string): StoredTicketRelationship | null;
  getForTicket(
    ticketId: string,
    relationshipId: string,
  ): TicketRelationshipView | null;
  resolveLegacyAliasForTicket(
    ticketId: string,
    legacyAttachmentId: string,
  ): TicketRelationshipView | null;
  listForTicket(
    ticketId: string,
    query: TicketRelationshipPageQuery,
  ): TicketRelationshipPage;
  listAllForTicket(ticketId: string): TicketRelationshipView[];
  listNeighborTicketIds(ticketId: string): string[];
  listExternalNeighborTicketIds(projectPath: string): string[];
}

export function createTicketRelationshipsStore(
  db: Db,
): TicketRelationshipsStore {
  const findStoredByIdStmt = db.prepare(
    `SELECT ${RELATIONSHIP_TABLE_COLUMNS}
     FROM ticket_relationships
     WHERE id = ?
     LIMIT 1`,
  );
  const findDuplicateStmt = db.prepare(
    `SELECT ${RELATIONSHIP_TABLE_COLUMNS}
     FROM ticket_relationships
     WHERE relation_type = @relation_type
       AND source_ticket_id = @source_ticket_id
       AND target_ticket_id = @target_ticket_id
     LIMIT 1`,
  );
  const findParentForChildStmt = db.prepare(
    `SELECT ${RELATIONSHIP_TABLE_COLUMNS}
     FROM ticket_relationships
     WHERE relation_type = 'parent_child' AND target_ticket_id = ?
     LIMIT 1`,
  );
  const findTicketEndpointStmt = db.prepare(
    `SELECT id, project_path FROM tickets WHERE id = ? LIMIT 1`,
  );
  const findCycleStmt = db.prepare(
    `WITH RECURSIVE reachable(ticket_id) AS (
       SELECT target_ticket_id
       FROM ticket_relationships
       WHERE relation_type = @relation_type
         AND source_ticket_id = @start_ticket_id
       UNION
       SELECT relationship.target_ticket_id
       FROM ticket_relationships relationship
       JOIN reachable
         ON relationship.source_ticket_id = reachable.ticket_id
       WHERE relationship.relation_type = @relation_type
     )
     SELECT 1 AS found
     FROM reachable
     WHERE ticket_id = @goal_ticket_id
     LIMIT 1`,
  );
  const insertRelationshipStmt = db.prepare(
    `INSERT INTO ticket_relationships
       (id, relation_type, source_ticket_id, target_ticket_id, description,
        created_at, updated_at)
     VALUES
       (@id, @relation_type, @source_ticket_id, @target_ticket_id, @description,
        @created_at, @updated_at)`,
  );
  const deleteRelationshipStmt = db.prepare(
    "DELETE FROM ticket_relationships WHERE id = ?",
  );
  const updateDescriptionStmt = db.prepare(
    `UPDATE ticket_relationships
     SET description = @description, updated_at = @updated_at
     WHERE id = @relationship_id`,
  );
  const getForTicketStmt = db.prepare(
    `SELECT ${RELATIONSHIP_VIEW_COLUMNS}
     FROM ticket_relationships r
     ${RELATIONSHIP_VIEW_JOIN}
     WHERE r.id = @relationship_id AND ${ANCHOR_CONDITION}
     LIMIT 1`,
  );
  const resolveLegacyAliasStmt = db.prepare(
    `SELECT ${RELATIONSHIP_VIEW_COLUMNS}
     FROM ticket_relationship_legacy_aliases alias
     JOIN ticket_relationships r ON r.id = alias.relationship_id
     ${RELATIONSHIP_VIEW_JOIN}
     WHERE alias.anchor_ticket_id = @ticket_id
       AND alias.legacy_attachment_id = @legacy_attachment_id
       AND ${ANCHOR_CONDITION}
     LIMIT 1`,
  );
  const listAllForTicketStmt = db.prepare(
    `SELECT ${RELATIONSHIP_VIEW_COLUMNS}
     FROM ticket_relationships r
     ${RELATIONSHIP_VIEW_JOIN}
     WHERE ${ANCHOR_CONDITION}
     ORDER BY ${ROLE_ORDER_SQL} ASC, r.updated_at DESC, r.id DESC`,
  );
  const listNeighborTicketIdsStmt = db.prepare(
    `SELECT DISTINCT
       CASE
         WHEN source_ticket_id = ? THEN target_ticket_id
         ELSE source_ticket_id
       END AS neighbor_ticket_id
     FROM ticket_relationships
     WHERE source_ticket_id = ? OR target_ticket_id = ?
     ORDER BY neighbor_ticket_id ASC`,
  );
  const listExternalNeighborTicketIdsStmt = db.prepare(
    `SELECT DISTINCT
       CASE
         WHEN source_ticket.project_path = @project_path
           THEN r.target_ticket_id
         ELSE r.source_ticket_id
       END AS neighbor_ticket_id
     FROM ticket_relationships r
     JOIN tickets source_ticket ON source_ticket.id = r.source_ticket_id
     JOIN tickets target_ticket ON target_ticket.id = r.target_ticket_id
     WHERE
       (source_ticket.project_path = @project_path
        AND target_ticket.project_path <> @project_path)
       OR
       (target_ticket.project_path = @project_path
        AND source_ticket.project_path <> @project_path)
     ORDER BY neighbor_ticket_id ASC`,
  );

  function findStoredById(
    relationshipId: string,
  ): StoredTicketRelationship | null {
    const rawRow: unknown = findStoredByIdStmt.get(relationshipId);
    return rawRow === undefined ? null : parseRelationshipRow(rawRow);
  }

  function findDuplicate(
    input: AddTicketRelationshipInput,
  ): StoredTicketRelationship | null {
    const rawRow: unknown = findDuplicateStmt.get({
      relation_type: input.relationType,
      source_ticket_id: input.sourceTicketId,
      target_ticket_id: input.targetTicketId,
    });
    return rawRow === undefined ? null : parseRelationshipRow(rawRow);
  }

  function ticketEndpoint(ticketId: string) {
    const rawRow: unknown = findTicketEndpointStmt.get(ticketId);
    if (rawRow === undefined) {
      return refuse({ kind: "ticket_not_found", ticketId });
    }
    const parsed = ticketEndpointRowSchema.safeParse(rawRow);
    if (!parsed.success) {
      return logAndThrowValidationFailure(
        "ticket_relationship_endpoint",
        ticketId,
        parsed.error.issues,
      );
    }
    return parsed.data;
  }

  function assertAddInvariants(input: AddTicketRelationshipInput): void {
    if (input.sourceTicketId === input.targetTicketId) {
      refuse({
        kind: "self_link",
        sourceTicketId: input.sourceTicketId,
        targetTicketId: input.targetTicketId,
      });
    }

    const source = ticketEndpoint(input.sourceTicketId);
    const target = ticketEndpoint(input.targetTicketId);
    if (
      input.relationType === "parent_child" &&
      source.project_path !== target.project_path
    ) {
      refuse({
        kind: "scope",
        sourceTicketId: input.sourceTicketId,
        targetTicketId: input.targetTicketId,
      });
    }
    if (
      input.relationType === "related" &&
      input.sourceTicketId >= input.targetTicketId
    ) {
      logAndThrowValidationFailure(
        "ticket_relationship",
        input.id,
        "related relationship endpoints must be in lexical order",
      );
    }

    const duplicate = findDuplicate(input);
    if (duplicate !== null) {
      refuse({ kind: "duplicate", relationshipId: duplicate.id });
    }
    if (input.relationType === "related") return;

    const cycle: unknown = findCycleStmt.get({
      relation_type: input.relationType,
      start_ticket_id: input.targetTicketId,
      goal_ticket_id: input.sourceTicketId,
    });
    if (cycle !== undefined) {
      refuse({
        kind: "cycle",
        relationType: input.relationType,
        sourceTicketId: input.sourceTicketId,
        targetTicketId: input.targetTicketId,
      });
    }
  }

  function getForTicket(
    ticketId: string,
    relationshipId: string,
  ): TicketRelationshipView | null {
    const rawRow: unknown = getForTicketStmt.get({
      ticket_id: ticketId,
      relationship_id: relationshipId,
    });
    return rawRow === undefined
      ? null
      : parseRelationshipViewRow(rawRow, ticketId);
  }

  return {
    add(rawInput) {
      const input = storedRelationshipInputSchema.parse(rawInput);
      assertAddInvariants(input);

      let replacedParent: StoredTicketRelationship | null = null;
      if (input.relationType === "parent_child") {
        const rawParent: unknown = findParentForChildStmt.get(
          input.targetTicketId,
        );
        if (rawParent !== undefined) {
          replacedParent = parseRelationshipRow(rawParent);
          deleteRelationshipStmt.run(replacedParent.id);
        }
      }

      try {
        insertRelationshipStmt.run({
          id: input.id,
          relation_type: input.relationType,
          source_ticket_id: input.sourceTicketId,
          target_ticket_id: input.targetTicketId,
          description: input.description,
          created_at: input.createdAt,
          updated_at: input.updatedAt,
        });
      } catch (error) {
        if (!isSqliteConstraint(error)) throw error;
        const duplicate = findDuplicate(input);
        if (duplicate !== null) {
          return refuse({ kind: "duplicate", relationshipId: duplicate.id });
        }
        const idCollision = findStoredById(input.id);
        if (idCollision !== null) {
          return refuse({ kind: "duplicate", relationshipId: idCollision.id });
        }
        throw new PersistenceError({
          kind: "constraint",
          constraint: "ticket_relationships",
          entity: "ticket_relationship",
          identifier: input.id,
        });
      }

      const persisted = findStoredById(input.id);
      if (persisted === null) {
        throw new PersistenceError({
          kind: "not_found",
          entity: "ticket_relationship",
          identifier: input.id,
        });
      }
      logger.info(
        replacedParent === null
          ? "state-store.ticket-relationships.add"
          : "state-store.ticket-relationships.reparent",
        {
          relationshipId: persisted.id,
          relationType: persisted.relationType,
          sourceTicketId: persisted.sourceTicketId,
          targetTicketId: persisted.targetTicketId,
          replacedRelationshipId: replacedParent?.id,
        },
      );
      return { relationship: persisted, replacedParent };
    },

    updateDescription(relationshipId, description, updatedAt) {
      const input = updateDescriptionInputSchema.parse({
        relationshipId,
        description,
        updatedAt,
      });
      const result = updateDescriptionStmt.run({
        relationship_id: input.relationshipId,
        description: input.description,
        updated_at: input.updatedAt,
      });
      if (result.changes === 0) return null;
      const relationship = findStoredById(input.relationshipId);
      if (relationship === null) {
        throw new PersistenceError({
          kind: "not_found",
          entity: "ticket_relationship",
          identifier: input.relationshipId,
        });
      }
      logger.info("state-store.ticket-relationships.update", {
        relationshipId: relationship.id,
        sourceTicketId: relationship.sourceTicketId,
        targetTicketId: relationship.targetTicketId,
      });
      return relationship;
    },

    remove(relationshipId) {
      const relationship = findStoredById(relationshipId);
      if (relationship === null) return null;
      deleteRelationshipStmt.run(relationshipId);
      logger.info("state-store.ticket-relationships.remove", {
        relationshipId: relationship.id,
        relationType: relationship.relationType,
        sourceTicketId: relationship.sourceTicketId,
        targetTicketId: relationship.targetTicketId,
      });
      return relationship;
    },

    getForTicket,

    resolveLegacyAliasForTicket(ticketId, legacyAttachmentId) {
      const rawRow: unknown = resolveLegacyAliasStmt.get({
        ticket_id: ticketId,
        legacy_attachment_id: legacyAttachmentId,
      });
      return rawRow === undefined
        ? null
        : parseRelationshipViewRow(rawRow, ticketId);
    },

    listForTicket(ticketId, rawQuery) {
      const query = pageQuerySchema.parse(rawQuery);
      const roleClause = roleCondition(query.role);
      const cursorClause =
        query.cursor === undefined
          ? ""
          : `AND (
               r.updated_at < @cursor_timestamp
               OR (r.updated_at = @cursor_timestamp AND r.id < @cursor_id)
             )`;
      const bind: Record<string, string | number> = {
        ticket_id: ticketId,
        row_limit: query.limit + 1,
      };
      if (query.cursor !== undefined) {
        bind.cursor_timestamp = query.cursor.timestamp;
        bind.cursor_id = query.cursor.id;
      }
      const rawRows = db
        .prepare(
          `SELECT ${RELATIONSHIP_VIEW_COLUMNS}
           FROM ticket_relationships r
           ${RELATIONSHIP_VIEW_JOIN}
           WHERE ${ANCHOR_CONDITION}
             ${roleClause}
             ${cursorClause}
           ORDER BY r.updated_at DESC, r.id DESC
           LIMIT @row_limit`,
        )
        .all(bind) as unknown[];
      const rawCount: unknown = db
        .prepare(
          `SELECT COUNT(*) AS total
           FROM ticket_relationships r
           WHERE ${ANCHOR_CONDITION}
             ${roleClause}`,
        )
        .get({ ticket_id: ticketId });

      const hasMore = rawRows.length > query.limit;
      const items = rawRows
        .slice(0, query.limit)
        .map((rawRow) => parseRelationshipViewRow(rawRow, ticketId));
      const last = items.at(-1);
      const nextCursor =
        hasMore && last !== undefined
          ? encodeTicketKeysetCursor({ timestamp: last.updatedAt, id: last.id })
          : null;
      const total = parseCount(rawCount, ticketId);
      const page = ticketRelationshipPageSchema.parse({
        items,
        total,
        nextCursor,
      });
      logger.debug("state-store.ticket-relationships.list", {
        ticketId,
        role: query.role,
        total,
        returned: items.length,
        pageSize: query.limit,
        cursorPresent: query.cursor !== undefined,
      });
      return page;
    },

    listAllForTicket(ticketId) {
      return (
        listAllForTicketStmt.all({ ticket_id: ticketId }) as unknown[]
      ).map((rawRow) => parseRelationshipViewRow(rawRow, ticketId));
    },

    listNeighborTicketIds(ticketId) {
      return parseNeighborRows(
        listNeighborTicketIdsStmt.all(
          ticketId,
          ticketId,
          ticketId,
        ) as unknown[],
        ticketId,
      );
    },

    listExternalNeighborTicketIds(projectPath) {
      return parseNeighborRows(
        listExternalNeighborTicketIdsStmt.all({
          project_path: projectPath,
        }) as unknown[],
        projectPath,
      );
    },
  };
}
