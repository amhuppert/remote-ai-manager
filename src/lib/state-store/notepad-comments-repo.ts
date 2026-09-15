import type Database from "better-sqlite3";
import { z } from "zod";
import { createLogger } from "@/lib/logging";
import {
  notepadAuthorKindSchema,
  notepadCommentAnchorSchema,
  notepadCommentStatusSchema,
  notepadCommentReplySchema,
  notepadCommentSchema,
  notepadOpenCommentMarkerSchema,
  type NotepadComment,
  type NotepadCommentReply,
  type NotepadCommentStatus,
  type NotepadCommentThread,
  type NotepadOpenCommentMarker,
} from "@/lib/notepads/schemas";
import { PersistenceError } from "../shared/errors";
import { parseTrusted, registerTrustedSchema } from "../shared/parse-trusted";
import type { WriteQueue } from "./write-queue";

type Db = InstanceType<typeof Database>;

const logger = createLogger("state-store.notepad-comments");

// ============================================================
// Repo-level write inputs
// ============================================================

/**
 * A fresh comment is always open and never resolved, so neither is an input:
 * the repo owns them, which is what makes the resolve/reopen lifecycle a single
 * write path rather than a field any caller can set.
 */
export const createNotepadCommentRowInputSchema = z.object({
  id: z.string().min(1),
  notepadId: z.string().min(1),
  anchor: notepadCommentAnchorSchema,
  body: z.string().min(1),
  authorKind: notepadAuthorKindSchema,
  authorConversationId: z.string().min(1).nullable(),
  createdAt: z.string().min(1),
});
export type CreateNotepadCommentRowInput = z.infer<
  typeof createNotepadCommentRowInputSchema
>;

export const updateNotepadCommentStatusInputSchema = z.object({
  commentId: z.string().min(1),
  status: notepadCommentStatusSchema,
  updatedAt: z.string().min(1),
});
export type UpdateNotepadCommentStatusInput = z.infer<
  typeof updateNotepadCommentStatusInputSchema
>;

export const addNotepadCommentReplyInputSchema = z.object({
  id: z.string().min(1),
  commentId: z.string().min(1),
  body: z.string().min(1),
  authorKind: notepadAuthorKindSchema,
  authorConversationId: z.string().min(1).nullable(),
  createdAt: z.string().min(1),
});
export type AddNotepadCommentReplyInput = z.infer<
  typeof addNotepadCommentReplyInputSchema
>;

export const notepadCommentListRowQuerySchema = z.object({
  notepadId: z.string().min(1),
  /** Absent lists every comment; present narrows to one lifecycle state. */
  status: notepadCommentStatusSchema.optional(),
});
export type NotepadCommentListRowQuery = z.infer<
  typeof notepadCommentListRowQuerySchema
>;

export type CreateNotepadCommentResult =
  | { status: "created"; comment: NotepadComment }
  | { status: "missing_notepad" };

export type AddNotepadCommentReplyResult =
  | { status: "created"; reply: NotepadCommentReply }
  | { status: "missing_comment" };

export interface NotepadCommentsRepo {
  create(
    input: CreateNotepadCommentRowInput,
  ): Promise<CreateNotepadCommentResult>;
  find(commentId: string): Promise<NotepadComment | null>;
  findThread(commentId: string): Promise<NotepadCommentThread | null>;
  list(query: NotepadCommentListRowQuery): Promise<NotepadCommentThread[]>;
  /**
   * The notepad's open-comment state as a change notice compares it (D17):
   * how many are open and when the newest was written. Content-free and
   * constant-cost, so a per-turn notice check never loads review bodies.
   */
  openCommentMarker(notepadId: string): Promise<NotepadOpenCommentMarker>;
  updateStatus(
    input: UpdateNotepadCommentStatusInput,
  ): Promise<NotepadComment | null>;
  delete(commentId: string): Promise<NotepadComment | null>;
  addReply(
    input: AddNotepadCommentReplyInput,
  ): Promise<AddNotepadCommentReplyResult>;
}

// ============================================================
// Row schemas and mappers
// ============================================================

const notepadCommentsTableRowSchema = registerTrustedSchema(
  z.object({
    id: z.string(),
    notepad_id: z.string(),
    section_id: z.string(),
    heading_label: z.string(),
    line: z.number().int(),
    end_line: z.number().int().nullable(),
    end_section_id: z.string().nullable(),
    char_start: z.number().int(),
    char_end: z.number().int(),
    quote: z.string(),
    prefix: z.string(),
    suffix: z.string(),
    notepad_revision: z.number().int(),
    body: z.string(),
    status: z.string(),
    author_kind: z.string(),
    author_conversation_id: z.string().nullable(),
    created_at: z.string(),
    updated_at: z.string(),
    resolved_at: z.string().nullable(),
  }),
  "notepadCommentsTableRowSchema",
);

