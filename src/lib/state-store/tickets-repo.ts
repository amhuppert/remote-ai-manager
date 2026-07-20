import path from "node:path";
import type Database from "better-sqlite3";
import { z } from "zod";
import { createLogger } from "@/lib/logging";
import {
  conversationAttachmentPayloadSchema,
  effectiveSnapshotStatus,
  ticketAttachmentPayloadSchema,
  ticketAttachmentSchema,
  ticketSchema,
  ticketSessionEndReasonSchema,
  ticketSessionLinkSchema,
  ticketSessionStartModeSchema,
  updateTicketFieldsSchema,
  type DeletedTicket,
  type Ticket,
  type TicketAttachment,
  type TicketDetail,
  type TicketLinkSummary,
  type TicketListItem,
  type TicketListQuery,
  type TicketSessionLink,
} from "@/lib/tickets/schemas";
import { PersistenceError } from "../shared/errors";
import { parseTrusted, registerTrustedSchema } from "../shared/parse-trusted";
import type { WriteQueue } from "./write-queue";

type Db = InstanceType<typeof Database>;

const logger = createLogger("state-store.tickets");

/**
 * Repo-level write inputs. The ticket number is allocated inside the repo's
 * immediate transaction, so it is never part of a create input. Mutation
 * timestamps are caller-requested; the repo advances them when needed so each
 * ticket revision remains strictly monotonic.
 */
export const persistTicketInputSchema = ticketSchema.omit({ number: true });
export type PersistTicketInput = z.infer<typeof persistTicketInputSchema>;

export const updateTicketInputSchema = updateTicketFieldsSchema.extend({
  projectPath: z.string().min(1),
  number: z.number().int().positive(),
  updatedAt: z.string().min(1),
});
export type UpdateTicketInput = z.infer<typeof updateTicketInputSchema>;

export const attachmentIdentitySchema = z.object({
  ticketId: z.string().min(1),
  attachmentId: z.string().min(1),
});
export type AttachmentIdentity = z.infer<typeof attachmentIdentitySchema>;

export const deleteAttachmentInputSchema = attachmentIdentitySchema.extend({
  updatedAt: z.string().min(1),
});
export type DeleteAttachmentInput = z.infer<typeof deleteAttachmentInputSchema>;

export const updateAttachmentInputSchema = z.object({
  ticketId: z.string().min(1),
  attachmentId: z.string().min(1),
  description: ticketAttachmentSchema.shape.description.optional(),
  payload: ticketAttachmentPayloadSchema.optional(),
  updatedAt: z.string().min(1),
});
export type UpdateAttachmentInput = z.infer<typeof updateAttachmentInputSchema>;

export const endSessionLinkInputSchema = z.object({
  linkId: z.string().min(1),
  endedAt: z.string().min(1),
  endReason: ticketSessionEndReasonSchema,
});
export type EndSessionLinkInput = z.infer<typeof endSessionLinkInputSchema>;

const conversationSnapshotUpdateSchema = z.object({
  attachmentId: z.string().min(1),
  previousPayload: conversationAttachmentPayloadSchema,
  payload: conversationAttachmentPayloadSchema,
  updatedAt: z.string().min(1),
});
export type ConversationSnapshotUpdate = z.infer<
  typeof conversationSnapshotUpdateSchema
>;

export const compareAndSwapConversationSnapshotInputSchema =
  conversationSnapshotUpdateSchema.extend({
    ticketId: z.string().min(1),
  });
export type CompareAndSwapConversationSnapshotInput = z.infer<
  typeof compareAndSwapConversationSnapshotInputSchema
>;

export type CompareAndSwapConversationSnapshotResult =
  | {
      status: "won";
      attachment: TicketAttachment;
      ticketUpdatedAt: string;
    }
  | { status: "lost"; currentPayload: TicketAttachment["payload"] }
  | { status: "missing" };

export const recoverPendingConversationSnapshotsInputSchema = z.object({
  updatedAt: z.string().min(1),
  snapshotError: z.string().min(1).max(500),
});
export type RecoverPendingConversationSnapshotsInput = z.infer<
  typeof recoverPendingConversationSnapshotsInputSchema
>;

export interface RecoveredConversationSnapshot {
  ticketId: string;
  attachmentId: string;
  projectPath: string;
  ticketNumber: number;
  ticketUpdatedAt: string;
}

export type ConversationSnapshotSwapFailure = Exclude<
  CompareAndSwapConversationSnapshotResult,
  { status: "won" }
>;

export const linkStartedSessionInputSchema = z.object({
  id: z.string().min(1),
  projectPath: z.string().min(1),
  number: z.number().int().positive(),
  sessionName: z.string().min(1),
  /** Incarnation returned by provisioning; matched inside the link transaction. */
  sessionCreatedAt: z.string().min(1),
  startMode: ticketSessionStartModeSchema,
  linkedAt: z.string().min(1),
  /** Stale-link demotions committed with the new link, never before it. */
  staleLinkDemotions: z.array(endSessionLinkInputSchema).optional(),
  /** Refreshed compaction payloads adopted with the successful start. */
  conversationSnapshotUpdates: z
    .array(conversationSnapshotUpdateSchema)
    .optional(),
});
export type LinkStartedSessionInput = z.input<
  typeof linkStartedSessionInputSchema
>;

export interface DeletedAttachmentResult {
  attachment: TicketAttachment;
  ticketUpdatedAt: string;
}

