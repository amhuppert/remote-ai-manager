import type Database from "better-sqlite3";
import { z } from "zod";
import { createLogger } from "@/lib/logging";
import { conversationStateSchema } from "@/lib/conversations/schemas";
import {
  decodeSharedConversationColumns,
  encodeSharedConversationColumns,
  jsonOrNull,
  parseJsonColumn,
  stableStringify,
  throwConversationValidationError,
  type ChangedConversationColumns,
} from "./conversation-row-codec";
import { pendingQueuedMessageSchema } from "@/lib/conversations/message-queue-schemas";
import type {
  ConversationState,
  ConversationStatus,
} from "@/lib/conversations/schemas";
type Db = InstanceType<typeof Database>;

const logger = createLogger("state-store.conversations");

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
  machine_snapshot: z.string().nullable(),
  agent_backend: z.string(),
  backend_ref: z.string().nullable(),
  mcp_overrides: z.string().nullable(),
  mcp_runtime: z.string().nullable(),
  agent_capability_overrides: z.string().nullable(),
  agent_capabilities_runtime: z.string().nullable(),
  unread: z.union([z.literal(0), z.literal(1)]),
  pending_queue: z.string().nullable(),
  last_seen_alignment_version: z.number().int().nullable(),
});
type ConversationsTableRow = z.infer<typeof conversationsTableRowSchema>;

interface SqlBindRow {
  id: string;
  project_path: string;
  session_name: string;
  name: string | null;
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
  machine_snapshot: string | null;
  agent_backend: string;
  backend_ref: string | null;
  mcp_overrides: string | null;
  mcp_runtime: string | null;
  agent_capability_overrides: string | null;
  agent_capabilities_runtime: string | null;
  unread: number;
  pending_queue: string | null;
  last_seen_alignment_version: number | null;
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
    pending_queue: jsonOrNull(conversation.pendingQueue),
    last_seen_alignment_version: conversation.lastSeenAlignmentVersion,
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

const pendingQueueArraySchema = z.array(pendingQueuedMessageSchema);

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

  const pendingQueue = parseJsonColumn(
    "pendingQueue",
    row.pending_queue,
    pendingQueueArraySchema,
    "default",
    [],
  );
  if (!pendingQueue.ok) {
    return throwConversationValidationError(row.id, pendingQueue.issues);
  }

