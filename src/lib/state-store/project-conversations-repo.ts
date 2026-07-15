import type Database from "better-sqlite3";
import { z } from "zod";
import { createLogger } from "@/lib/logging";
import { createVersionedRowCache } from "@/lib/shared/versioned-row-cache";
import { conversationStateSchema } from "@/lib/conversations/schemas";
import {
  decodeSharedConversationColumns,
  encodeSharedConversationColumns,
  jsonOrNull,
  parseJsonColumn,
  throwConversationValidationError,
} from "./conversation-row-codec";
import type { ConversationState } from "@/lib/conversations/schemas";

type Db = InstanceType<typeof Database>;

const logger = createLogger("state-store.project-conversations");

/**
 * Persistence for session-less project conversations. Keyed `(project_path,
 * id)` — there is no `session_name`. Rows decode with `scope:"project"` and an
 * explicit `open` lifecycle flag (the project-only column). Mirrors the
 * `conversations` repo's parsed-row cache + monotonic `cacheVersion`
 * invalidation (PERFORMANCE.md Pattern 3).
 */
export interface ProjectConversationsRepo {
  findById(id: string): ConversationState | null;
  findByKey(projectPath: string, id: string): ConversationState | null;
  findByProject(projectPath: string): ConversationState[];
  findAll(): { projectPath: string; conversation: ConversationState }[];
  upsert(projectPath: string, conversation: ConversationState): void;
  delete(id: string): void;
  setPendingPromptText(
    projectPath: string,
    id: string,
    text: string | null,
  ): boolean;
  setArchived(projectPath: string, id: string, archived: boolean): boolean;
  setOpen(projectPath: string, id: string, open: boolean): boolean;
  /**
   * Append session names to the PLC's `spawnedSessionIds` back-link, de-duped
   * and order-preserving. Focused single-row read-modify-write (Pattern 2: no
   * whole-state read). Returns whether the row exists / was updated.
   */
  appendSpawnedSessionIds(
    projectPath: string,
    id: string,
    sessionNames: string[],
  ): boolean;
}

/**
 * Raw column shape for `SELECT * FROM project_conversations`. Same as the
 * `conversations` row minus `session_name`, plus `open`.
 */
const projectConversationsTableRowSchema = z.object({
  id: z.string(),
  project_path: z.string(),
  name: z.string().nullable(),
  transcript_path: z.string().nullable(),
  status: z.string(),
  prompt_count: z.number().int(),
  created_at: z.string(),
  last_activity_at: z.string(),
  source: z.string(),
  summary: z.string().nullable(),
  archived: z.union([z.literal(0), z.literal(1)]),
  open: z.union([z.literal(0), z.literal(1)]),
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
  spawned_session_ids: z.string().nullable(),
  pending_queue: z.string().nullable(),
  last_seen_alignment_version: z.number().int().nullable(),
  pending_agent_notices: z.string().nullable(),
});
type ProjectConversationsTableRow = z.infer<
  typeof projectConversationsTableRowSchema
>;

const spawnedSessionIdsArraySchema = z.array(z.string());

interface ProjectSqlBindRow {
  id: string;
  project_path: string;
  open: number;
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
  spawned_session_ids: string | null;
  pending_queue: string | null;
  last_seen_alignment_version: number | null;
  pending_agent_notices: string | null;
}

function conversationToProjectSqlBind(
  projectPath: string,
  conversation: ConversationState,
): ProjectSqlBindRow {
  const validated = conversationStateSchema.parse(conversation);
  return {
    id: validated.id,
    project_path: projectPath,
    // `open` defaults to true when unset — a fresh project conversation is open.
    open: validated.open === false ? 0 : 1,
    spawned_session_ids: jsonOrNull(validated.spawnedSessionIds ?? null),
    ...encodeSharedConversationColumns(validated),
  };
}

const PROJECT_CONVERSATION_COLUMN_KEYS: ReadonlyArray<
  keyof ProjectConversationsTableRow
> = [
  "id",
  "project_path",
  "name",
  "transcript_path",
  "status",
  "prompt_count",
  "created_at",
  "last_activity_at",
  "source",
  "summary",
  "archived",
  "open",
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
  "spawned_session_ids",
  "pending_queue",
  "last_seen_alignment_version",
  "pending_agent_notices",
];

