import type Database from "better-sqlite3";
import { z } from "zod";
import { createLogger } from "@/lib/logging";
import { PersistenceError } from "@/lib/shared/errors";
import {
  parseTrusted,
  registerTrustedSchema,
} from "@/lib/shared/parse-trusted";
import { jsonOrNull } from "@/lib/state-store/serialization";
import { backendModelSelectionSchema } from "@/lib/agent-backends/schemas";
import {
  compactionEnvelopeSchema,
  contextArtifactRowSchema,
  type CompactionEnvelope,
  type ContextArtifactRow,
} from "./schemas";

type Db = InstanceType<typeof Database>;

const logger = createLogger("state-store.context-artifacts");

/**
 * Standalone durable repository over the `context_artifacts` table
 * (merge-intents/session-alignment pattern: factory over the shared db handle,
 * not part of `AllRepos`/`StateStore`/the write queue).
 *
 * **No FK to conversations.** Conversations live in two tables
 * (`conversations` for session scope, `project_conversations` for project
 * scope), so a single FK target does not exist; row lifecycle is instead
 * enforced by the delete-path wiring in `src/lib/sessions/service.ts`
 * (`deleteByScope` on session delete and project delete). Neither scope has a
 * per-conversation hard-delete flow today, so `deleteByConversation` has no
 * production trigger yet — project-scope artifacts are cleaned only at
 * project-delete granularity.
 *
 * **`conversation_id` is a sound global uniqueness key.** Transcripts are
 * stored globally by id (`transcripts/{conversationId}.jsonl`), so
 * conversation ids are already unique across sessions and projects; the
 * partial unique indexes (`uq_context_artifacts_conversation_kind`,
 * `uq_context_artifacts_message`) inherit that invariant. The scope columns
 * remain load-bearing for cleanup, listing, and route-handler scope checks.
 *
 * Upserts are keyed by the partial unique indexes: a
 * `conversation_compaction` write replaces the existing artifact for its
 * conversation, a `message_compaction` write replaces the artifact for its
 * `(conversation_id, message_index)` — whole-row semantics, including `id`
 * and `created_at` (callers own timestamp continuity across regenerations).
 */
export interface ContextArtifactsRepo {
  findByConversation(conversationId: string): ContextArtifactRow[];
  findById(id: string): ContextArtifactRow | null;
  findMessageArtifact(
    conversationId: string,
    messageIndex: number,
  ): ContextArtifactRow | null;
  /** Batched finder for list enrichment; returns [] for an empty id set. */
  findByConversationIds(conversationIds: string[]): ContextArtifactRow[];
  /**
   * Rows for a project, optionally narrowed to one session. Without a
   * sessionName this returns every row for the project — session-scope and
   * project-scope (NULL session_name) alike.
   */
  findByScope(projectPath: string, sessionName?: string): ContextArtifactRow[];
  upsert(row: ContextArtifactRow): void;
  /**
   * Per-column write (PERFORMANCE.md pattern 2): updates only the provided
   * fields. Returns true when a row actually changed.
   */
  updateChangedColumns(id: string, partial: ContextArtifactPatch): boolean;
  /**
   * Marks every `pending` row `failed` with the given error. Startup
   * recovery: a generation run lives only in the service's in-memory
   * single-flight map, so a row still pending when the process starts is an
   * orphan from a previous process. Returns the number of rows swept.
   */
  failPendingRuns(error: string, updatedAt: string): number;
  /** Removes one artifact by id; returns true when a row existed. */
  deleteById(id: string): boolean;
  /** Removes all artifacts for one conversation; returns the removed count. */
  deleteByConversation(conversationId: string): number;
  /**
   * Removes all artifacts for a session, or — without a sessionName — every
   * artifact for the project (superset cleanup on project delete, catching
   * project-scope rows and any stragglers). Returns the removed count.
   */
  deleteByScope(projectPath: string, sessionName?: string): number;
}

export type ContextArtifactPatch = Partial<Omit<ContextArtifactRow, "id">>;

const contextArtifactsTableRowSchema = registerTrustedSchema(
  z.object({
    id: z.string(),
    kind: z.string(),
    scope: z.string(),
    project_path: z.string(),
    session_name: z.string().nullable(),
    conversation_id: z.string(),
    message_id: z.string().nullable(),
    message_index: z.number().int().nullable(),
    covered_start_seq: z.number().int(),
    covered_end_seq: z.number().int(),
    source_hash: z.string(),
    status: z.string(),
    error: z.string().nullable(),
    backend: z.string(),
    model_selection_json: z.string(),
    schema_version: z.number().int(),
    prompt_version: z.string(),
    normalizer_version: z.string(),
    created_by: z.string(),
    created_by_conversation_id: z.string().nullable(),
    payload_json: z.string().nullable(),
    created_at: z.string(),
    updated_at: z.string(),
  }),
  "contextArtifactsTableRowSchema",
);
type ContextArtifactsTableRow = z.infer<typeof contextArtifactsTableRowSchema>;