/** The aggregate projection behind `openCommentMarker` — not a table row. */
const openCommentMarkerRowSchema = registerTrustedSchema(
  z.object({
    count: z.number().int(),
    latest_created_at: z.string().nullable(),
  }),
  "openCommentMarkerRowSchema",
);

const notepadCommentRepliesTableRowSchema = registerTrustedSchema(
  z.object({
    id: z.string(),
    comment_id: z.string(),
    body: z.string(),
    author_kind: z.string(),
    author_conversation_id: z.string().nullable(),
    created_at: z.string(),
  }),
  "notepadCommentRepliesTableRowSchema",
);

/**
 * The parts of a Zod issue that name what failed without quoting what was
 * being validated. A Zod issue can carry the offending `input`, and here that
 * input is a comment body or an anchor quote — review content the logs must
 * never hold. The thrown `PersistenceError` still carries the full issues for a
 * caller that is allowed to see them.
 */
function loggableIssues(issues: z.core.$ZodIssue[]): unknown {
  return issues.map((issue) => ({
    code: issue.code,
    path: issue.path.map(String).join("."),
    message: issue.message,
  }));
}

function logAndThrowValidationFailure(
  entity: string,
  identifier: string,
  issues: z.core.$ZodIssue[],
): never {
  logger.error("state-store.notepad-comments.schema_validation_failure", {
    entity,
    identifier,
    issues: loggableIssues(issues),
  });
  throw new PersistenceError({
    kind: "validation",
    entity,
    identifier,
    issues,
  });
}

function rowToComment(rawRow: unknown): NotepadComment {
  const row = parseTrusted(notepadCommentsTableRowSchema, rawRow, (issues) =>
    logAndThrowValidationFailure("notepad_comment", "<row>", issues),
  );
  if ((row.end_line === null) !== (row.end_section_id === null)) {
    logAndThrowValidationFailure("notepad_comment", row.id, [
      {
        code: "custom",
        path: ["end_line"],
        message: "Incomplete passage endpoint",
      },
    ]);
  }
  return parseTrusted(
    notepadCommentSchema,
    {
      id: row.id,
      notepadId: row.notepad_id,
      anchor: {
        sectionId: row.section_id,
        headingLabel: row.heading_label,
        line: row.line,
        ...(row.end_line !== null && row.end_section_id !== null
          ? { endBlock: { line: row.end_line, sectionId: row.end_section_id } }
          : {}),
        charStart: row.char_start,
        charEnd: row.char_end,
        quote: row.quote,
        prefix: row.prefix,
        suffix: row.suffix,
        notepadRevision: row.notepad_revision,
      },
      body: row.body,
      status: row.status,
      authorKind: row.author_kind,
      authorConversationId: row.author_conversation_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      resolvedAt: row.resolved_at,
    },
    (issues) => logAndThrowValidationFailure("notepad_comment", row.id, issues),
  );
}

function rowToReply(rawRow: unknown): NotepadCommentReply {
  const row = parseTrusted(
    notepadCommentRepliesTableRowSchema,
    rawRow,
    (issues) =>
      logAndThrowValidationFailure("notepad_comment_reply", "<row>", issues),
  );
  return parseTrusted(
    notepadCommentReplySchema,
    {
      id: row.id,
      commentId: row.comment_id,
      body: row.body,
      authorKind: row.author_kind,
      authorConversationId: row.author_conversation_id,
      createdAt: row.created_at,
    },
    (issues) =>
      logAndThrowValidationFailure("notepad_comment_reply", row.id, issues),
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
    logger.info(`state-store.notepad-comments.${op}.timing`, {
      ...identifier,
      durationMs,
    });
  }
}

/**
 * When a comment stopped being open. Derived here rather than accepted as an
 * input so the timestamp cannot disagree with the status it explains, and so
 * reopening clears it in the same write that flips the status back.
 */
function resolvedAtFor(
  status: NotepadCommentStatus,
  updatedAt: string,
): string | null {
  return status === "resolved" ? updatedAt : null;
}