function rawRowsEqual(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
): boolean {
  for (const key of PROJECT_CONVERSATION_COLUMN_KEYS) {
    if (a[key] !== b[key]) return false;
  }
  return true;
}

function rowToProjectDomain(rawRow: unknown): {
  projectPath: string;
  conversation: ConversationState;
} {
  const fallbackId =
    typeof rawRow === "object" &&
    rawRow !== null &&
    typeof (rawRow as { id?: unknown }).id === "string"
      ? (rawRow as { id: string }).id
      : "<unknown>";

  const rowResult = projectConversationsTableRowSchema.safeParse(rawRow);
  if (!rowResult.success) {
    return throwConversationValidationError(fallbackId, rowResult.error.issues);
  }
  const row: ProjectConversationsTableRow = rowResult.data;

  const spawnedSessionIds = parseJsonColumn(
    "spawnedSessionIds",
    row.spawned_session_ids,
    spawnedSessionIdsArraySchema,
    "default",
    [],
  );
  if (!spawnedSessionIds.ok) {
    return throwConversationValidationError(row.id, spawnedSessionIds.issues);
  }

  const candidate: Record<string, unknown> = {
    id: row.id,
    scope: "project",
    open: row.open === 1,
    spawnedSessionIds: spawnedSessionIds.value ?? [],
    ...decodeSharedConversationColumns(row.id, row),
  };

  const result = conversationStateSchema.safeParse(candidate);
  if (!result.success) {
    return throwConversationValidationError(row.id, result.error.issues);
  }
  return { projectPath: row.project_path, conversation: result.data };
}

function timed<T>(
  op: string,
  identifier: { id?: string; projectPath?: string },
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
    logger.info(`state-store.project-conversations.${op}.timing`, payload);
  }
}