function logAndThrowValidationFailure(
  identifier: string,
  issues: unknown,
): never {
  logger.error("state-store.context-artifacts.schema_validation_failure", {
    identifier,
    issues,
  });
  throw new PersistenceError({
    kind: "validation",
    entity: "context_artifact",
    identifier,
    issues,
  });
}

/**
 * Serializes a (partial) domain row to SQL column bind values. The single
 * source of truth for camelCase→snake_case column mapping — both the
 * whole-row upsert and the per-column update path go through it, so the two
 * can never drift. Keys whose value is `undefined` are omitted; explicit
 * `null` clears the column.
 */
function serializeColumns(
  partial: ContextArtifactPatch,
): Record<string, string | number | null> {
  const out: Record<string, string | number | null> = {};
  if (partial.kind !== undefined) out.kind = partial.kind;
  if (partial.scope !== undefined) out.scope = partial.scope;
  if (partial.projectPath !== undefined) {
    out.project_path = partial.projectPath;
  }
  if (partial.sessionName !== undefined) {
    out.session_name = partial.sessionName;
  }
  if (partial.conversationId !== undefined) {
    out.conversation_id = partial.conversationId;
  }
  if (partial.messageId !== undefined) out.message_id = partial.messageId;
  if (partial.messageIndex !== undefined) {
    out.message_index = partial.messageIndex;
  }
  if (partial.coveredStartSeq !== undefined) {
    out.covered_start_seq = partial.coveredStartSeq;
  }
  if (partial.coveredEndSeq !== undefined) {
    out.covered_end_seq = partial.coveredEndSeq;
  }
  if (partial.sourceHash !== undefined) out.source_hash = partial.sourceHash;
  if (partial.status !== undefined) out.status = partial.status;
  if (partial.error !== undefined) out.error = partial.error;
  if (partial.backend !== undefined) out.backend = partial.backend;
  if (partial.modelSelection !== undefined) {
    out.model_selection_json = JSON.stringify(partial.modelSelection);
  }
  if (partial.schemaVersion !== undefined) {
    out.schema_version = partial.schemaVersion;
  }
  if (partial.promptVersion !== undefined) {
    out.prompt_version = partial.promptVersion;
  }
  if (partial.normalizerVersion !== undefined) {
    out.normalizer_version = partial.normalizerVersion;
  }
  if (partial.createdBy !== undefined) out.created_by = partial.createdBy;
  if (partial.createdByConversationId !== undefined) {
    out.created_by_conversation_id = partial.createdByConversationId;
  }
  if (partial.payload !== undefined) {
    out.payload_json = jsonOrNull(partial.payload);
  }
  if (partial.createdAt !== undefined) out.created_at = partial.createdAt;
  if (partial.updatedAt !== undefined) out.updated_at = partial.updatedAt;
  return out;
}

/**
 * Parses payload_json with `safeParse` — the envelope schema carries
 * `.default()` effects, so it must never go through the trusted (effect-free)
 * fast path. A corrupt payload degrades the row to failed-shaped instead of
 * throwing: reads over historical artifacts must never take down a listing.
 */
function parsePayload(row: ContextArtifactsTableRow): {
  payload: CompactionEnvelope | null;
  corrupt: boolean;
} {
  if (row.payload_json === null) return { payload: null, corrupt: false };
  let candidate: unknown;
  try {
    candidate = JSON.parse(row.payload_json);
  } catch {
    return { payload: null, corrupt: true };
  }
  const result = compactionEnvelopeSchema.safeParse(candidate);
  if (!result.success) return { payload: null, corrupt: true };
  return { payload: result.data, corrupt: false };
}

function parseModelSelection(
  row: ContextArtifactsTableRow,
): ContextArtifactRow["modelSelection"] {
  let candidate: unknown;
  try {
    candidate = JSON.parse(row.model_selection_json);
  } catch {
    return logAndThrowValidationFailure(row.id, [
      { path: ["modelSelection"], message: "stored JSON is invalid" },
    ]);
  }
  const result = backendModelSelectionSchema.safeParse(candidate);
  if (!result.success) {
    return logAndThrowValidationFailure(row.id, result.error.issues);
  }
  return result.data;
}