export function createNotepadCommentsRepo(
  db: Db,
  writeQueue: WriteQueue,
): NotepadCommentsRepo {
  const notepadExistsStmt = db
    .prepare(`SELECT 1 FROM notepads WHERE id = ? LIMIT 1`)
    .pluck();
  const insertCommentStmt = db.prepare(
    `INSERT INTO notepad_comments
       (id, notepad_id, section_id, heading_label, line, end_line, end_section_id, char_start, char_end,
        quote, prefix, suffix, notepad_revision, body, status, author_kind,
        author_conversation_id, created_at, updated_at, resolved_at)
     VALUES
       (@id, @notepad_id, @section_id, @heading_label, @line, @end_line, @end_section_id, @char_start,
        @char_end, @quote, @prefix, @suffix, @notepad_revision, @body, 'open',
        @author_kind, @author_conversation_id, @created_at, @created_at, NULL)`,
  );
  const findCommentStmt = db.prepare(
    `SELECT * FROM notepad_comments WHERE id = ? LIMIT 1`,
  );
  const commentsByNotepadStmt = db.prepare(
    `SELECT * FROM notepad_comments WHERE notepad_id = @notepad_id
      ORDER BY created_at ASC, id ASC`,
  );
  const commentsByNotepadStatusStmt = db.prepare(
    `SELECT * FROM notepad_comments
      WHERE notepad_id = @notepad_id AND status = @status
      ORDER BY created_at ASC, id ASC`,
  );
  // Replies for a whole notepad in one read, so a listing is two queries
  // regardless of how many comments it returns.
  const repliesByNotepadStmt = db.prepare(
    `SELECT r.* FROM notepad_comment_replies r
       JOIN notepad_comments c ON c.id = r.comment_id
      WHERE c.notepad_id = ?
      ORDER BY r.created_at ASC, r.id ASC`,
  );
  const repliesByCommentStmt = db.prepare(
    `SELECT * FROM notepad_comment_replies WHERE comment_id = ?
      ORDER BY created_at ASC, id ASC`,
  );
  const openCommentMarkerStmt = db.prepare(
    `SELECT COUNT(*) AS count, MAX(created_at) AS latest_created_at
       FROM notepad_comments WHERE notepad_id = ? AND status = 'open'`,
  );
  const updateStatusStmt = db.prepare(
    `UPDATE notepad_comments
        SET status = @status, updated_at = @updated_at,
            resolved_at = @resolved_at
      WHERE id = @id`,
  );
  const deleteCommentStmt = db.prepare(
    `DELETE FROM notepad_comments WHERE id = ?`,
  );
  const insertReplyStmt = db.prepare(
    `INSERT INTO notepad_comment_replies
       (id, comment_id, body, author_kind, author_conversation_id, created_at)
     VALUES
       (@id, @comment_id, @body, @author_kind, @author_conversation_id,
        @created_at)`,
  );

  function readComment(commentId: string): NotepadComment | null {
    const rawRow: unknown = findCommentStmt.get(commentId);
    return rawRow === undefined ? null : rowToComment(rawRow);
  }

  function readReplies(commentId: string): NotepadCommentReply[] {
    return (repliesByCommentStmt.all(commentId) as unknown[]).map(rowToReply);
  }

  const createTx = db.transaction(
    (input: CreateNotepadCommentRowInput): CreateNotepadCommentResult => {
      // Checked inside the transaction rather than by the caller: a notepad
      // deleted between a caller's check and this insert would otherwise
      // surface as a raised foreign-key constraint instead of a typed result.
      if (notepadExistsStmt.get(input.notepadId) === undefined) {
        return { status: "missing_notepad" };
      }
      insertCommentStmt.run({
        id: input.id,
        notepad_id: input.notepadId,
        section_id: input.anchor.sectionId,
        heading_label: input.anchor.headingLabel,
        line: input.anchor.line,
        end_line: input.anchor.endBlock?.line ?? null,
        end_section_id: input.anchor.endBlock?.sectionId ?? null,
        char_start: input.anchor.charStart,
        char_end: input.anchor.charEnd,
        quote: input.anchor.quote,
        prefix: input.anchor.prefix,
        suffix: input.anchor.suffix,
        notepad_revision: input.anchor.notepadRevision,
        body: input.body,
        author_kind: input.authorKind,
        author_conversation_id: input.authorConversationId,
        created_at: input.createdAt,
      });
      const comment = readComment(input.id);
      if (comment === null) {
        throw new PersistenceError({
          kind: "not_found",
          entity: "notepad_comment",
          identifier: input.id,
        });
      }
      return { status: "created", comment };
    },
  );

  const updateStatusTx = db.transaction(
    (input: UpdateNotepadCommentStatusInput): NotepadComment | null => {
      if (readComment(input.commentId) === null) return null;
      updateStatusStmt.run({
        id: input.commentId,
        status: input.status,
        updated_at: input.updatedAt,
        resolved_at: resolvedAtFor(input.status, input.updatedAt),
      });
      return readComment(input.commentId);
    },
  );

  const deleteTx = db.transaction(
    (commentId: string): NotepadComment | null => {
      const comment = readComment(commentId);
      if (comment === null) return null;
      deleteCommentStmt.run(commentId);
      return comment;
    },
  );

  const addReplyTx = db.transaction(
    (input: AddNotepadCommentReplyInput): AddNotepadCommentReplyResult => {
      if (readComment(input.commentId) === null) {
        return { status: "missing_comment" };
      }
      insertReplyStmt.run({
        id: input.id,
        comment_id: input.commentId,
        body: input.body,
        author_kind: input.authorKind,
        author_conversation_id: input.authorConversationId,
        created_at: input.createdAt,
      });
      const reply = readReplies(input.commentId).find(
        (candidate) => candidate.id === input.id,
      );
      if (reply === undefined) {
        throw new PersistenceError({
          kind: "not_found",
          entity: "notepad_comment_reply",
          identifier: input.id,
        });
      }
      return { status: "created", reply };
    },
  );

  return {
    async create(input) {
      const validated = createNotepadCommentRowInputSchema.parse(input);
      return writeQueue.withWriteQueueSync("notepadComments.create", () =>
        timed(
          "create",
          { id: validated.id, notepadId: validated.notepadId },
          () => createTx.immediate(validated),
        ),
      );
    },

    async find(commentId) {
      return timed("find", { commentId }, () => readComment(commentId));
    },

    async findThread(commentId) {
      return timed("findThread", { commentId }, () => {
        const comment = readComment(commentId);
        if (comment === null) return null;
        return { comment, replies: readReplies(commentId) };
      });
    },

    async list(query) {
      const validated = notepadCommentListRowQuerySchema.parse(query);
      return timed(
        "list",
        { notepadId: validated.notepadId, status: validated.status },
        () => {
          const rows = (
            validated.status === undefined
              ? commentsByNotepadStmt.all({ notepad_id: validated.notepadId })
              : commentsByNotepadStatusStmt.all({
                  notepad_id: validated.notepadId,
                  status: validated.status,
                })
          ) as unknown[];
          const repliesByComment = new Map<string, NotepadCommentReply[]>();
          for (const rawReply of repliesByNotepadStmt.all(
            validated.notepadId,
          ) as unknown[]) {
            const reply = rowToReply(rawReply);
            const existing = repliesByComment.get(reply.commentId);
            if (existing === undefined) {
              repliesByComment.set(reply.commentId, [reply]);
            } else {
              existing.push(reply);
            }
          }
          return rows.map((row) => {
            const comment = rowToComment(row);
            return {
              comment,
              replies: repliesByComment.get(comment.id) ?? [],
            };
          });
        },
      );
    },

    async openCommentMarker(notepadId) {
      return timed("openCommentMarker", { notepadId }, () => {
        const row = parseTrusted(
          openCommentMarkerRowSchema,
          openCommentMarkerStmt.get(notepadId),
          (issues) =>
            logAndThrowValidationFailure(
              "notepad_open_comment_marker",
              notepadId,
              issues,
            ),
        );
        return parseTrusted(
          notepadOpenCommentMarkerSchema,
          // `MAX` over an empty set is SQL NULL, which is exactly the
          // "no open comment" the marker models — no coalescing needed.
          { count: row.count, latestCreatedAt: row.latest_created_at },
          (issues) =>
            logAndThrowValidationFailure(
              "notepad_open_comment_marker",
              notepadId,
              issues,
            ),
        );
      });
    },

    async updateStatus(input) {
      const validated = updateNotepadCommentStatusInputSchema.parse(input);
      return writeQueue.withWriteQueueSync("notepadComments.updateStatus", () =>
        timed(
          "updateStatus",
          { commentId: validated.commentId, status: validated.status },
          () => updateStatusTx.immediate(validated),
        ),
      );
    },

    async delete(commentId) {
      return writeQueue.withWriteQueueSync("notepadComments.delete", () =>
        timed("delete", { commentId }, () => deleteTx.immediate(commentId)),
      );
    },

    async addReply(input) {
      const validated = addNotepadCommentReplyInputSchema.parse(input);
      return writeQueue.withWriteQueueSync("notepadComments.addReply", () =>
        timed(
          "addReply",
          { id: validated.id, commentId: validated.commentId },
          () => addReplyTx.immediate(validated),
        ),
      );
    },
  };
}
