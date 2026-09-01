import type Database from "better-sqlite3";
import { z } from "zod";
import { createLogger } from "@/lib/logging";
import { PersistenceError } from "@/lib/shared/errors";
import type {
  TicketStatusUpdate,
  TicketStatusUpdatePage,
  TicketStatusUpdateSummary,
} from "@/lib/tickets/schemas";
import {
  ticketStatusUpdatePageSchema,
  ticketStatusUpdateSchema,
  ticketStatusUpdateSummarySchema,
} from "@/lib/tickets/schemas";
import {
  encodeTicketKeysetCursor,
  ticketKeysetCursorSchema,
  type TicketKeysetCursor,
} from "@/lib/tickets/ticket-keyset-cursor";
import {
  TICKET_PAGE_MAX_LIMIT,
  TICKET_STATUS_UPDATE_RECENT_LIMIT,
} from "@/lib/tickets/disclosure-limits";

type Db = InstanceType<typeof Database>;

const logger = createLogger("state-store.ticket-status-updates");

const statusUpdateTableRowSchema = z
  .object({
    id: z.string(),
    ticket_id: z.string(),
    body_markdown: z.string(),
    author_json: z.string(),
    created_at: z.string(),
  })
  .strict();

const countRowSchema = z
  .object({ total: z.number().int().nonnegative() })
  .strict();

const pageQuerySchema = z
  .object({
    limit: z.number().int().min(1).max(TICKET_PAGE_MAX_LIMIT),
    cursor: ticketKeysetCursorSchema.optional(),
  })
  .strict();

export interface TicketStatusUpdatePageQuery {
  limit: number;
  cursor?: TicketKeysetCursor;
}

export interface TicketStatusUpdatesStore {
  /** Caller owns the surrounding immediate transaction and ticket revision. */
  append(update: TicketStatusUpdate): TicketStatusUpdate;
  getForTicket(ticketId: string, updateId: string): TicketStatusUpdate | null;
  listForTicket(
    ticketId: string,
    query: TicketStatusUpdatePageQuery,
  ): TicketStatusUpdatePage;
  getSummary(ticketId: string): TicketStatusUpdateSummary;
}

