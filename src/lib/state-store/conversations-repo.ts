import type Database from "better-sqlite3";
import { z } from "zod";
import { createLogger } from "@/lib/logging";
import { createVersionedRowCache } from "@/lib/shared/versioned-row-cache";
import { conversationStateSchema } from "@/lib/conversations/schemas";
import {
  decodeConversationListItemColumns,
  decodeSharedConversationColumns,
  encodeSharedConversationColumns,
  stableStringify,
  throwConversationValidationError,
  type ChangedConversationColumns,
  type ConversationListItemFields,
  type ConversationListItemRawColumns,
} from "./conversation-row-codec";
import type {
  ConversationState,
  ConversationStatus,
} from "@/lib/conversations/schemas";
import { checkRowColumnSizes } from "./row-size-telemetry";
type Db = InstanceType<typeof Database>;

const logger = createLogger("state-store.conversations");

/**
 * Identity-tier projection of a conversation row: key columns plus `status`,
 * with no blob columns and no heavy Zod parse. Serves callers that need
 * conversation identity tuples across the whole store (e.g. MCP runtime-target
 * listing) rather than any conversation's full state.
 */
export interface ConversationIdentity {
  id: string;
  projectPath: string;
  sessionName: string;
  status: ConversationStatus;
}

/**
 * List-item-tier projection of a conversation: identity/location columns plus
 * the display and small-structured fields list surfaces render, with no heavy
 * blob columns pulled or parsed. Serves the cross-project conversation lists
 * (autocomplete list, active-conversations feed).
 */
export interface ConversationListItemProjection extends ConversationListItemFields {
  id: string;
  projectPath: string;
  sessionName: string;
}

/**
 * The serialized-JSON columns of a `conversations` row that can grow unbounded
 * enough to matter — the machine-snapshot resume token now lives in a sidecar,
 * so these are the remaining big blobs. Row-size telemetry sweeps them on write
 * so a ballooning column surfaces as a `state-store.row_size.exceeded` finding.
 */
/**
 * The redacted profile identity, extracted in SQL for the list-item tier.
 *
 * `profile_snapshot` carries the profile's instruction text and rendered block,
 * so a list read that selected the column would pull every conversation's
 * instructions into the process on every feed poll — and put them one careless
 * spread away from a response body. Extracting the six safe scalars keeps the
 * projection blob-free and leaves the instruction bytes in SQLite.
 */
const PROFILE_IDENTITY_SELECT = `
  json_extract(profile_snapshot, '$.tier') AS profile_tier,
  json_extract(profile_snapshot, '$.id') AS profile_id,
  json_extract(profile_snapshot, '$.name') AS profile_name,
  json_extract(profile_snapshot, '$.revision') AS profile_revision,
  json_extract(profile_snapshot, '$.sourceContentHash') AS profile_source_content_hash,
  json_extract(profile_snapshot, '$.resolvedInstructionHash') AS profile_resolved_instruction_hash`;

const CONVERSATION_JSON_COLUMNS = [
  "pending_queue",
  "mcp_runtime",
  "agent_capabilities_runtime",
  "mcp_overrides",
  "agent_capability_overrides",
  "debug_mode",
  "pending_questions",
  "pending_agent_notices",
  "profile_snapshot",
] as const;

