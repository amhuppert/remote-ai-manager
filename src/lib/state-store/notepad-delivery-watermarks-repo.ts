import type Database from "better-sqlite3";
import { z } from "zod";
import { createLogger } from "@/lib/logging";
import {
  notepadDeliveryWatermarkSchema,
  notepadOpenCommentMarkerSchema,
  type NotepadDeliveryWatermark,
} from "@/lib/notepads/schemas";
import { PersistenceError } from "../shared/errors";
import { mergeAcceptedNotepadContext } from "@/lib/notepads/accepted-context";
import { parseTrusted, registerTrustedSchema } from "../shared/parse-trusted";
import type { WriteQueue } from "./write-queue";

type Db = InstanceType<typeof Database>;

const logger = createLogger("state-store.notepad-delivery-watermarks");

// ============================================================
// Repo-level write inputs
// ============================================================

/**
 * Accepted source knowledge for one conversation and notepad. Recording joins
 * the accepted revision and observed IDs so an older retried receipt cannot
 * erase a later acceptance. The comment marker remains an actual rendered pair.
 */
export const recordNotepadDeliveryWatermarkInputSchema = z.object({
  conversationId: z.string().min(1),
  notepadId: z.string().min(1),
  revision: z.number().int().positive(),
  openComments: notepadOpenCommentMarkerSchema,
  commentIds: z.array(z.string().min(1)).optional(),
  updatedAt: z.string().min(1),
});
export type RecordNotepadDeliveryWatermarkInput = z.infer<
  typeof recordNotepadDeliveryWatermarkInputSchema
>;

export interface NotepadDeliveryWatermarksRepo {
  /**
   * Upsert what this conversation has now been shown of the notepad. Null when
   * the notepad no longer exists — a delivery can race a delete, and a typed
   * null is a better answer than a raised foreign-key constraint.
   */
  record(
    input: RecordNotepadDeliveryWatermarkInput,
  ): Promise<NotepadDeliveryWatermark | null>;
  /** Every notepad this conversation has been shown, oldest recording first. */
  listForConversation(
    conversationId: string,
  ): Promise<NotepadDeliveryWatermark[]>;
}

// ============================================================
// Row schema and mapper
// ============================================================

const notepadDeliveryWatermarksTableRowSchema = registerTrustedSchema(
  z.object({
    conversation_id: z.string(),
    notepad_id: z.string(),
    revision: z.number().int(),
    open_comment_count: z.number().int(),
    latest_open_comment_at: z.string().nullable(),
    observed_comment_ids_json: z.string().nullable(),
    updated_at: z.string(),
  }),
  "notepadDeliveryWatermarksTableRowSchema",
);

function logAndThrowValidationFailure(
  identifier: string,
  issues: z.core.$ZodIssue[],
): never {
  logger.error(
    "state-store.notepad-delivery-watermarks.schema_validation_failure",
    {
      entity: "notepad_delivery_watermark",
      identifier,
      issues: issues.map((issue) => ({
        code: issue.code,
        path: issue.path.map(String).join("."),
        message: issue.message,
      })),
    },
  );
  throw new PersistenceError({
    kind: "validation",
    entity: "notepad_delivery_watermark",
    identifier,
    issues,
  });
}

function rowToWatermark(rawRow: unknown): NotepadDeliveryWatermark {
  const row = parseTrusted(
    notepadDeliveryWatermarksTableRowSchema,
    rawRow,
    (issues) => logAndThrowValidationFailure("<row>", issues),
  );
  return parseTrusted(
    notepadDeliveryWatermarkSchema,
    {
      conversationId: row.conversation_id,
      notepadId: row.notepad_id,
      revision: row.revision,
      openComments: {
        count: row.open_comment_count,
        latestCreatedAt: row.latest_open_comment_at,
      },
      ...(row.observed_comment_ids_json === null
        ? {}
        : {
            commentIds: z
              .array(z.string().min(1))
              .parse(JSON.parse(row.observed_comment_ids_json)),
          }),
      updatedAt: row.updated_at,
    },
    (issues) =>
      logAndThrowValidationFailure(
        `${row.conversation_id}/${row.notepad_id}`,
        issues,
      ),
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
    logger.info(`state-store.notepad-delivery-watermarks.${op}.timing`, {
      ...identifier,
      durationMs,
    });
  }
}