function logAndThrowValidationFailure(
  entity: string,
  identifier: string,
  issues: unknown,
): never {
  logger.error("state-store.ticket-status-updates.schema_validation_failure", {
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

function parseStatusUpdateRow(rawRow: unknown): TicketStatusUpdate {
  const parsedRow = statusUpdateTableRowSchema.safeParse(rawRow);
  if (!parsedRow.success) {
    return logAndThrowValidationFailure(
      "ticket_status_update",
      "<row>",
      parsedRow.error.issues,
    );
  }
  const row = parsedRow.data;

  let author: unknown;
  try {
    author = JSON.parse(row.author_json);
  } catch {
    return logAndThrowValidationFailure("ticket_status_update_author", row.id, {
      kind: "invalid_json",
    });
  }

  const parsedUpdate = ticketStatusUpdateSchema.safeParse({
    id: row.id,
    ticketId: row.ticket_id,
    bodyMarkdown: row.body_markdown,
    author,
    createdAt: row.created_at,
  });
  if (!parsedUpdate.success) {
    return logAndThrowValidationFailure(
      "ticket_status_update",
      row.id,
      parsedUpdate.error.issues,
    );
  }
  return parsedUpdate.data;
}

function parseCount(rawRow: unknown, ticketId: string): number {
  const parsed = countRowSchema.safeParse(rawRow);
  if (!parsed.success) {
    return logAndThrowValidationFailure(
      "ticket_status_update_count",
      ticketId,
      parsed.error.issues,
    );
  }
  return parsed.data.total;
}

export function createTicketStatusUpdatesStore(
  db: Db,
): TicketStatusUpdatesStore {
  const insertStmt = db.prepare(
    `INSERT INTO ticket_status_updates
       (id, ticket_id, body_markdown, author_json, created_at)
     VALUES
       (@id, @ticket_id, @body_markdown, @author_json, @created_at)`,
  );
  const findForTicketStmt = db.prepare(
    `SELECT id, ticket_id, body_markdown, author_json, created_at
     FROM ticket_status_updates
     WHERE ticket_id = ? AND id = ?
     LIMIT 1`,
  );
  const countForTicketStmt = db.prepare(
    `SELECT COUNT(*) AS total
     FROM ticket_status_updates
     WHERE ticket_id = ?`,
  );
  const recentForTicketStmt = db.prepare(
    `SELECT id, ticket_id, body_markdown, author_json, created_at
     FROM ticket_status_updates
     WHERE ticket_id = ?
     ORDER BY created_at DESC, id DESC
     LIMIT ?`,
  );
  const pageWithoutCursorStmt = db.prepare(
    `SELECT id, ticket_id, body_markdown, author_json, created_at
     FROM ticket_status_updates
     WHERE ticket_id = @ticket_id
     ORDER BY created_at DESC, id DESC
     LIMIT @row_limit`,
  );
  const pageAfterCursorStmt = db.prepare(
    `SELECT id, ticket_id, body_markdown, author_json, created_at
     FROM ticket_status_updates
     WHERE ticket_id = @ticket_id
       AND (
         created_at < @cursor_timestamp
         OR (created_at = @cursor_timestamp AND id < @cursor_id)
       )
     ORDER BY created_at DESC, id DESC
     LIMIT @row_limit`,
  );

  function getForTicket(
    ticketId: string,
    updateId: string,
  ): TicketStatusUpdate | null {
    const rawRow: unknown = findForTicketStmt.get(ticketId, updateId);
    return rawRow === undefined ? null : parseStatusUpdateRow(rawRow);
  }

  return {
    append(input) {
      const update = ticketStatusUpdateSchema.parse(input);
      insertStmt.run({
        id: update.id,
        ticket_id: update.ticketId,
        body_markdown: update.bodyMarkdown,
        author_json: JSON.stringify(update.author),
        created_at: update.createdAt,
      });
      const persisted = getForTicket(update.ticketId, update.id);
      if (persisted === null) {
        throw new PersistenceError({
          kind: "not_found",
          entity: "ticket_status_update",
          identifier: update.id,
        });
      }
      logger.info("state-store.ticket-status-updates.append", {
        ticketId: update.ticketId,
        updateId: update.id,
        authorKind: update.author.kind,
      });
      return persisted;
    },

    getForTicket,

    listForTicket(ticketId, inputQuery) {
      const query = pageQuerySchema.parse(inputQuery);
      const bind: Record<string, string | number> = {
        ticket_id: ticketId,
        row_limit: query.limit + 1,
      };
      let rawRows: unknown[];
      if (query.cursor === undefined) {
        rawRows = pageWithoutCursorStmt.all(bind) as unknown[];
      } else {
        bind.cursor_timestamp = query.cursor.timestamp;
        bind.cursor_id = query.cursor.id;
        rawRows = pageAfterCursorStmt.all(bind) as unknown[];
      }

      const hasMore = rawRows.length > query.limit;
      const items = rawRows.slice(0, query.limit).map(parseStatusUpdateRow);
      const last = items.at(-1);
      const nextCursor =
        hasMore && last !== undefined
          ? encodeTicketKeysetCursor({ timestamp: last.createdAt, id: last.id })
          : null;
      const total = parseCount(countForTicketStmt.get(ticketId), ticketId);
      const page = ticketStatusUpdatePageSchema.parse({
        items,
        total,
        nextCursor,
      });
      logger.debug("state-store.ticket-status-updates.list", {
        ticketId,
        total,
        returned: items.length,
        pageSize: query.limit,
        cursorPresent: query.cursor !== undefined,
      });
      return page;
    },

    getSummary(ticketId) {
      const total = parseCount(countForTicketStmt.get(ticketId), ticketId);
      const recent = (
        recentForTicketStmt.all(
          ticketId,
          TICKET_STATUS_UPDATE_RECENT_LIMIT,
        ) as unknown[]
      ).map(parseStatusUpdateRow);
      return ticketStatusUpdateSummarySchema.parse({ total, recent });
    },
  };
}