function rowToDomain(rawRow: unknown): ContextArtifactRow {
  const fallbackId =
    typeof rawRow === "object" &&
    rawRow !== null &&
    typeof (rawRow as { id?: unknown }).id === "string"
      ? (rawRow as { id: string }).id
      : "<unknown>";

  const row: ContextArtifactsTableRow = parseTrusted(
    contextArtifactsTableRowSchema,
    rawRow,
    (issues) => logAndThrowValidationFailure(fallbackId, issues),
  );

  const { payload, corrupt } = parsePayload(row);
  const modelSelection = parseModelSelection(row);
  if (corrupt) {
    logger.warn("state-store.context-artifacts.payload_parse_failure", {
      id: row.id,
      conversationId: row.conversation_id,
      kind: row.kind,
    });
  }

  const candidate = {
    id: row.id,
    kind: row.kind,
    scope: row.scope,
    projectPath: row.project_path,
    sessionName: row.session_name,
    conversationId: row.conversation_id,
    messageId: row.message_id,
    messageIndex: row.message_index,
    coveredStartSeq: row.covered_start_seq,
    coveredEndSeq: row.covered_end_seq,
    sourceHash: row.source_hash,
    status: corrupt ? "failed" : row.status,
    error: corrupt ? "payload_json failed validation" : row.error,
    backend: row.backend,
    modelSelection,
    schemaVersion: row.schema_version,
    promptVersion: row.prompt_version,
    normalizerVersion: row.normalizer_version,
    createdBy: row.created_by,
    createdByConversationId: row.created_by_conversation_id,
    payload,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };

  const result = contextArtifactRowSchema.safeParse(candidate);
  if (!result.success) {
    return logAndThrowValidationFailure(row.id, result.error.issues);
  }
  return result.data;
}

function timed<T>(
  op: string,
  identifier: {
    id?: string;
    conversationId?: string;
    projectPath?: string;
    sessionName?: string;
    messageIndex?: number;
  },
  fn: () => T,
): T {
  const start = performance.now();
  try {
    return fn();
  } finally {
    const durationMs = +(performance.now() - start).toFixed(3);
    const payload: Record<string, unknown> = { durationMs };
    if (identifier.id !== undefined) payload.id = identifier.id;
    if (identifier.conversationId !== undefined) {
      payload.conversationId = identifier.conversationId;
    }
    if (identifier.projectPath !== undefined) {
      payload.projectPath = identifier.projectPath;
    }
    if (identifier.sessionName !== undefined) {
      payload.sessionName = identifier.sessionName;
    }
    if (identifier.messageIndex !== undefined) {
      payload.messageIndex = identifier.messageIndex;
    }
    logger.info(`state-store.context-artifacts.${op}.timing`, payload);
  }
}

const ALL_COLUMNS = [
  "id",
  "kind",
  "scope",
  "project_path",
  "session_name",
  "conversation_id",
  "message_id",
  "message_index",
  "covered_start_seq",
  "covered_end_seq",
  "source_hash",
  "status",
  "error",
  "backend",
  "model_selection_json",
  "schema_version",
  "prompt_version",
  "normalizer_version",
  "created_by",
  "created_by_conversation_id",
  "payload_json",
  "created_at",
  "updated_at",
] as const;