export function createProjectConversationsRepo(
  db: Db,
): ProjectConversationsRepo {
  type ParsedRow = { projectPath: string; conversation: ConversationState };
  const cache = createVersionedRowCache<
    string,
    Record<string, unknown>,
    ParsedRow
  >({
    keyOf: (row) => row.id as string,
    rowsEqual: rawRowsEqual,
    parse: rowToProjectDomain,
  });

  const findByIdStmt = db.prepare(
    `SELECT * FROM project_conversations WHERE id = ? LIMIT 1`,
  );
  const findByKeyStmt = db.prepare(
    `SELECT * FROM project_conversations
     WHERE project_path = ? AND id = ?
     LIMIT 1`,
  );
  const findAllStmt = db.prepare(
    `SELECT * FROM project_conversations
     ORDER BY project_path ASC, created_at ASC, id ASC`,
  );
  const upsertStmt = db.prepare(
    `INSERT INTO project_conversations (
       id, project_path, name, transcript_path, status,
       prompt_count, created_at, last_activity_at, source, summary, archived, open,
       total_cost_usd, total_duration_ms, total_turns, pending_question_id,
       pending_questions, pending_prompt_text, forked_from, role, context_tokens, context_window_max,
       debug_mode, machine_snapshot, agent_backend, backend_ref,
       mcp_overrides, mcp_runtime, agent_capability_overrides, agent_capabilities_runtime,
       unread, spawned_session_ids, pending_queue, last_seen_alignment_version, pending_agent_notices
     ) VALUES (
       @id, @project_path, @name, @transcript_path, @status,
       @prompt_count, @created_at, @last_activity_at, @source, @summary, @archived, @open,
       @total_cost_usd, @total_duration_ms, @total_turns, @pending_question_id,
       @pending_questions, @pending_prompt_text, @forked_from, @role, @context_tokens, @context_window_max,
       @debug_mode, @machine_snapshot, @agent_backend, @backend_ref,
       @mcp_overrides, @mcp_runtime, @agent_capability_overrides, @agent_capabilities_runtime,
       @unread, @spawned_session_ids, @pending_queue, @last_seen_alignment_version, @pending_agent_notices
     )
     ON CONFLICT(id) DO UPDATE SET
       project_path               = excluded.project_path,
       name                       = excluded.name,
       transcript_path            = excluded.transcript_path,
       status                     = excluded.status,
       prompt_count               = excluded.prompt_count,
       created_at                 = excluded.created_at,
       last_activity_at           = excluded.last_activity_at,
       source                     = excluded.source,
       summary                    = excluded.summary,
       archived                   = excluded.archived,
       open                       = excluded.open,
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
       spawned_session_ids        = excluded.spawned_session_ids,
       pending_queue              = excluded.pending_queue,
       last_seen_alignment_version = excluded.last_seen_alignment_version,
       pending_agent_notices      = excluded.pending_agent_notices`,
  );
  const deleteStmt = db.prepare(
    `DELETE FROM project_conversations WHERE id = ?`,
  );
  const setPendingPromptTextStmt = db.prepare(
    `UPDATE project_conversations
     SET pending_prompt_text = ?
     WHERE project_path = ? AND id = ?`,
  );
  const setArchivedStmt = db.prepare(
    `UPDATE project_conversations
     SET archived = ?
     WHERE project_path = ? AND id = ?`,
  );
  const setOpenStmt = db.prepare(
    `UPDATE project_conversations
     SET open = ?
     WHERE project_path = ? AND id = ?`,
  );
  const selectSpawnedSessionIdsStmt = db.prepare(
    `SELECT spawned_session_ids FROM project_conversations
     WHERE project_path = ? AND id = ?
     LIMIT 1`,
  );
  const setSpawnedSessionIdsStmt = db.prepare(
    `UPDATE project_conversations
     SET spawned_session_ids = ?
     WHERE project_path = ? AND id = ?`,
  );

  function findAll(): ParsedRow[] {
    return timed("findAll", {}, () =>
      cache.readAll(() => findAllStmt.all() as Array<Record<string, unknown>>),
    );
  }

  return {
    findById(id) {
      return timed("findById", { id }, () => {
        const row: unknown = findByIdStmt.get(id);
        if (row === undefined) return null;
        return rowToProjectDomain(row).conversation;
      });
    },
    findByKey(projectPath, id) {
      return timed("findByKey", { projectPath, id }, () => {
        const row: unknown = findByKeyStmt.get(projectPath, id);
        if (row === undefined) return null;
        return rowToProjectDomain(row).conversation;
      });
    },
    findByProject(projectPath) {
      return timed("findByProject", { projectPath }, () =>
        findAll()
          .filter((e) => e.projectPath === projectPath)
          .map((e) => e.conversation),
      );
    },
    findAll,
    upsert(projectPath, conversation) {
      timed("upsert", { id: conversation.id, projectPath }, () => {
        const bind = conversationToProjectSqlBind(projectPath, conversation);
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
    setPendingPromptText(projectPath, id, text) {
      return timed("setPendingPromptText", { id, projectPath }, () => {
        const info = setPendingPromptTextStmt.run(text, projectPath, id);
        const changed = info.changes > 0;
        if (changed) cache.bump();
        return changed;
      });
    },
    setArchived(projectPath, id, archived) {
      return timed("setArchived", { id, projectPath }, () => {
        const info = setArchivedStmt.run(archived ? 1 : 0, projectPath, id);
        const changed = info.changes > 0;
        if (changed) cache.bump();
        return changed;
      });
    },
    setOpen(projectPath, id, open) {
      return timed("setOpen", { id, projectPath }, () => {
        const info = setOpenStmt.run(open ? 1 : 0, projectPath, id);
        const changed = info.changes > 0;
        if (changed) cache.bump();
        return changed;
      });
    },
    appendSpawnedSessionIds(projectPath, id, sessionNames) {
      return timed("appendSpawnedSessionIds", { id, projectPath }, () => {
        const row = selectSpawnedSessionIdsStmt.get(projectPath, id) as
          | { spawned_session_ids: string | null }
          | undefined;
        if (row === undefined) return false;

        const existing = parseJsonColumn(
          "spawnedSessionIds",
          row.spawned_session_ids,
          spawnedSessionIdsArraySchema,
          "default",
          [],
        );
        const current = existing.ok ? (existing.value ?? []) : [];
        const merged = [...current];
        for (const name of sessionNames) {
          if (!merged.includes(name)) merged.push(name);
        }

        const info = setSpawnedSessionIdsStmt.run(
          jsonOrNull(merged),
          projectPath,
          id,
        );
        const changed = info.changes > 0;
        if (changed) cache.bump();
        return changed;
      });
    },
  };
}