export type TicketSessionNotLinkableReason =
  | "deleted"
  | "finished"
  | "replaced";

export class TicketSessionNotLinkableError extends Error {
  constructor(
    readonly projectPath: string,
    readonly sessionName: string,
    readonly reason: TicketSessionNotLinkableReason,
  ) {
    super(
      `ticket session ${projectPath}/${sessionName} was ${reason} before linking`,
    );
    this.name = "TicketSessionNotLinkableError";
  }
}

export class ConversationSnapshotSwapError extends Error {
  constructor(
    readonly attachmentId: string,
    readonly result: ConversationSnapshotSwapFailure,
  ) {
    super(
      `conversation snapshot compare-and-swap ${result.status} for attachment ${attachmentId}`,
    );
    this.name = "ConversationSnapshotSwapError";
  }
}

/** Focused per-turn ticket view; session history is intentionally excluded. */
export type LinkedTicketContext = Omit<TicketDetail, "sessions">;

export interface TicketsRepo {
  create(input: PersistTicketInput): Promise<Ticket>;
  createWithAttachments(
    input: PersistTicketInput,
    attachments: TicketAttachment[],
  ): Promise<TicketDetail>;
  list(query: TicketListQuery): Promise<TicketListItem[]>;
  findListItem(
    projectPath: string,
    number: number,
  ): Promise<TicketListItem | null>;
  find(projectPath: string, number: number): Promise<TicketDetail | null>;
  findById(ticketId: string): Promise<TicketDetail | null>;
  /** Ticket ids for a project — feeds ticket-content blob cleanup. */
  listTicketIds(projectPath: string): Promise<string[]>;
  update(input: UpdateTicketInput): Promise<TicketDetail | null>;
  delete(projectPath: string, number: number): Promise<DeletedTicket | null>;
  addAttachment(input: TicketAttachment): Promise<TicketAttachment>;
  updateAttachment(
    input: UpdateAttachmentInput,
  ): Promise<TicketAttachment | null>;
  compareAndSwapConversationSnapshot(
    input: CompareAndSwapConversationSnapshotInput,
  ): Promise<CompareAndSwapConversationSnapshotResult>;
  /** Marks process-orphaned pending snapshots failed during startup. */
  recoverPendingConversationSnapshots(
    input: RecoverPendingConversationSnapshotsInput,
  ): Promise<RecoveredConversationSnapshot[]>;
  deleteAttachment(
    identity: DeleteAttachmentInput,
  ): Promise<DeletedAttachmentResult | null>;
  linkStartedSession(input: LinkStartedSessionInput): Promise<TicketDetail>;
  endSessionLink(input: EndSessionLinkInput): Promise<TicketSessionLink | null>;
  /**
   * The un-ended link row for a (project, session name) regardless of session
   * liveness — the start flow's reconciliation input when an insert collides
   * with a stale active link on a reused name.
   */
  findOpenSessionLink(
    projectPath: string,
    sessionName: string,
  ): Promise<TicketSessionLink | null>;
  findLinkedTicket(
    projectPath: string,
    sessionName: string,
  ): Promise<LinkedTicketContext | null>;
  listSessionLinks(
    projectPath: string,
  ): Promise<Record<string, TicketLinkSummary>>;
}

const ticketsTableRowSchema = registerTrustedSchema(
  z.object({
    id: z.string(),
    project_path: z.string(),
    ticket_number: z.number().int(),
    title: z.string(),
    description: z.string(),
    work_type: z.string(),
    status: z.string(),
    created_at: z.string(),
    updated_at: z.string(),
  }),
  "ticketsTableRowSchema",
);

const ticketAttachmentsTableRowSchema = registerTrustedSchema(
  z.object({
    id: z.string(),
    ticket_id: z.string(),
    description: z.string(),
    payload_json: z.string(),
    created_at: z.string(),
    updated_at: z.string(),
  }),
  "ticketAttachmentsTableRowSchema",
);

const ticketSessionsTableRowSchema = registerTrustedSchema(
  z.object({
    id: z.string(),
    ticket_id: z.string(),
    project_path: z.string(),
    session_name: z.string(),
    session_created_at: z.string().nullable(),
    start_mode: z.string(),
    linked_at: z.string(),
    ended_at: z.string().nullable(),
    end_reason: z.string().nullable(),
  }),
  "ticketSessionsTableRowSchema",
);

/** Display name for a project path, mirroring project discovery's naming. */
export function projectNameFromPath(projectPath: string): string {
  return path.basename(projectPath);
}