export function createNotepadDeliveryWatermarksRepo(
  db: Db,
  writeQueue: WriteQueue,
): NotepadDeliveryWatermarksRepo {
  const notepadExistsStmt = db
    .prepare(`SELECT 1 FROM notepads WHERE id = ? LIMIT 1`)
    .pluck();
  const upsertStmt = db.prepare(
    `INSERT INTO notepad_delivery_watermarks
       (conversation_id, notepad_id, revision, open_comment_count,
        latest_open_comment_at, observed_comment_ids_json, updated_at)
     VALUES
       (@conversation_id, @notepad_id, @revision, @open_comment_count,
        @latest_open_comment_at, @observed_comment_ids_json, @updated_at)
     ON CONFLICT (conversation_id, notepad_id) DO UPDATE SET
       revision = excluded.revision,
       open_comment_count = excluded.open_comment_count,
       latest_open_comment_at = excluded.latest_open_comment_at,
       observed_comment_ids_json = excluded.observed_comment_ids_json,
       updated_at = excluded.updated_at`,
  );
  const findStmt = db.prepare(
    `SELECT * FROM notepad_delivery_watermarks
      WHERE conversation_id = ? AND notepad_id = ? LIMIT 1`,
  );
  const listByConversationStmt = db.prepare(
    `SELECT * FROM notepad_delivery_watermarks WHERE conversation_id = ?
      ORDER BY updated_at ASC, notepad_id ASC`,
  );

  const recordTx = db.transaction(
    (
      input: RecordNotepadDeliveryWatermarkInput,
    ): NotepadDeliveryWatermark | null => {
      // Checked inside the transaction rather than by the caller: a notepad
      // deleted between the reference expansion and this write would otherwise
      // surface as a raised foreign-key constraint instead of a typed null.
      if (notepadExistsStmt.get(input.notepadId) === undefined) return null;
      const existing: unknown = findStmt.get(
        input.conversationId,
        input.notepadId,
      );
      const context = mergeAcceptedNotepadContext(
        existing === undefined ? undefined : rowToWatermark(existing),
        input,
      );
      upsertStmt.run({
        conversation_id: input.conversationId,
        notepad_id: input.notepadId,
        revision: context.revision,
        open_comment_count: context.openComments.count,
        latest_open_comment_at: context.openComments.latestCreatedAt,
        observed_comment_ids_json:
          context.commentIds === undefined
            ? null
            : JSON.stringify(context.commentIds),
        updated_at: input.updatedAt,
      });
      const rawRow: unknown = findStmt.get(
        input.conversationId,
        input.notepadId,
      );
      if (rawRow === undefined) {
        throw new PersistenceError({
          kind: "not_found",
          entity: "notepad_delivery_watermark",
          identifier: `${input.conversationId}/${input.notepadId}`,
        });
      }
      return rowToWatermark(rawRow);
    },
  );

  return {
    async record(input) {
      const validated = recordNotepadDeliveryWatermarkInputSchema.parse(input);
      return writeQueue.withWriteQueueSync(
        "notepadDeliveryWatermarks.record",
        () =>
          timed(
            "record",
            {
              conversationId: validated.conversationId,
              notepadId: validated.notepadId,
            },
            () => recordTx.immediate(validated),
          ),
      );
    },

    async listForConversation(conversationId) {
      return timed("listForConversation", { conversationId }, () =>
        (listByConversationStmt.all(conversationId) as unknown[]).map(
          rowToWatermark,
        ),
      );
    },
  };
}