export interface ConversationsRepo {
  findById(id: string): ConversationState | null;
  findByIdWithKey(id: string): {
    projectPath: string;
    sessionName: string;
    conversation: ConversationState;
  } | null;
  findByKey(
    projectPath: string,
    sessionName: string,
    conversationId: string,
  ): ConversationState | null;
  findBySession(projectPath: string, sessionName: string): ConversationState[];
  countBySession(projectPath: string, sessionName: string): number;
  findListItemsForProject(projectPath: string): Array<{
    id: string;
    sessionName: string;
    status: ConversationStatus;
    promptCount: number;
    lastActivityAt: string;
  }>;
  findAllIdentities(): ConversationIdentity[];
  findAllListItems(): ConversationListItemProjection[];
  findAll(): {
    projectPath: string;
    sessionName: string;
    conversation: ConversationState;
  }[];
  upsert(
    projectPath: string,
    sessionName: string,
    conversation: ConversationState,
  ): void;
  delete(id: string): void;
  upsertWithSessionTouch(
    projectPath: string,
    sessionName: string,
    conversation: ConversationState,
    lastActivityAt: string,
  ): void;
  /**
   * Per-column update of one existing conversation row plus the session
   * `last_activity_at` touch, in one transaction. Writes only the columns in
   * `changedColumns` (column-name → already-serialized bind value) and always
   * sets the row's `last_activity_at`, so co-located large columns
   * (`machine_snapshot`, `pending_queue`, runtime blobs) are neither
   * re-serialized nor re-written when their source field did not change. The
   * row must already exist; a missing row writes nothing.
   */
  updateChangedColumnsWithSessionTouch(
    projectPath: string,
    sessionName: string,
    conversationId: string,
    changedColumns: ChangedConversationColumns,
    lastActivityAt: string,
  ): void;
  /**
   * Per-column update of one existing conversation row WITHOUT touching the
   * conversation's own `last_activity_at` or the session row. Writes only the
   * columns in `changedColumns`. Used when an edit to a child conversation flows
   * through a session-level mutate: a config change on the session must not
   * silently restamp child-conversation activity, so the caller owns the
   * timestamp. The row must already exist; a missing row writes nothing.
   */
  updateChangedColumns(
    projectPath: string,
    sessionName: string,
    conversationId: string,
    changedColumns: ChangedConversationColumns,
  ): void;
  setPendingPromptText(
    projectPath: string,
    sessionName: string,
    conversationId: string,
    text: string | null,
  ): boolean;
  /**
   * Focused single-column clear of `backend_ref`, leaving the conversation's
   * activity timestamp untouched: retiring a runtime is not conversation
   * activity and must not reorder the list. Synchronous and statement-level so
   * a caller that must clear the reference and record WHY in the same commit
   * can run both inside one transaction. Returns whether a row matched.
   */
  clearBackendRef(
    projectPath: string,
    sessionName: string,
    conversationId: string,
  ): boolean;
  /**
   * Invalidate the parsed-row cache after conversation rows were removed
   * out-of-band — an FK `ON DELETE CASCADE` from a session/project delete drops
   * the rows at the SQL layer without routing through this repo's own `delete`.
   * Bumps the version so `findAll`/`findBySession` re-read from SQLite instead
   * of serving evicted rows from a warm cache.
   */
  invalidateCache(): void;
}

/**
 * Raw column shape for `SELECT * FROM conversations`. Validated at the
 * persistence boundary so corrupt values trip a Zod safeParse failure rather
 * than being silently coerced.
 */
const conversationsTableRowSchema = z.object({
  id: z.string(),
  project_path: z.string(),
  session_name: z.string(),
  name: z.string().nullable(),
  name_origin: z.string(),
  transcript_path: z.string().nullable(),
  status: z.string(),
  prompt_count: z.number().int(),
  created_at: z.string(),
  last_activity_at: z.string(),
  source: z.string(),
  summary: z.string().nullable(),
  archived: z.union([z.literal(0), z.literal(1)]),
  total_cost_usd: z.number().nullable(),
  total_duration_ms: z.number().int().nullable(),
  total_turns: z.number().int().nullable(),
  pending_question_id: z.string().nullable(),
  pending_questions: z.string().nullable(),
  pending_prompt_text: z.string().nullable(),
  forked_from: z.string().nullable(),
  role: z.string().nullable(),
  context_tokens: z.number().int().nullable(),
  context_window_max: z.number().int().nullable(),
  debug_mode: z.string().nullable(),
  agent_backend: z.string(),
  backend_ref: z.string().nullable(),
  mcp_overrides: z.string().nullable(),
  mcp_runtime: z.string().nullable(),
  agent_capability_overrides: z.string().nullable(),
  agent_capabilities_runtime: z.string().nullable(),
  unread: z.union([z.literal(0), z.literal(1)]),
  pending_queue: z.string().nullable(),
  last_seen_alignment_version: z.number().int().nullable(),
  pending_agent_notices: z.string().nullable(),
  profile_snapshot: z.string().nullable(),
  profile_locked_at: z.string().nullable(),
  conversation_owner: z.string().nullable(),
  turn_generation: z.number().int(),
});
type ConversationsTableRow = z.infer<typeof conversationsTableRowSchema>;