  const candidate: Record<string, unknown> = {
    id: row.id,
    ...decodeSharedConversationColumns(row.id, row),
    pendingQueue: pendingQueue.value ?? [],
    lastSeenAlignmentVersion: row.last_seen_alignment_version,
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
  "machine_snapshot",
  "agent_backend",
  "backend_ref",
  "mcp_overrides",
  "mcp_runtime",
  "agent_capability_overrides",
  "agent_capabilities_runtime",
  "unread",
  "pending_queue",
  "last_seen_alignment_version",
];

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
  const findAllCache = new Map<
    string,
    { rawRow: Record<string, unknown>; parsed: ParsedRow }
  >();
  let cacheVersion = 0;
  let lastFindAllVersion = -1;
  let lastFindAllResult: ParsedRow[] = [];
  // Per-session result memo (Pattern 3), keyed by
  // `${projectPath}\u0000${sessionName}` and invalidated by the shared monotonic
  // `cacheVersion`. Stores only the ordered row ids, not parsed rows, so it can
  // never keep a parsed conversation alive after `findAllCache` evicts it. On a
  // warm hit the ids resolve through `findAllCache` (the version gate guarantees
  // every id is still present — any delete bumps `cacheVersion`), and the result
  // is a FRESH array each call because callers such as getSessionConversations
  // sort it in place, so the array container must never be shared.
  const findBySessionCache = new Map<
    string,
    { version: number; ids: string[] }
  >();
  const findByIdStmt = db.prepare(
    `SELECT * FROM conversations WHERE id = ? LIMIT 1`,
  );
  const findByKeyStmt = db.prepare(
    `SELECT * FROM conversations
     WHERE project_path = ? AND session_name = ? AND id = ?
     LIMIT 1`,
  );
  const findBySessionStmt = db.prepare(
    `SELECT * FROM conversations
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
  const findAllStmt = db.prepare(
    `SELECT * FROM conversations
     ORDER BY project_path ASC, session_name ASC, created_at ASC, id ASC`,
  );
  // Conversation rows are leaf rows from the FK perspective, so OR REPLACE is
  // technically allowed; we use ON CONFLICT(id) DO UPDATE for codebase
  // consistency with the parent-row UPSERT rule (sessions/projects).
  const upsertStmt = db.prepare(
    `INSERT INTO conversations (
       id, project_path, session_name, name, transcript_path, status,
       prompt_count, created_at, last_activity_at, source, summary, archived,
       total_cost_usd, total_duration_ms, total_turns, pending_question_id,
       pending_questions, pending_prompt_text, forked_from, role, context_tokens, context_window_max,
       debug_mode, machine_snapshot, agent_backend, backend_ref,
       mcp_overrides, mcp_runtime, agent_capability_overrides, agent_capabilities_runtime,
       unread, pending_queue, last_seen_alignment_version
     ) VALUES (
       @id, @project_path, @session_name, @name, @transcript_path, @status,
       @prompt_count, @created_at, @last_activity_at, @source, @summary, @archived,
       @total_cost_usd, @total_duration_ms, @total_turns, @pending_question_id,
       @pending_questions, @pending_prompt_text, @forked_from, @role, @context_tokens, @context_window_max,
       @debug_mode, @machine_snapshot, @agent_backend, @backend_ref,
       @mcp_overrides, @mcp_runtime, @agent_capability_overrides, @agent_capabilities_runtime,
       @unread, @pending_queue, @last_seen_alignment_version
     )
     ON CONFLICT(id) DO UPDATE SET
       project_path               = excluded.project_path,
       session_name               = excluded.session_name,
       name                       = excluded.name,
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
       machine_snapshot           = excluded.machine_snapshot,
       agent_backend              = excluded.agent_backend,
       backend_ref                = excluded.backend_ref,
       mcp_overrides              = excluded.mcp_overrides,
       mcp_runtime                = excluded.mcp_runtime,
       agent_capability_overrides = excluded.agent_capability_overrides,
       agent_capabilities_runtime = excluded.agent_capabilities_runtime,
       unread                     = excluded.unread,
       pending_queue              = excluded.pending_queue,
       last_seen_alignment_version = excluded.last_seen_alignment_version`,
  );
  const deleteStmt = db.prepare(`DELETE FROM conversations WHERE id = ?`);
  const setPendingPromptTextStmt = db.prepare(
    `UPDATE conversations
     SET pending_prompt_text = ?
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
        if (memo !== undefined && memo.version === cacheVersion) {
          return memo.ids.map(
            (id) => findAllCache.get(id)!.parsed.conversation,
          );
        }
        const rows = findBySessionStmt.all(projectPath, sessionName) as Array<
          Record<string, unknown>
        >;
        const ids: string[] = new Array(rows.length);
        const conversations: ConversationState[] = new Array(rows.length);
        for (let i = 0; i < rows.length; i += 1) {
          const row = rows[i]!;
          const id = row.id as string;
          ids[i] = id;
          const cached = findAllCache.get(id);
          if (cached !== undefined && rawRowsEqual(cached.rawRow, row)) {
            conversations[i] = cached.parsed.conversation;
            continue;
          }
          const parsed = rowToDomain(row);
          findAllCache.set(id, { rawRow: row, parsed });
          conversations[i] = parsed.conversation;
        }
        findBySessionCache.set(cacheKey, { version: cacheVersion, ids });
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
    findAll() {
      return timed("findAll", {}, () => {
        if (cacheVersion === lastFindAllVersion) {
          return lastFindAllResult;
        }
        const rows = findAllStmt.all() as Array<Record<string, unknown>>;
        const out: ParsedRow[] = new Array(rows.length);
        const seenIds = new Set<string>();
        for (let i = 0; i < rows.length; i += 1) {
          const row = rows[i]!;
          const id = row.id as string;
          seenIds.add(id);
          const cached = findAllCache.get(id);
          if (cached !== undefined && rawRowsEqual(cached.rawRow, row)) {
            out[i] = cached.parsed;
            continue;
          }
          const parsed = rowToDomain(row);
          findAllCache.set(id, { rawRow: row, parsed });
          out[i] = parsed;
        }
        if (findAllCache.size > seenIds.size) {
          for (const id of findAllCache.keys()) {
            if (!seenIds.has(id)) findAllCache.delete(id);
          }
        }
        lastFindAllVersion = cacheVersion;
        lastFindAllResult = out;
        return out;
      });
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
        upsertStmt.run(bind);
        cacheVersion += 1;
      });
    },
    delete(id) {
      timed("delete", { id }, () => {
        deleteStmt.run(id);
        findAllCache.delete(id);
        cacheVersion += 1;
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
          upsertWithSessionTouchTxn.immediate(bind, lastActivityAt);
          cacheVersion += 1;
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
          updateChangedColumnsWithSessionTouchTxn.immediate(
            stmt,
            bind,
            projectPath,
            sessionName,
            lastActivityAt,
          );
          cacheVersion += 1;
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
          stmt.run(bind);
          cacheVersion += 1;
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
          if (changed) cacheVersion += 1;
          return changed;
        },
      );
    },
  };
}