function logAndThrowValidationFailure(
  entity: string,
  identifier: string,
  issues: unknown,
): never {
  logger.error("state-store.tickets.schema_validation_failure", {
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

function rowToTicket(rawRow: unknown): Ticket {
  const row = parseTrusted(ticketsTableRowSchema, rawRow, (issues) =>
    logAndThrowValidationFailure("ticket", "<row>", issues),
  );
  return parseTrusted(
    ticketSchema,
    {
      id: row.id,
      projectPath: row.project_path,
      number: row.ticket_number,
      title: row.title,
      description: row.description,
      workType: row.work_type,
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    },
    (issues) => logAndThrowValidationFailure("ticket", row.id, issues),
  );
}

function rowToAttachment(rawRow: unknown): TicketAttachment {
  const row = parseTrusted(ticketAttachmentsTableRowSchema, rawRow, (issues) =>
    logAndThrowValidationFailure("ticket_attachment", "<row>", issues),
  );
  let payload: unknown;
  try {
    payload = JSON.parse(row.payload_json);
  } catch (cause) {
    logAndThrowValidationFailure("ticket_attachment", row.id, cause);
  }
  return parseTrusted(
    ticketAttachmentSchema,
    {
      id: row.id,
      ticketId: row.ticket_id,
      description: row.description,
      payload,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    },
    (issues) =>
      logAndThrowValidationFailure("ticket_attachment", row.id, issues),
  );
}

function rowToSessionLink(rawRow: unknown) {
  const row = parseTrusted(ticketSessionsTableRowSchema, rawRow, (issues) =>
    logAndThrowValidationFailure("ticket_session", "<row>", issues),
  );
  return parseTrusted(
    ticketSessionLinkSchema,
    {
      id: row.id,
      ticketId: row.ticket_id,
      projectPath: row.project_path,
      sessionName: row.session_name,
      sessionCreatedAt: row.session_created_at,
      startMode: row.start_mode,
      linkedAt: row.linked_at,
      endedAt: row.ended_at,
      endReason: row.end_reason,
    },
    (issues) => logAndThrowValidationFailure("ticket_session", row.id, issues),
  );
}

function timed<T>(
  op: string,
  identifier: Record<string, unknown>,
  fn: () => T,
): T {
  const start = performance.now();
  try {
    return fn();
  } finally {
    const durationMs = +(performance.now() - start).toFixed(3);
    logger.info(`state-store.tickets.${op}.timing`, {
      ...identifier,
      durationMs,
    });
  }
}

function timestampMillis(value: string, field: string): number {
  const millis = Date.parse(value);
  if (!Number.isFinite(millis)) {
    throw new PersistenceError({
      kind: "validation",
      entity: "ticket_timestamp",
      identifier: field,
      issues: `${field} must be an ISO-8601 timestamp`,
    });
  }
  return millis;
}

/** Every ticket mutation receives a revision strictly after its prior row. */
function nextTicketRevision(current: string, requested: string): string {
  const currentMillis = timestampMillis(current, "current");
  const requestedMillis = timestampMillis(requested, "requested");
  return new Date(Math.max(requestedMillis, currentMillis + 1)).toISOString();
}

function latestTimestamp(values: readonly string[]): string {
  let latest = values[0];
  if (latest === undefined) {
    throw new PersistenceError({
      kind: "validation",
      entity: "ticket_timestamp",
      identifier: "requested",
      issues: "at least one requested timestamp is required",
    });
  }
  let latestMillis = timestampMillis(latest, "requested");
  for (const value of values.slice(1)) {
    const millis = timestampMillis(value, "requested");
    if (millis > latestMillis) {
      latest = value;
      latestMillis = millis;
    }
  }
  return latest;
}

/**
 * The live-link subquery: the ticket's un-ended link joined against current
 * unfinished sessions with an exact persisted incarnation match, so logical
 * ticket revisions and reused session names cannot resurrect an old link.
 * Finished sessions are historical immediately, without waiting for
 * reconciliation to demote the link row. A legacy null token never matches.
 */
const ACTIVE_SESSION_SUBQUERY = `
  SELECT ts.session_name FROM ticket_sessions ts
  JOIN sessions s
    ON s.project_path = ts.project_path
   AND s.session_name = ts.session_name
   AND s.created_at = ts.session_created_at
   AND s.finished = 0
  WHERE ts.ticket_id = t.id AND ts.ended_at IS NULL
`;

const LIST_ORDER_BY: Record<TicketListQuery["sort"], string> = {
  updated: "t.updated_at DESC, t.id ASC",
  created: "t.created_at DESC, t.id ASC",
};

const LIST_ITEM_COLUMNS = `t.*,
  (SELECT COUNT(*) FROM ticket_attachments a WHERE a.ticket_id = t.id) AS attachment_count,
  (${ACTIVE_SESSION_SUBQUERY}) AS active_session_name`;

function rawRowToListItem(rawRow: unknown): TicketListItem {
  const ticket = rowToTicket(rawRow);
  const extras = rawRow as {
    attachment_count: number;
    active_session_name: string | null;
  };
  return {
    id: ticket.id,
    projectPath: ticket.projectPath,
    projectName: projectNameFromPath(ticket.projectPath),
    number: ticket.number,
    title: ticket.title,
    workType: ticket.workType,
    status: ticket.status,
    attachmentCount: extras.attachment_count,
    activeSessionName: extras.active_session_name,
    createdAt: ticket.createdAt,
    updatedAt: ticket.updatedAt,
  };
}

export function createTicketsRepo(db: Db, writeQueue: WriteQueue): TicketsRepo {
  const getCounterStmt = db.prepare(
    `INSERT INTO ticket_counters (project_path, last_number) VALUES (?, 1)
     ON CONFLICT(project_path) DO UPDATE SET last_number = last_number + 1
     RETURNING last_number`,
  );
  // Discovered projects are persisted lazily (the sessions aggregate does the
  // same via the state mutation layer); without this, the tickets FK rejects
  // the first ticket of a project that has never been written.
  const ensureProjectStmt = db.prepare(
    `INSERT INTO projects (root_path) VALUES (?)
     ON CONFLICT(root_path) DO NOTHING`,
  );
  const insertTicketStmt = db.prepare(
    `INSERT INTO tickets
       (id, project_path, ticket_number, title, description, work_type, status, created_at, updated_at)
     VALUES
       (@id, @project_path, @ticket_number, @title, @description, @work_type, @status, @created_at, @updated_at)`,
  );
  const findTicketStmt = db.prepare(
    `SELECT * FROM tickets WHERE project_path = ? AND ticket_number = ? LIMIT 1`,
  );
  const deleteTicketStmt = db.prepare(
    `DELETE FROM tickets WHERE project_path = ? AND ticket_number = ?`,
  );
  const attachmentsByTicketStmt = db.prepare(
    `SELECT * FROM ticket_attachments WHERE ticket_id = ?
     ORDER BY created_at ASC, id ASC`,
  );
  const sessionsByTicketStmt = db.prepare(
    `SELECT * FROM ticket_sessions WHERE ticket_id = ?
     ORDER BY linked_at ASC, id ASC`,
  );
  const insertAttachmentStmt = db.prepare(
    `INSERT INTO ticket_attachments
       (id, ticket_id, description, payload_json, created_at, updated_at)
     VALUES
       (@id, @ticket_id, @description, @payload_json, @created_at, @updated_at)`,
  );
  const findAttachmentStmt = db.prepare(
    `SELECT * FROM ticket_attachments WHERE id = ? AND ticket_id = ? LIMIT 1`,
  );
  const allAttachmentsWithTicketIdentityStmt = db.prepare(
    `SELECT a.*, t.project_path AS ticket_project_path,
            t.ticket_number AS ticket_number
     FROM ticket_attachments a
     JOIN tickets t ON t.id = a.ticket_id
     ORDER BY a.created_at ASC, a.id ASC`,
  );
  const compareAndSwapConversationSnapshotStmt = db.prepare(
    `UPDATE ticket_attachments
     SET payload_json = @payload_json, updated_at = @updated_at
     WHERE id = @attachment_id
       AND ticket_id = @ticket_id
       AND payload_json = @previous_payload_json`,
  );
  const deleteAttachmentStmt = db.prepare(
    `DELETE FROM ticket_attachments WHERE id = ? AND ticket_id = ?`,
  );
  const setTicketUpdatedAtStmt = db.prepare(
    `UPDATE tickets SET updated_at = ? WHERE id = ?`,
  );
  const insertLinkStmt = db.prepare(
    `INSERT INTO ticket_sessions
       (id, ticket_id, project_path, session_name, session_created_at,
        start_mode, linked_at, ended_at, end_reason)
     VALUES (@id, @ticket_id, @project_path, @session_name, @session_created_at,
             @start_mode, @linked_at, NULL, NULL)`,
  );
  const setTicketStartedStmt = db.prepare(
    `UPDATE tickets SET status = 'in_progress', updated_at = ? WHERE id = ?`,
  );
  const endLinkStmt = db.prepare(
    `UPDATE ticket_sessions SET ended_at = @ended_at, end_reason = @end_reason
     WHERE id = @id AND ended_at IS NULL`,
  );
  const findLinkByIdStmt = db.prepare(
    `SELECT * FROM ticket_sessions WHERE id = ? LIMIT 1`,
  );
  const findTicketByIdStmt = db.prepare(
    `SELECT * FROM tickets WHERE id = ? LIMIT 1`,
  );
  const findSessionForLinkStmt = db.prepare(
    `SELECT created_at, finished FROM sessions
     WHERE project_path = ? AND session_name = ?
     LIMIT 1`,
  );
  const ticketIdsByProjectStmt = db
    .prepare(`SELECT id FROM tickets WHERE project_path = ?`)
    .pluck();
  const findOpenLinkByNameStmt = db.prepare(
    `SELECT * FROM ticket_sessions
     WHERE project_path = ? AND session_name = ? AND ended_at IS NULL
     LIMIT 1`,
  );
  const findActiveGuardedLinkStmt = db.prepare(
    `SELECT ts.* FROM ticket_sessions ts
     JOIN sessions s
       ON s.project_path = ts.project_path
      AND s.session_name = ts.session_name
      AND s.created_at = ts.session_created_at
      AND s.finished = 0
     WHERE ts.project_path = ? AND ts.session_name = ? AND ts.ended_at IS NULL
     LIMIT 1`,
  );
  const guardedLinksByProjectStmt = db.prepare(
    `SELECT ts.id AS link_id, ts.session_name, ts.linked_at, ts.ended_at,
            s.finished AS session_finished,
            t.id AS ticket_id, t.project_path AS ticket_project_path,
            t.ticket_number, t.title
     FROM ticket_sessions ts
     JOIN sessions s
       ON s.project_path = ts.project_path
      AND s.session_name = ts.session_name
      AND s.created_at = ts.session_created_at
     JOIN tickets t ON t.id = ts.ticket_id
     WHERE ts.project_path = ?
     ORDER BY (ts.ended_at IS NULL AND s.finished = 0) DESC, ts.linked_at DESC, ts.id ASC`,
  );
  const findListItemStmt = db.prepare(
    `SELECT ${LIST_ITEM_COLUMNS}
     FROM tickets t
     WHERE t.project_path = ? AND t.ticket_number = ?
     LIMIT 1`,
  );
  function attachmentBind(attachment: TicketAttachment) {
    return {
      id: attachment.id,
      ticket_id: attachment.ticketId,
      description: attachment.description,
      payload_json: JSON.stringify(attachment.payload),
      created_at: attachment.createdAt,
      updated_at: attachment.updatedAt,
    };
  }

  function insertTicket(input: PersistTicketInput): number {
    ensureProjectStmt.run(input.projectPath);
    const counter = getCounterStmt.get(input.projectPath) as {
      last_number: number;
    };
    insertTicketStmt.run({
      id: input.id,
      project_path: input.projectPath,
      ticket_number: counter.last_number,
      title: input.title,
      description: input.description,
      work_type: input.workType,
      status: input.status,
      created_at: input.createdAt,
      updated_at: input.updatedAt,
    });
    return counter.last_number;
  }

  const createTicketTx = db.transaction(insertTicket);

  const createWithAttachmentsTx = db.transaction(
    (
      input: PersistTicketInput,
      attachments: TicketAttachment[],
    ): TicketDetail => {
      const number = insertTicket(input);
      for (const attachment of attachments) {
        insertAttachmentStmt.run(attachmentBind(attachment));
      }
      const detail = readDetail(input.projectPath, number);
      if (detail === null) {
        throw new PersistenceError({
          kind: "not_found",
          entity: "ticket",
          identifier: input.id,
        });
      }
      return detail;
    },
  );

  function ticketRevisionFor(ticketId: string, requested: string): string {
    const rawTicket: unknown = findTicketByIdStmt.get(ticketId);
    if (rawTicket === undefined) {
      throw new PersistenceError({
        kind: "not_found",
        entity: "ticket",
        identifier: ticketId,
      });
    }
    return nextTicketRevision(rowToTicket(rawTicket).updatedAt, requested);
  }

  function advanceTicketRevision(ticketId: string, requested: string): string {
    const revision = ticketRevisionFor(ticketId, requested);
    setTicketUpdatedAtStmt.run(revision, ticketId);
    return revision;
  }

  type ConversationSnapshotRowSwapResult =
    | { status: "won"; attachment: TicketAttachment }
    | ConversationSnapshotSwapFailure;

  function compareAndSwapConversationSnapshotAtRevision(
    ticketId: string,
    update: ConversationSnapshotUpdate,
    revision: string,
  ): ConversationSnapshotRowSwapResult {
    const result = compareAndSwapConversationSnapshotStmt.run({
      attachment_id: update.attachmentId,
      ticket_id: ticketId,
      previous_payload_json: JSON.stringify(update.previousPayload),
      payload_json: JSON.stringify(update.payload),
      updated_at: revision,
    });
    const rawCurrent: unknown = findAttachmentStmt.get(
      update.attachmentId,
      ticketId,
    );
    if (rawCurrent === undefined) return { status: "missing" };
    const current = rowToAttachment(rawCurrent);
    if (result.changes === 0) {
      return { status: "lost", currentPayload: current.payload };
    }
    return { status: "won", attachment: current };
  }

  const compareAndSwapConversationSnapshotTx = db.transaction(
    (
      input: CompareAndSwapConversationSnapshotInput,
    ): CompareAndSwapConversationSnapshotResult => {
      const rawCurrent: unknown = findAttachmentStmt.get(
        input.attachmentId,
        input.ticketId,
      );
      if (rawCurrent === undefined) return { status: "missing" };
      const revision = ticketRevisionFor(input.ticketId, input.updatedAt);
      const result = compareAndSwapConversationSnapshotAtRevision(
        input.ticketId,
        input,
        revision,
      );
      if (result.status !== "won") return result;
      setTicketUpdatedAtStmt.run(revision, input.ticketId);
      return { ...result, ticketUpdatedAt: revision };
    },
  );

  const recoverPendingConversationSnapshotsTx = db.transaction(
    (
      input: RecoverPendingConversationSnapshotsInput,
    ): RecoveredConversationSnapshot[] => {
      const recovered: RecoveredConversationSnapshot[] = [];
      const rows = allAttachmentsWithTicketIdentityStmt.all() as Array<
        Record<string, unknown>
      >;
      for (const row of rows) {
        const attachment = rowToAttachment(row);
        const payload = attachment.payload;
        if (
          payload.kind !== "conversation" ||
          effectiveSnapshotStatus(payload) !== "pending"
        ) {
          continue;
        }

        const revision = ticketRevisionFor(
          attachment.ticketId,
          input.updatedAt,
        );
        const result = compareAndSwapConversationSnapshotAtRevision(
          attachment.ticketId,
          {
            attachmentId: attachment.id,
            previousPayload: payload,
            payload: {
              ...payload,
              snapshotStatus: "failed",
              snapshotError: input.snapshotError,
            },
            updatedAt: input.updatedAt,
          },
          revision,
        );
        if (result.status !== "won") continue;

        setTicketUpdatedAtStmt.run(revision, attachment.ticketId);
        const projectPath = row["ticket_project_path"];
        const ticketNumber = row["ticket_number"];
        if (
          typeof projectPath !== "string" ||
          typeof ticketNumber !== "number"
        ) {
          throw new PersistenceError({
            kind: "validation",
            entity: "ticket_attachment",
            identifier: attachment.id,
            issues:
              "startup snapshot recovery requires a valid parent ticket identity",
          });
        }
        recovered.push({
          ticketId: attachment.ticketId,
          attachmentId: attachment.id,
          projectPath,
          ticketNumber,
          ticketUpdatedAt: revision,
        });
      }
      return recovered;
    },
  );

  function assertSessionLinkTarget(
    input: z.output<typeof linkStartedSessionInputSchema>,
  ): void {
    const row = findSessionForLinkStmt.get(
      input.projectPath,
      input.sessionName,
    ) as { created_at: string; finished: 0 | 1 } | undefined;
    if (row === undefined) {
      throw new TicketSessionNotLinkableError(
        input.projectPath,
        input.sessionName,
        "deleted",
      );
    }
    if (row.created_at !== input.sessionCreatedAt) {
      throw new TicketSessionNotLinkableError(
        input.projectPath,
        input.sessionName,
        "replaced",
      );
    }
    if (row.finished === 1) {
      throw new TicketSessionNotLinkableError(
        input.projectPath,
        input.sessionName,
        "finished",
      );
    }
  }

  function endLinkAndTouchTicket(
    input: z.output<typeof endSessionLinkInputSchema>,
  ): TicketSessionLink | null {
    const existingRaw: unknown = findLinkByIdStmt.get(input.linkId);
    if (existingRaw === undefined) return null;
    const existing = rowToSessionLink(existingRaw);
    if (existing.endedAt !== null) return null;
    const revision = advanceTicketRevision(existing.ticketId, input.endedAt);
    const result = endLinkStmt.run({
      id: input.linkId,
      ended_at: revision,
      end_reason: input.endReason,
    });
    if (result.changes === 0) return null;
    const rawRow: unknown = findLinkByIdStmt.get(input.linkId);
    if (rawRow === undefined) return null;
    return rowToSessionLink(rawRow);
  }

  const endSessionLinkTx = db.transaction(endLinkAndTouchTicket);

  /**
   * The design's link-plus-status transaction (the sole automatic status
   * transition): insert the active link and move the ticket to in_progress
   * atomically, so a link can never exist for a ticket still marked
   * not_started and vice versa.
   */
  const linkStartedSessionTx = db.transaction(
    (
      ticketId: string,
      input: z.output<typeof linkStartedSessionInputSchema>,
    ) => {
      assertSessionLinkTarget(input);
      for (const demotion of input.staleLinkDemotions ?? []) {
        endLinkAndTouchTicket(demotion);
      }
      const revision = ticketRevisionFor(
        ticketId,
        latestTimestamp([
          input.linkedAt,
          input.sessionCreatedAt,
          ...(input.conversationSnapshotUpdates ?? []).map(
            (update) => update.updatedAt,
          ),
        ]),
      );
      for (const update of input.conversationSnapshotUpdates ?? []) {
        const result = compareAndSwapConversationSnapshotAtRevision(
          ticketId,
          update,
          revision,
        );
        if (result.status === "lost") {
          throw new ConversationSnapshotSwapError(update.attachmentId, result);
        }
      }
      insertLinkStmt.run({
        id: input.id,
        ticket_id: ticketId,
        project_path: input.projectPath,
        session_name: input.sessionName,
        session_created_at: input.sessionCreatedAt,
        start_mode: input.startMode,
        linked_at: revision,
      });
      setTicketStartedStmt.run(revision, ticketId);
    },
  );

  const addAttachmentTx = db.transaction((attachment: TicketAttachment) => {
    const revision = advanceTicketRevision(
      attachment.ticketId,
      attachment.updatedAt,
    );
    const persisted = { ...attachment, updatedAt: revision };
    insertAttachmentStmt.run(attachmentBind(persisted));
    return persisted;
  });

  const updateAttachmentTx = db.transaction(
    (
      input: z.output<typeof updateAttachmentInputSchema>,
    ): TicketAttachment | null => {
      const existing: unknown = findAttachmentStmt.get(
        input.attachmentId,
        input.ticketId,
      );
      if (existing === undefined) return null;
      const revision = advanceTicketRevision(input.ticketId, input.updatedAt);
      const sets: string[] = ["updated_at = @updated_at"];
      const bind: Record<string, string> = {
        id: input.attachmentId,
        ticket_id: input.ticketId,
        updated_at: revision,
      };
      if (input.description !== undefined) {
        sets.push("description = @description");
        bind.description = input.description;
      }
      if (input.payload !== undefined) {
        sets.push("payload_json = @payload_json");
        bind.payload_json = JSON.stringify(input.payload);
      }
      const result = db
        .prepare(
          `UPDATE ticket_attachments SET ${sets.join(", ")}
           WHERE id = @id AND ticket_id = @ticket_id`,
        )
        .run(bind);
      if (result.changes === 0) return null;
      const rawRow: unknown = findAttachmentStmt.get(
        input.attachmentId,
        input.ticketId,
      );
      return rawRow === undefined ? null : rowToAttachment(rawRow);
    },
  );

  const deleteAttachmentTx = db.transaction(
    (
      input: z.output<typeof deleteAttachmentInputSchema>,
    ): DeletedAttachmentResult | null => {
      const rawRow: unknown = findAttachmentStmt.get(
        input.attachmentId,
        input.ticketId,
      );
      if (rawRow === undefined) return null;
      const attachment = rowToAttachment(rawRow);
      deleteAttachmentStmt.run(input.attachmentId, input.ticketId);
      const ticketUpdatedAt = advanceTicketRevision(
        input.ticketId,
        input.updatedAt,
      );
      return { attachment, ticketUpdatedAt };
    },
  );

  function readDetail(
    projectPath: string,
    number: number,
  ): TicketDetail | null {
    const rawRow: unknown = findTicketStmt.get(projectPath, number);
    return detailFromRawRow(rawRow);
  }

  function detailFromRawRow(rawRow: unknown): TicketDetail | null {
    if (rawRow === undefined) return null;
    const ticket = rowToTicket(rawRow);
    return {
      ...ticket,
      projectName: projectNameFromPath(ticket.projectPath),
      attachments: (attachmentsByTicketStmt.all(ticket.id) as unknown[]).map(
        rowToAttachment,
      ),
      sessions: (sessionsByTicketStmt.all(ticket.id) as unknown[]).map(
        rowToSessionLink,
      ),
    };
  }

  return {
    async create(input) {
      const validated = persistTicketInputSchema.parse(input);
      return writeQueue.withWriteQueue("tickets.create", async () => {
        return timed("create", { id: validated.id }, () => {
          const number = createTicketTx.immediate(validated);
          return { ...validated, number };
        });
      });
    },

    async createWithAttachments(input, attachments) {
      const validatedInput = persistTicketInputSchema.parse(input);
      const validatedAttachments = ticketAttachmentSchema
        .array()
        .parse(attachments);
      for (const attachment of validatedAttachments) {
        if (attachment.ticketId !== validatedInput.id) {
          throw new PersistenceError({
            kind: "validation",
            entity: "ticket_attachment",
            identifier: attachment.id,
            issues: "attachment.ticketId must match the created ticket id",
          });
        }
      }
      return writeQueue.withWriteQueue(
        "tickets.createWithAttachments",
        async () => {
          return timed(
            "createWithAttachments",
            {
              id: validatedInput.id,
              attachmentCount: validatedAttachments.length,
            },
            () =>
              createWithAttachmentsTx.immediate(
                validatedInput,
                validatedAttachments,
              ),
          );
        },
      );
    },

    async list(query) {
      const conditions: string[] = [];
      const bind: Record<string, string> = {};
      if (query.projectPath !== undefined) {
        conditions.push("t.project_path = @project_path");
        bind.project_path = query.projectPath;
      }
      if (query.status !== undefined) {
        conditions.push("t.status = @status");
        bind.status = query.status;
      }
      if (query.workType !== undefined) {
        conditions.push("t.work_type = @work_type");
        bind.work_type = query.workType;
      }
      const where = conditions.length
        ? `WHERE ${conditions.join(" AND ")}`
        : "";

      return timed("list", { filters: conditions.length }, () => {
        const rows = db
          .prepare(
            `SELECT ${LIST_ITEM_COLUMNS}
             FROM tickets t
             ${where}
             ORDER BY ${LIST_ORDER_BY[query.sort]}`,
          )
          .all(bind) as unknown[];

        return rows.map(rawRowToListItem);
      });
    },

    async findListItem(projectPath, number) {
      return timed("findListItem", { projectPath, number }, () => {
        const rawRow: unknown = findListItemStmt.get(projectPath, number);
        return rawRow === undefined ? null : rawRowToListItem(rawRow);
      });
    },

    async find(projectPath, number) {
      return timed("find", { projectPath, number }, () =>
        readDetail(projectPath, number),
      );
    },

    async findById(ticketId) {
      return timed("findById", { ticketId }, () =>
        detailFromRawRow(findTicketByIdStmt.get(ticketId)),
      );
    },

    async listTicketIds(projectPath) {
      return timed("listTicketIds", { projectPath }, () =>
        (ticketIdsByProjectStmt.all(projectPath) as unknown[]).filter(
          (id): id is string => typeof id === "string",
        ),
      );
    },

    async update(input) {
      const validated = updateTicketInputSchema.parse(input);
      return writeQueue.withWriteQueue("tickets.update", async () => {
        return timed(
          "update",
          { projectPath: validated.projectPath, number: validated.number },
          () => {
            const currentRaw: unknown = findTicketStmt.get(
              validated.projectPath,
              validated.number,
            );
            if (currentRaw === undefined) return null;
            const current = rowToTicket(currentRaw);
            const revision = nextTicketRevision(
              current.updatedAt,
              validated.updatedAt,
            );
            const sets: string[] = ["updated_at = @updated_at"];
            const bind: Record<string, string | number> = {
              project_path: validated.projectPath,
              ticket_number: validated.number,
              updated_at: revision,
            };
            if (validated.title !== undefined) {
              sets.push("title = @title");
              bind.title = validated.title;
            }
            if (validated.description !== undefined) {
              sets.push("description = @description");
              bind.description = validated.description;
            }
            if (validated.workType !== undefined) {
              sets.push("work_type = @work_type");
              bind.work_type = validated.workType;
            }
            if (validated.status !== undefined) {
              sets.push("status = @status");
              bind.status = validated.status;
            }
            const result = db
              .prepare(
                `UPDATE tickets SET ${sets.join(", ")}
                 WHERE project_path = @project_path AND ticket_number = @ticket_number`,
              )
              .run(bind);
            if (result.changes === 0) return null;
            return readDetail(validated.projectPath, validated.number);
          },
        );
      });
    },

    async delete(projectPath, number) {
      return writeQueue.withWriteQueue("tickets.delete", async () => {
        return timed("delete", { projectPath, number }, () => {
          const rawRow: unknown = findTicketStmt.get(projectPath, number);
          if (rawRow === undefined) return null;
          const ticket = rowToTicket(rawRow);
          deleteTicketStmt.run(projectPath, number);
          const deleted: DeletedTicket = {
            id: ticket.id,
            projectPath: ticket.projectPath,
            projectName: projectNameFromPath(ticket.projectPath),
            number: ticket.number,
          };
          return deleted;
        });
      });
    },

    async addAttachment(input) {
      const validated = ticketAttachmentSchema.parse(input);
      return writeQueue.withWriteQueue("tickets.addAttachment", async () => {
        return timed(
          "addAttachment",
          { id: validated.id, ticketId: validated.ticketId },
          () => addAttachmentTx.immediate(validated),
        );
      });
    },

    async updateAttachment(input) {
      const validated = updateAttachmentInputSchema.parse(input);
      return writeQueue.withWriteQueue("tickets.updateAttachment", async () => {
        return timed(
          "updateAttachment",
          { id: validated.attachmentId, ticketId: validated.ticketId },
          () => updateAttachmentTx.immediate(validated),
        );
      });
    },

    async compareAndSwapConversationSnapshot(input) {
      const validated =
        compareAndSwapConversationSnapshotInputSchema.parse(input);
      return writeQueue.withWriteQueue(
        "tickets.compareAndSwapConversationSnapshot",
        async () => {
          return timed(
            "compareAndSwapConversationSnapshot",
            {
              id: validated.attachmentId,
              ticketId: validated.ticketId,
            },
            () => compareAndSwapConversationSnapshotTx.immediate(validated),
          );
        },
      );
    },

    async recoverPendingConversationSnapshots(input) {
      const validated =
        recoverPendingConversationSnapshotsInputSchema.parse(input);
      return writeQueue.withWriteQueue(
        "tickets.recoverPendingConversationSnapshots",
        async () => {
          return timed("recoverPendingConversationSnapshots", {}, () =>
            recoverPendingConversationSnapshotsTx.immediate(validated),
          );
        },
      );
    },

    async linkStartedSession(input) {
      const validated = linkStartedSessionInputSchema.parse(input);
      return writeQueue.withWriteQueue(
        "tickets.linkStartedSession",
        async () => {
          return timed(
            "linkStartedSession",
            {
              projectPath: validated.projectPath,
              number: validated.number,
              sessionName: validated.sessionName,
            },
            () => {
              const rawRow: unknown = findTicketStmt.get(
                validated.projectPath,
                validated.number,
              );
              if (rawRow === undefined) {
                throw new PersistenceError({
                  kind: "not_found",
                  entity: "ticket",
                  identifier: `${validated.projectPath}#${validated.number}`,
                });
              }
              const ticket = rowToTicket(rawRow);
              linkStartedSessionTx.immediate(ticket.id, validated);
              const detail = readDetail(
                validated.projectPath,
                validated.number,
              );
              if (!detail) {
                throw new PersistenceError({
                  kind: "not_found",
                  entity: "ticket",
                  identifier: ticket.id,
                });
              }
              return detail;
            },
          );
        },
      );
    },

    async endSessionLink(input) {
      const validated = endSessionLinkInputSchema.parse(input);
      return writeQueue.withWriteQueue("tickets.endSessionLink", async () => {
        return timed("endSessionLink", { linkId: validated.linkId }, () => {
          return endSessionLinkTx.immediate(validated);
        });
      });
    },

    async findOpenSessionLink(projectPath, sessionName) {
      return timed("findOpenSessionLink", { projectPath, sessionName }, () => {
        const rawRow: unknown = findOpenLinkByNameStmt.get(
          projectPath,
          sessionName,
        );
        return rawRow === undefined ? null : rowToSessionLink(rawRow);
      });
    },

    async findLinkedTicket(projectPath, sessionName) {
      return timed("findLinkedTicket", { projectPath, sessionName }, () => {
        const rawRow: unknown = findActiveGuardedLinkStmt.get(
          projectPath,
          sessionName,
        );
        if (rawRow === undefined) return null;
        const link = rowToSessionLink(rawRow);
        const ticketRow: unknown = findTicketByIdStmt.get(link.ticketId);
        if (ticketRow === undefined) return null;
        const ticket = rowToTicket(ticketRow);
        return {
          ...ticket,
          projectName: projectNameFromPath(ticket.projectPath),
          attachments: (
            attachmentsByTicketStmt.all(ticket.id) as unknown[]
          ).map(rowToAttachment),
        };
      });
    },

    async listSessionLinks(projectPath) {
      return timed("listSessionLinks", { projectPath }, () => {
        const rows = guardedLinksByProjectStmt.all(projectPath) as {
          link_id: string;
          session_name: string;
          linked_at: string;
          ended_at: string | null;
          session_finished: number;
          ticket_id: string;
          ticket_project_path: string;
          ticket_number: number;
          title: string;
        }[];
        const map: Record<string, TicketLinkSummary> = {};
        for (const row of rows) {
          if (map[row.session_name] !== undefined) continue;
          map[row.session_name] = {
            ticketId: row.ticket_id,
            projectName: projectNameFromPath(row.ticket_project_path),
            number: row.ticket_number,
            title: row.title,
            active: row.ended_at === null && row.session_finished === 0,
            linkedAt: row.linked_at,
            endedAt: row.ended_at,
          };
        }
        return map;
      });
    },

    async deleteAttachment(identity) {
      const validated = deleteAttachmentInputSchema.parse(identity);
      return writeQueue.withWriteQueue("tickets.deleteAttachment", async () => {
        return timed(
          "deleteAttachment",
          { id: validated.attachmentId, ticketId: validated.ticketId },
          () => deleteAttachmentTx.immediate(validated),
        );
      });
    },
  };
}