interface SqlBindRow {
  id: string;
  project_path: string;
  session_name: string;
  name: string | null;
  name_origin: string;
  transcript_path: string | null;
  status: string;
  prompt_count: number;
  created_at: string;
  last_activity_at: string;
  source: string;
  summary: string | null;
  archived: number;
  total_cost_usd: number | null;
  total_duration_ms: number | null;
  total_turns: number | null;
  pending_question_id: string | null;
  pending_questions: string | null;
  pending_prompt_text: string | null;
  forked_from: string | null;
  role: string | null;
  context_tokens: number | null;
  context_window_max: number | null;
  debug_mode: string | null;
  agent_backend: string;
  backend_ref: string | null;
  mcp_overrides: string | null;
  mcp_runtime: string | null;
  agent_capability_overrides: string | null;
  agent_capabilities_runtime: string | null;
  unread: number;
  pending_queue: string | null;
  last_seen_alignment_version: number | null;
  pending_agent_notices: string | null;
  profile_snapshot: string | null;
  profile_locked_at: string | null;
  conversation_owner: string | null;
  turn_generation: number;
}

/**
 * Encode a validated ConversationState as the column-name → SQLite-primitive
 * bind record used by both `domainToConversationRow` and
 * `canonicalConversationRow`. The shared columns are produced by the codec; the
 * identity columns are added here.
 */
function conversationToSqlBind(
  projectPath: string,
  sessionName: string,
  conversation: ConversationState,
): SqlBindRow {
  return {
    id: conversation.id,
    project_path: projectPath,
    session_name: sessionName,
    ...encodeSharedConversationColumns(conversation),
  };
}

function domainToConversationRow(
  projectPath: string,
  sessionName: string,
  conversation: ConversationState,
): SqlBindRow {
  const validated = conversationStateSchema.parse(conversation);
  return conversationToSqlBind(projectPath, sessionName, validated);
}

export function canonicalConversationRow(
  projectPath: string,
  sessionName: string,
  conversation: ConversationState,
): string {
  const validated = conversationStateSchema.parse(conversation);
  return stableStringify(
    conversationToSqlBind(projectPath, sessionName, validated),
  );
}

function rowToDomain(rawRow: unknown): {
  projectPath: string;
  sessionName: string;
  conversation: ConversationState;
} {
  const fallbackId =
    typeof rawRow === "object" &&
    rawRow !== null &&
    typeof (rawRow as { id?: unknown }).id === "string"
      ? (rawRow as { id: string }).id
      : "<unknown>";

  const rowResult = conversationsTableRowSchema.safeParse(rawRow);
  if (!rowResult.success) {
    return throwConversationValidationError(fallbackId, rowResult.error.issues);
  }
  const row: ConversationsTableRow = rowResult.data;

  const candidate: Record<string, unknown> = {
    id: row.id,
    ...decodeSharedConversationColumns(row.id, row),
  };

  const result = conversationStateSchema.safeParse(candidate);
  if (!result.success) {
    return throwConversationValidationError(row.id, result.error.issues);
  }
  return {
    projectPath: row.project_path,
    sessionName: row.session_name,
    conversation: result.data,
  };
}

function timed<T>(
  op: string,
  identifier: { id?: string; projectPath?: string; sessionName?: string },
  fn: () => T,
): T {
  const start = performance.now();
  try {
    return fn();
  } finally {
    const durationMs = +(performance.now() - start).toFixed(3);
    const payload: Record<string, unknown> = { durationMs };
    if (identifier.id !== undefined) payload.conversationId = identifier.id;
    if (identifier.projectPath !== undefined) {
      payload.projectPath = identifier.projectPath;
    }
    if (identifier.sessionName !== undefined) {
      payload.sessionName = identifier.sessionName;
    }
    logger.info(`state-store.conversations.${op}.timing`, payload);
  }
}