export function createContextArtifactsRepo(db: Db): ContextArtifactsRepo {
  const columnList = ALL_COLUMNS.join(", ");
  const bindList = ALL_COLUMNS.map((c) => `@${c}`).join(", ");
  const replaceAll = ALL_COLUMNS.map((c) => `${c} = excluded.${c}`).join(", ");
  const replaceExceptId = ALL_COLUMNS.filter((c) => c !== "id")
    .map((c) => `${c} = excluded.${c}`)
    .join(", ");

  // Clause order matters: the logical identity of an artifact is its partial
  // unique index (one live conversation compaction per conversation, one
  // message compaction per message index), so those clauses come first and a
  // regeneration under a fresh id replaces the existing row. The id clause is
  // last, covering plain same-id rewrites (e.g. pending → complete).
  const upsertStmt = db.prepare(
    `INSERT INTO context_artifacts (${columnList}) VALUES (${bindList})
     ON CONFLICT(conversation_id) WHERE kind = 'conversation_compaction'
       DO UPDATE SET ${replaceAll}
     ON CONFLICT(conversation_id, message_index) WHERE kind = 'message_compaction'
       DO UPDATE SET ${replaceAll}
     ON CONFLICT(id) DO UPDATE SET ${replaceExceptId}`,
  );

  const findByIdStmt = db.prepare(
    `SELECT * FROM context_artifacts WHERE id = ? LIMIT 1`,
  );
  const findByConversationStmt = db.prepare(
    `SELECT * FROM context_artifacts
      WHERE conversation_id = ?
      ORDER BY kind ASC, message_index ASC`,
  );
  const findMessageArtifactStmt = db.prepare(
    `SELECT * FROM context_artifacts
      WHERE conversation_id = ? AND message_index = ?
        AND kind = 'message_compaction'
      LIMIT 1`,
  );
  const findByProjectStmt = db.prepare(
    `SELECT * FROM context_artifacts
      WHERE project_path = ?
      ORDER BY conversation_id ASC, kind ASC, message_index ASC`,
  );
  const findBySessionStmt = db.prepare(
    `SELECT * FROM context_artifacts
      WHERE project_path = ? AND session_name = ?
      ORDER BY conversation_id ASC, kind ASC, message_index ASC`,
  );
  const failPendingRunsStmt = db.prepare(
    `UPDATE context_artifacts
        SET status = 'failed', error = @error, updated_at = @updated_at
      WHERE status = 'pending'`,
  );
  const deleteByIdStmt = db.prepare(
    `DELETE FROM context_artifacts WHERE id = ?`,
  );
  const deleteByConversationStmt = db.prepare(
    `DELETE FROM context_artifacts WHERE conversation_id = ?`,
  );
  const deleteByProjectStmt = db.prepare(
    `DELETE FROM context_artifacts WHERE project_path = ?`,
  );
  const deleteBySessionStmt = db.prepare(
    `DELETE FROM context_artifacts WHERE project_path = ? AND session_name = ?`,
  );

  const updateStmtCache = new Map<string, Database.Statement>();
  function getUpdateColumnsStmt(sortedColumns: string[]): Database.Statement {
    const key = sortedColumns.join(",");
    const cached = updateStmtCache.get(key);
    if (cached) return cached;
    const assignments = sortedColumns.map((c) => `${c} = @${c}`).join(", ");
    const stmt = db.prepare(
      `UPDATE context_artifacts SET ${assignments} WHERE id = @id`,
    );
    updateStmtCache.set(key, stmt);
    return stmt;
  }

  return {
    findByConversation(conversationId) {
      return timed("findByConversation", { conversationId }, () => {
        const rows = findByConversationStmt.all(conversationId) as unknown[];
        return rows.map(rowToDomain);
      });
    },
    findById(id) {
      return timed("findById", { id }, () => {
        const row: unknown = findByIdStmt.get(id);
        if (row === undefined) return null;
        return rowToDomain(row);
      });
    },
    findMessageArtifact(conversationId, messageIndex) {
      return timed(
        "findMessageArtifact",
        { conversationId, messageIndex },
        () => {
          const row: unknown = findMessageArtifactStmt.get(
            conversationId,
            messageIndex,
          );
          if (row === undefined) return null;
          return rowToDomain(row);
        },
      );
    },
    findByConversationIds(conversationIds) {
      if (conversationIds.length === 0) return [];
      return timed("findByConversationIds", {}, () => {
        const placeholders = conversationIds.map(() => "?").join(", ");
        const rows = db
          .prepare(
            `SELECT * FROM context_artifacts
              WHERE conversation_id IN (${placeholders})
              ORDER BY conversation_id ASC, kind ASC, message_index ASC`,
          )
          .all(...conversationIds) as unknown[];
        return rows.map(rowToDomain);
      });
    },
    findByScope(projectPath, sessionName) {
      return timed("findByScope", { projectPath, sessionName }, () => {
        const rows =
          sessionName === undefined
            ? (findByProjectStmt.all(projectPath) as unknown[])
            : (findBySessionStmt.all(projectPath, sessionName) as unknown[]);
        return rows.map(rowToDomain);
      });
    },
    upsert(row) {
      timed(
        "upsert",
        { id: row.id, conversationId: row.conversationId },
        () => {
          const validated = contextArtifactRowSchema.parse(row);
          upsertStmt.run({
            id: validated.id,
            ...serializeColumns(validated),
          });
        },
      );
    },
    updateChangedColumns(id, partial) {
      return timed("updateChangedColumns", { id }, () => {
        const columns = serializeColumns(partial);
        const sortedColumns = Object.keys(columns).sort();
        if (sortedColumns.length === 0) return false;
        const stmt = getUpdateColumnsStmt(sortedColumns);
        const info = stmt.run({ id, ...columns });
        return info.changes > 0;
      });
    },
    failPendingRuns(error, updatedAt) {
      return timed("failPendingRuns", {}, () => {
        const info = failPendingRunsStmt.run({
          error,
          updated_at: updatedAt,
        });
        if (info.changes > 0) {
          logger.info("state-store.context-artifacts.pending_runs_failed", {
            count: info.changes,
            error,
          });
        }
        return info.changes;
      });
    },
    deleteById(id) {
      return timed("deleteById", { id }, () => {
        const info = deleteByIdStmt.run(id);
        return info.changes > 0;
      });
    },
    deleteByConversation(conversationId) {
      return timed("deleteByConversation", { conversationId }, () => {
        const info = deleteByConversationStmt.run(conversationId);
        return info.changes;
      });
    },
    deleteByScope(projectPath, sessionName) {
      return timed("deleteByScope", { projectPath, sessionName }, () => {
        const info =
          sessionName === undefined
            ? deleteByProjectStmt.run(projectPath)
            : deleteBySessionStmt.run(projectPath, sessionName);
        return info.changes;
      });
    },
  };
}
