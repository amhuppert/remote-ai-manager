import type { McpOverrides } from "@/lib/mcp/schemas";
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
import type { AgentCapabilityOverrides } from "@/lib/agent-capabilities/schemas";
import { checkRowColumnSizes } from "./row-size-telemetry";

type Db = InstanceType<typeof Database>;

const logger = createLogger("state-store.project-conversations");

/**
 * The serialized-JSON columns of a `project_conversations` row that can grow
 * large enough to matter — the same conversation-shaped blobs as the
 * `conversations` table. Swept on write so a ballooning column surfaces as a
 * `state-store.row_size.exceeded` finding.
 */
const PROJECT_CONVERSATION_JSON_COLUMNS = [
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

/**
 * Persistence for session-less project conversations. Keyed `(project_path,
 * id)` — there is no `session_name`. Rows decode with `scope:"project"` and an
 * explicit `open` lifecycle flag (the project-only column). Mirrors the
 * `conversations` repo's parsed-row cache + monotonic `cacheVersion`
 * invalidation (PERFORMANCE.md Pattern 3).
 */
export interface ProjectConversationsRepo {
  findById(id: string): ConversationState | null;
  /** Like `findById`, but also reports the owning project — the id alone does
   * not say where a project conversation lives, and a cross-scope lookup needs
   * both. */
  findByIdWithProject(
    id: string,
  ): { projectPath: string; conversation: ConversationState } | null;
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
   * Focused single-column write of `agent_capability_overrides` (JSON, or NULL
   * when the overrides are cleared). Never restamps `last_activity_at` — a
   * capability-override edit is configuration, not conversation activity, and
   * must not reorder the PLC. Returns whether a row matched.
   */
  setMcpOverrides(
    projectPath: string,
    id: string,
    overrides: McpOverrides | undefined,
  ): boolean;
  setAgentCapabilityOverrides(
    projectPath: string,
    id: string,
    overrides: AgentCapabilityOverrides | undefined,
  ): boolean;
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
  /**
   * Focused single-column clear of `backend_ref`, leaving the conversation's
   * activity timestamp untouched: retiring a runtime is not conversation
   * activity and must not reorder the list. Synchronous and statement-level so
   * a caller that must clear the reference and record WHY in the same commit
   * can run both inside one transaction. Returns whether a row matched.
   */
  clearBackendRef(projectPath: string, id: string): boolean;
  /**
   * Invalidate the parsed-row cache after project-conversation rows were removed
   * out-of-band — an FK `ON DELETE CASCADE` from a project delete drops the rows
   * at the SQL layer without routing through this repo's own `delete`. Bumps the
   * version so `findAll`/`findByProject` re-read from SQLite instead of serving
   * evicted rows.
   */
  invalidateCache(): void;
}

/**
 * Raw column shape for `SELECT * FROM project_conversations`. Same as the
 * `conversations` row minus `session_name`, plus `open`.
 */
const projectConversationsTableRowSchema = z.object({
  id: z.string(),
  project_path: z.string(),
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
  open: z.union([z.literal(0), z.literal(1)]),
  total_cost_usd: z.number().nullable(),
  total_duration_ms: z.number().int().nullable(),
  total_turns: z.number().int().nullable(),
  pending_question_id: z.string().nullable(),
  pending_questions: z.string().nullable(),
  pending_prompt_text: z.string().nullable(),
  forked_from: z.string().nullable(),
  checkpoint_fork: z.string().nullable(),
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
  spawned_session_ids: z.string().nullable(),
  pending_queue: z.string().nullable(),
  last_seen_alignment_version: z.number().int().nullable(),
  pending_agent_notices: z.string().nullable(),
  profile_snapshot: z.string().nullable(),
  profile_locked_at: z.string().nullable(),
  creation_request_id: z.string().nullable(),
  conversation_owner: z.string().nullable(),
  turn_generation: z.number().int(),
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
  checkpoint_fork: string | null;
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
  spawned_session_ids: string | null;
  pending_queue: string | null;
  last_seen_alignment_version: number | null;
  pending_agent_notices: string | null;
  profile_snapshot: string | null;
  profile_locked_at: string | null;
  creation_request_id: string | null;
  conversation_owner: string | null;
  turn_generation: number;
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
    creation_request_id: validated.creationRequestId ?? null,
    ...encodeSharedConversationColumns(validated),
  };
}

const PROJECT_CONVERSATION_COLUMN_KEYS: ReadonlyArray<
  keyof ProjectConversationsTableRow
> = [
  "id",
  "project_path",
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
  "open",
  "total_cost_usd",
  "total_duration_ms",
  "total_turns",
  "pending_question_id",
  "pending_questions",
  "pending_prompt_text",
  "forked_from",
  "checkpoint_fork",
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
  "spawned_session_ids",
  "pending_queue",
  "last_seen_alignment_version",
  "pending_agent_notices",
  "profile_snapshot",
  "profile_locked_at",
  "creation_request_id",
  "conversation_owner",
  "turn_generation",
];

/**
 * Explicit projection for every read statement. `machine_snapshot` still exists
 * on the row (nulled by migration 0007, kept for forward-compat) but the snapshot
 * lives in the `conversation_machine_snapshots` sidecar, so no read may drag its
 * bytes: every read selects this explicit column list, never `*`.
 */
const PROJECT_CONVERSATION_SELECT_COLUMNS =
  PROJECT_CONVERSATION_COLUMN_KEYS.join(", ");

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
    // Absent for every conversation created any way other than a
    // create-and-send submission, so NULL decodes to the field being absent
    // rather than to an empty token a client could match on.
    ...(row.creation_request_id !== null
      ? { creationRequestId: row.creation_request_id }
      : {}),
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
    `SELECT ${PROJECT_CONVERSATION_SELECT_COLUMNS} FROM project_conversations WHERE id = ? LIMIT 1`,
  );
  const findByKeyStmt = db.prepare(
    `SELECT ${PROJECT_CONVERSATION_SELECT_COLUMNS} FROM project_conversations
     WHERE project_path = ? AND id = ?
     LIMIT 1`,
  );
  const findAllStmt = db.prepare(
    `SELECT ${PROJECT_CONVERSATION_SELECT_COLUMNS} FROM project_conversations
     ORDER BY project_path ASC, created_at ASC, id ASC`,
  );
  const upsertStmt = db.prepare(
    `INSERT INTO project_conversations (
       id, project_path, name, name_origin, transcript_path, status,
       prompt_count, created_at, last_activity_at, source, summary, archived, open,
       total_cost_usd, total_duration_ms, total_turns, pending_question_id,
       pending_questions, pending_prompt_text, forked_from, checkpoint_fork, role, context_tokens, context_window_max,
       debug_mode, agent_backend, backend_ref,
       mcp_overrides, mcp_runtime, agent_capability_overrides, agent_capabilities_runtime,
       unread, spawned_session_ids, pending_queue, last_seen_alignment_version, pending_agent_notices,
       profile_snapshot, profile_locked_at,
       creation_request_id, conversation_owner, turn_generation
     ) VALUES (
       @id, @project_path, @name, @name_origin, @transcript_path, @status,
       @prompt_count, @created_at, @last_activity_at, @source, @summary, @archived, @open,
       @total_cost_usd, @total_duration_ms, @total_turns, @pending_question_id,
       @pending_questions, @pending_prompt_text, @forked_from, @checkpoint_fork, @role, @context_tokens, @context_window_max,
       @debug_mode, @agent_backend, @backend_ref,
       @mcp_overrides, @mcp_runtime, @agent_capability_overrides, @agent_capabilities_runtime,
       @unread, @spawned_session_ids, @pending_queue, @last_seen_alignment_version, @pending_agent_notices,
       @profile_snapshot, @profile_locked_at,
       @creation_request_id, @conversation_owner, @turn_generation
     )
     ON CONFLICT(id) DO UPDATE SET
       project_path               = excluded.project_path,
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
       open                       = excluded.open,
       total_cost_usd             = excluded.total_cost_usd,
       total_duration_ms          = excluded.total_duration_ms,
       total_turns                = excluded.total_turns,
       pending_question_id        = excluded.pending_question_id,
       pending_questions          = excluded.pending_questions,
       pending_prompt_text        = excluded.pending_prompt_text,
       forked_from                = excluded.forked_from,
       checkpoint_fork            = excluded.checkpoint_fork,
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
       spawned_session_ids        = excluded.spawned_session_ids,
       pending_queue              = excluded.pending_queue,
       last_seen_alignment_version = excluded.last_seen_alignment_version,
       pending_agent_notices      = excluded.pending_agent_notices,
       profile_snapshot           = excluded.profile_snapshot,
       profile_locked_at          = excluded.profile_locked_at,
       creation_request_id        = excluded.creation_request_id,
       conversation_owner         = excluded.conversation_owner,
       turn_generation            = excluded.turn_generation`,
  );
  // The machine snapshot lives in the owner-discriminated sidecar table, not on
  // the project-conversation row. Its cleanup is DB-enforced by the AFTER DELETE
  // trigger on `project_conversations` (see SCHEMA_DDL): it fires inside this
  // DELETE's transaction and also covers the FK CASCADE path (deleting a
  // project) that never calls this method — so a single canonical owner cleans
  // the sidecar for every delete path.
  const deleteStmt = db.prepare(
    `DELETE FROM project_conversations WHERE id = ?`,
  );
  const setPendingPromptTextStmt = db.prepare(
    `UPDATE project_conversations
     SET pending_prompt_text = ?
     WHERE project_path = ? AND id = ?`,
  );
  const clearBackendRefStmt = db.prepare(
    `UPDATE project_conversations
     SET backend_ref = NULL
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
  const setMcpOverridesStmt = db.prepare(
    `UPDATE project_conversations
     SET mcp_overrides = ?
     WHERE project_path = ? AND id = ?`,
  );
  const setAgentCapabilityOverridesStmt = db.prepare(
    `UPDATE project_conversations
     SET agent_capability_overrides = ?
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
    findByIdWithProject(id) {
      return timed("findByIdWithProject", { id }, () => {
        const row: unknown = findByIdStmt.get(id);
        if (row === undefined) return null;
        return rowToProjectDomain(row);
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
        checkRowColumnSizes({
          logger,
          table: "project_conversations",
          id: conversation.id,
          bind: { ...bind },
          columns: PROJECT_CONVERSATION_JSON_COLUMNS,
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
    setMcpOverrides(projectPath, id, overrides) {
      return timed("setMcpOverrides", { id, projectPath }, () => {
        const info = setMcpOverridesStmt.run(
          jsonOrNull(overrides),
          projectPath,
          id,
        );
        const changed = info.changes > 0;
        if (changed) cache.bump();
        return changed;
      });
    },
    setAgentCapabilityOverrides(projectPath, id, overrides) {
      return timed("setAgentCapabilityOverrides", { id, projectPath }, () => {
        const info = setAgentCapabilityOverridesStmt.run(
          jsonOrNull(overrides),
          projectPath,
          id,
        );
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
    clearBackendRef(projectPath, id) {
      return timed("clearBackendRef", { id, projectPath }, () => {
        const info = clearBackendRefStmt.run(projectPath, id);
        const changed = info.changes > 0;
        if (changed) cache.bump();
        return changed;
      });
    },
    invalidateCache() {
      cache.bump();
    },
  };
}