const CONVERSATION_COLUMN_KEYS: ReadonlyArray<keyof ConversationsTableRow> = [
  "id",
  "project_path",
  "session_name",
  "name",
  "name_origin",
  "transcript_path",
  "status",
  "prompt_count",
  "created_at",
  "last_activity_at",
  "source",
  "summary",
  "archived",
  "total_cost_usd",
  "total_duration_ms",
  "total_turns",
  "pending_question_id",
  "pending_questions",
  "pending_prompt_text",
  "forked_from",
  "role",
  "context_tokens",
  "context_window_max",
  "debug_mode",
  "agent_backend",
  "backend_ref",
  "mcp_overrides",
  "mcp_runtime",
  "agent_capability_overrides",
  "agent_capabilities_runtime",
  "unread",
  "pending_queue",
  "last_seen_alignment_version",
  "pending_agent_notices",
  "profile_snapshot",
  "profile_locked_at",
  "conversation_owner",
  "turn_generation",
];

/**
 * Explicit projection for every read statement. The `machine_snapshot` column
 * still exists on the row (nulled by migration 0007, kept for forward-compat)
 * but the snapshot now lives in the `conversation_machine_snapshots` sidecar, so
 * no hot enumeration (`findAll` / `findBySession` / `findByKey` / `findById`) may
 * drag its bytes: every read selects this explicit column list, never `*`.
 */
const CONVERSATION_SELECT_COLUMNS = CONVERSATION_COLUMN_KEYS.join(", ");

function rawRowsEqual(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
): boolean {
  for (const key of CONVERSATION_COLUMN_KEYS) {
    if (a[key] !== b[key]) return false;
  }
  return true;
}

export function createConversationsRepo(db: Db): ConversationsRepo {
  type ParsedRow = {
    projectPath: string;
    sessionName: string;
    conversation: ConversationState;
  };
  const cache = createVersionedRowCache<
    string,
    Record<string, unknown>,
    ParsedRow
  >({
    keyOf: (row) => row.id as string,
    rowsEqual: rawRowsEqual,
    parse: rowToDomain,
  });
  // Per-session result memo (Pattern 3), keyed by
  // `${projectPath}\u0000${sessionName}` and invalidated by the shared row
  // cache's monotonic version. Stores only the ordered row ids, not parsed
  // rows, so it can never keep a parsed conversation alive after the row cache
  // evicts it. On a warm hit the ids resolve through the shared cache (the
  // version gate guarantees every id is still present — any delete bumps the
  // version), and the result is a FRESH array each call because callers such
  // as getSessionConversations
  // sort it in place, so the array container must never be shared.
  const findBySessionCache = new Map<
    string,
    { version: number; ids: string[] }
  >();
  const findByIdStmt = db.prepare(
    `SELECT ${CONVERSATION_SELECT_COLUMNS} FROM conversations WHERE id = ? LIMIT 1`,
  );
  const findByKeyStmt = db.prepare(
    `SELECT ${CONVERSATION_SELECT_COLUMNS} FROM conversations
     WHERE project_path = ? AND session_name = ? AND id = ?
     LIMIT 1`,
  );
  const findBySessionStmt = db.prepare(
    `SELECT ${CONVERSATION_SELECT_COLUMNS} FROM conversations
     WHERE project_path = ? AND session_name = ?
     ORDER BY created_at ASC, id ASC`,
  );
  const countBySessionStmt = db.prepare(
    `SELECT COUNT(*) AS n FROM conversations
     WHERE project_path = ? AND session_name = ?`,
  );
  const findListItemsForProjectStmt = db.prepare(
    `SELECT id, session_name, status, prompt_count, last_activity_at
     FROM conversations
     WHERE project_path = ?`,
  );
  const findAllIdentitiesStmt = db.prepare(
    `SELECT id, project_path, session_name, status
     FROM conversations
     ORDER BY project_path ASC, session_name ASC, created_at ASC, id ASC`,
  );
  const findAllListItemsStmt = db.prepare(
    `SELECT id, project_path, session_name, name, summary, status, role,
            archived, agent_backend, backend_ref, transcript_path,
            last_activity_at, debug_mode, pending_question_id, pending_questions,
            forked_from, unread,
            ${PROFILE_IDENTITY_SELECT}
     FROM conversations
     ORDER BY project_path ASC, session_name ASC, created_at ASC, id ASC`,
  );
  const findAllStmt = db.prepare(
    `SELECT ${CONVERSATION_SELECT_COLUMNS} FROM conversations
     ORDER BY project_path ASC, session_name ASC, created_at ASC, id ASC`,
  );
  // Conversation rows are leaf rows from the FK perspective, so OR REPLACE is
  // technically allowed; we use ON CONFLICT(id) DO UPDATE for codebase
  // consistency with the parent-row UPSERT rule (sessions/projects).
  const upsertStmt = db.prepare(
    `INSERT INTO conversations (
       id, project_path, session_name, name, name_origin, transcript_path, status,
       prompt_count, created_at, last_activity_at, source, summary, archived,
       total_cost_usd, total_duration_ms, total_turns, pending_question_id,
       pending_questions, pending_prompt_text, forked_from, role, context_tokens, context_window_max,
       debug_mode, agent_backend, backend_ref,
       mcp_overrides, mcp_runtime, agent_capability_overrides, agent_capabilities_runtime,
       unread, pending_queue, last_seen_alignment_version, pending_agent_notices,
       profile_snapshot, profile_locked_at, conversation_owner, turn_generation
     ) VALUES (
       @id, @project_path, @session_name, @name, @name_origin, @transcript_path, @status,
       @prompt_count, @created_at, @last_activity_at, @source, @summary, @archived,
       @total_cost_usd, @total_duration_ms, @total_turns, @pending_question_id,
       @pending_questions, @pending_prompt_text, @forked_from, @role, @context_tokens, @context_window_max,
       @debug_mode, @agent_backend, @backend_ref,
       @mcp_overrides, @mcp_runtime, @agent_capability_overrides, @agent_capabilities_runtime,
       @unread, @pending_queue, @last_seen_alignment_version, @pending_agent_notices,
       @profile_snapshot, @profile_locked_at, @conversation_owner, @turn_generation
     )
     ON CONFLICT(id) DO UPDATE SET
       project_path               = excluded.project_path,
       session_name               = excluded.session_name,
       name                       = excluded.name,
       name_origin                = excluded.name_origin,
       transcript_path            = excluded.transcript_path,
       status                     = excluded.status,
       prompt_count               = excluded.prompt_count,
       created_at                 = excluded.created_at,
       last_activity_at           = excluded.last_activity_at,
       source                     = excluded.source,
       summary                    = excluded.summary,
       archived                   = excluded.archived,
       total_cost_usd             = excluded.total_cost_usd,
       total_duration_ms          = excluded.total_duration_ms,
       total_turns                = excluded.total_turns,
       pending_question_id        = excluded.pending_question_id,
       pending_questions          = excluded.pending_questions,
       pending_prompt_text        = excluded.pending_prompt_text,
       forked_from                = excluded.forked_from,
       role                       = excluded.role,
       context_tokens             = excluded.context_tokens,
       context_window_max         = excluded.context_window_max,
       debug_mode                 = excluded.debug_mode,
       agent_backend              = excluded.agent_backend,
       backend_ref                = excluded.backend_ref,
       mcp_overrides              = excluded.mcp_overrides,
       mcp_runtime                = excluded.mcp_runtime,
       agent_capability_overrides = excluded.agent_capability_overrides,
       agent_capabilities_runtime = excluded.agent_capabilities_runtime,
       unread                     = excluded.unread,
       pending_queue              = excluded.pending_queue,
       last_seen_alignment_version = excluded.last_seen_alignment_version,
       pending_agent_notices      = excluded.pending_agent_notices,
       profile_snapshot           = excluded.profile_snapshot,
       profile_locked_at          = excluded.profile_locked_at,
       conversation_owner         = excluded.conversation_owner,
       turn_generation            = excluded.turn_generation`,
  );
  // The machine snapshot lives in the owner-discriminated sidecar table, not on
  // the conversation row. Its cleanup is DB-enforced by the AFTER DELETE trigger
  // on `conversations` (see SCHEMA_DDL): it fires inside this DELETE's
  // transaction and also covers the FK CASCADE path (deleting a session/project)
  // that never calls this method — so a single canonical owner cleans the
  // sidecar for every delete path.
  const deleteStmt = db.prepare(`DELETE FROM conversations WHERE id = ?`);
  const setPendingPromptTextStmt = db.prepare(
    `UPDATE conversations
     SET pending_prompt_text = ?
     WHERE project_path = ? AND session_name = ? AND id = ?`,
  );
  const clearBackendRefStmt = db.prepare(
    `UPDATE conversations
     SET backend_ref = NULL
     WHERE project_path = ? AND session_name = ? AND id = ?`,
  );
  const sessionTouchStmt = db.prepare(
    `UPDATE sessions
     SET last_activity_at = ?
     WHERE project_path = ? AND session_name = ?`,
  );

  const upsertWithSessionTouchTxn = db.transaction(
    (bind: SqlBindRow, lastActivityAt: string) => {
      upsertStmt.run(bind);
      sessionTouchStmt.run(
        lastActivityAt,
        bind.project_path,
        bind.session_name,
      );
    },
  );

  // Per-column-set prepared statements for the focused update path, keyed by the
  // sorted, comma-joined changed-column list so repeated mutation shapes (status
  // toggles, unread flips, pending_queue claims, machine_snapshot saves) reuse
  // one prepared statement. Bounded by the small number of distinct shapes seen
  // in practice. Each statement always sets `last_activity_at` in addition to
  // the changed columns. Bind params are named: the changed-column values plus
  // `@last_activity_at`, `@project_path`, `@session_name`, `@id`.
  const updateColumnsStmtCache = new Map<
    string,
    ReturnType<typeof db.prepare>
  >();
  function getUpdateColumnsStmt(
    sortedColumns: readonly string[],
  ): ReturnType<typeof db.prepare> {
    const cacheKey = sortedColumns.join(",");
    const cached = updateColumnsStmtCache.get(cacheKey);
    if (cached !== undefined) return cached;
    const assignments = [
      ...sortedColumns.map((col) => `${col} = @${col}`),
      `last_activity_at = @last_activity_at`,
    ].join(", ");
    const stmt = db.prepare(
      `UPDATE conversations SET ${assignments}
       WHERE project_path = @project_path AND session_name = @session_name AND id = @id`,
    );
    updateColumnsStmtCache.set(cacheKey, stmt);
    return stmt;
  }

  const updateChangedColumnsWithSessionTouchTxn = db.transaction(
    (
      stmt: ReturnType<typeof db.prepare>,
      bind: Record<string, string | number | null>,
      projectPath: string,
      sessionName: string,
      lastActivityAt: string,
    ) => {
      stmt.run(bind);
      sessionTouchStmt.run(lastActivityAt, projectPath, sessionName);
    },
  );

  // No-touch sibling of `getUpdateColumnsStmt`: updates only the changed columns
  // and never sets `last_activity_at`. Keyed by the same sorted-column cache key.
  const updateColumnsNoTouchStmtCache = new Map<
    string,
    ReturnType<typeof db.prepare>
  >();
  function getUpdateColumnsNoTouchStmt(
    sortedColumns: readonly string[],
  ): ReturnType<typeof db.prepare> {
    const cacheKey = sortedColumns.join(",");
    const cached = updateColumnsNoTouchStmtCache.get(cacheKey);
    if (cached !== undefined) return cached;
    const assignments = sortedColumns
      .map((col) => `${col} = @${col}`)
      .join(", ");
    const stmt = db.prepare(
      `UPDATE conversations SET ${assignments}
       WHERE project_path = @project_path AND session_name = @session_name AND id = @id`,
    );
    updateColumnsNoTouchStmtCache.set(cacheKey, stmt);
    return stmt;
  }

  return {
    findById(id) {
      return timed("findById", { id }, () => {
        const row: unknown = findByIdStmt.get(id);
        if (row === undefined) return null;
        return rowToDomain(row).conversation;
      });
    },
    findByIdWithKey(id) {
      return timed("findByIdWithKey", { id }, () => {
        const row: unknown = findByIdStmt.get(id);
        if (row === undefined) return null;
        return rowToDomain(row);
      });
    },
    findByKey(projectPath, sessionName, conversationId) {
      return timed(
        "findByKey",
        { projectPath, sessionName, id: conversationId },
        () => {
          const row: unknown = findByKeyStmt.get(
            projectPath,
            sessionName,
            conversationId,
          );
          if (row === undefined) return null;
          return rowToDomain(row).conversation;
        },
      );
    },
    findBySession(projectPath, sessionName) {
      return timed("findBySession", { projectPath, sessionName }, () => {
        const cacheKey = `${projectPath}\u0000${sessionName}`;
        const memo = findBySessionCache.get(cacheKey);
        if (memo !== undefined && memo.version === cache.version) {
          return memo.ids.map(
            (id) => cache.getParsedByKey(id)!.parsed.conversation,
          );
        }
        const rows = findBySessionStmt.all(projectPath, sessionName) as Array<
          Record<string, unknown>
        >;
        const ids: string[] = new Array(rows.length);
        const conversations: ConversationState[] = new Array(rows.length);
        for (let i = 0; i < rows.length; i += 1) {
          const row = rows[i]!;
          ids[i] = row.id as string;
          conversations[i] = cache.resolveRow(row).conversation;
        }
        findBySessionCache.set(cacheKey, { version: cache.version, ids });
        return conversations;
      });
    },
    findListItemsForProject(projectPath) {
      return timed("findListItemsForProject", { projectPath }, () => {
        const rows = findListItemsForProjectStmt.all(projectPath) as Array<{
          id: string;
          session_name: string;
          status: ConversationStatus;
          prompt_count: number;
          last_activity_at: string;
        }>;
        return rows.map((row) => ({
          id: row.id,
          sessionName: row.session_name,
          status: row.status,
          promptCount: row.prompt_count,
          lastActivityAt: row.last_activity_at,
        }));
      });
    },
    findAllIdentities() {
      return timed("findAllIdentities", {}, () => {
        const rows = findAllIdentitiesStmt.all() as Array<{
          id: string;
          project_path: string;
          session_name: string;
          status: ConversationStatus;
        }>;
        return rows.map((row) => ({
          id: row.id,
          projectPath: row.project_path,
          sessionName: row.session_name,
          status: row.status,
        }));
      });
    },
    findAllListItems() {
      return timed("findAllListItems", {}, () => {
        const rows = findAllListItemsStmt.all() as Array<
          {
            id: string;
            project_path: string;
            session_name: string;
          } & ConversationListItemRawColumns
        >;
        return rows.map((row) => ({
          id: row.id,
          projectPath: row.project_path,
          sessionName: row.session_name,
          ...decodeConversationListItemColumns(row.id, row),
        }));
      });
    },
    findAll() {
      return timed("findAll", {}, () =>
        cache.readAll(
          () => findAllStmt.all() as Array<Record<string, unknown>>,
        ),
      );
    },
    countBySession(projectPath, sessionName) {
      return timed("countBySession", { projectPath, sessionName }, () => {
        const row = countBySessionStmt.get(projectPath, sessionName) as {
          n: number;
        };
        return row.n;
      });
    },
    upsert(projectPath, sessionName, conversation) {
      timed("upsert", { id: conversation.id, projectPath, sessionName }, () => {
        const bind = domainToConversationRow(
          projectPath,
          sessionName,
          conversation,
        );
        checkRowColumnSizes({
          logger,
          table: "conversations",
          id: conversation.id,
          bind: { ...bind },
          columns: CONVERSATION_JSON_COLUMNS,
        });
        upsertStmt.run(bind);
        cache.bump();
      });
    },
    delete(id) {
      timed("delete", { id }, () => {
        deleteStmt.run(id);
        cache.evict(id);
        cache.bump();
      });
    },
    upsertWithSessionTouch(
      projectPath,
      sessionName,
      conversation,
      lastActivityAt,
    ) {
      timed(
        "upsertWithSessionTouch",
        { id: conversation.id, projectPath, sessionName },
        () => {
          const bind = domainToConversationRow(
            projectPath,
            sessionName,
            conversation,
          );
          checkRowColumnSizes({
            logger,
            table: "conversations",
            id: conversation.id,
            bind: { ...bind },
            columns: CONVERSATION_JSON_COLUMNS,
          });
          upsertWithSessionTouchTxn.immediate(bind, lastActivityAt);
          cache.bump();
        },
      );
    },
    updateChangedColumnsWithSessionTouch(
      projectPath,
      sessionName,
      conversationId,
      changedColumns,
      lastActivityAt,
    ) {
      timed(
        "updateChangedColumnsWithSessionTouch",
        { id: conversationId, projectPath, sessionName },
        () => {
          const sortedColumns = Object.keys(changedColumns).sort();
          const stmt = getUpdateColumnsStmt(sortedColumns);
          const bind: Record<string, string | number | null> = {
            project_path: projectPath,
            session_name: sessionName,
            id: conversationId,
            last_activity_at: lastActivityAt,
          };
          for (const col of sortedColumns) {
            bind[col] = changedColumns[col]!;
          }
          checkRowColumnSizes({
            logger,
            table: "conversations",
            id: conversationId,
            bind,
            columns: CONVERSATION_JSON_COLUMNS,
          });
          updateChangedColumnsWithSessionTouchTxn.immediate(
            stmt,
            bind,
            projectPath,
            sessionName,
            lastActivityAt,
          );
          cache.bump();
        },
      );
    },
    updateChangedColumns(
      projectPath,
      sessionName,
      conversationId,
      changedColumns,
    ) {
      timed(
        "updateChangedColumns",
        { id: conversationId, projectPath, sessionName },
        () => {
          const sortedColumns = Object.keys(changedColumns).sort();
          if (sortedColumns.length === 0) return;
          const stmt = getUpdateColumnsNoTouchStmt(sortedColumns);
          const bind: Record<string, string | number | null> = {
            project_path: projectPath,
            session_name: sessionName,
            id: conversationId,
          };
          for (const col of sortedColumns) {
            bind[col] = changedColumns[col]!;
          }
          checkRowColumnSizes({
            logger,
            table: "conversations",
            id: conversationId,
            bind,
            columns: CONVERSATION_JSON_COLUMNS,
          });
          stmt.run(bind);
          cache.bump();
        },
      );
    },
    setPendingPromptText(projectPath, sessionName, conversationId, text) {
      return timed(
        "setPendingPromptText",
        { id: conversationId, projectPath, sessionName },
        () => {
          const info = setPendingPromptTextStmt.run(
            text,
            projectPath,
            sessionName,
            conversationId,
          );
          const changed = info.changes > 0;
          if (changed) cache.bump();
          return changed;
        },
      );
    },
    clearBackendRef(projectPath, sessionName, conversationId) {
      return timed(
        "clearBackendRef",
        { id: conversationId, projectPath, sessionName },
        () => {
          const info = clearBackendRefStmt.run(
            projectPath,
            sessionName,
            conversationId,
          );
          const changed = info.changes > 0;
          if (changed) cache.bump();
          return changed;
        },
      );
    },
    invalidateCache() {
      cache.bump();
    },
  };
}
