import type Database from "better-sqlite3";
import { z } from "zod";
import { createLogger } from "@/lib/logging";
import { mcpOverridesSchema } from "@/lib/mcp/schemas";
import { agentCapabilityOverridesSchema } from "@/lib/agent-capabilities/schemas";
import {
  sessionCreationModeSchema,
  sessionSourceSchema,
  sessionStateSchema,
  spawnedFromSchema,
} from "@/lib/sessions/schemas";
import { PersistenceError, getErrorMessage } from "../shared/errors";
import { jsonOrNull, stableStringify } from "./serialization";
import type { SessionState, SpawnedFrom } from "@/lib/sessions/schemas";
type Db = InstanceType<typeof Database>;

const logger = createLogger("state-store.sessions");

interface SessionListItemRow {
  session_name: string;
  worktree_path: string;
  branch_name: string;
  target_branch: string;
  parent_session_name: string | null;
  created_at: string;
  last_activity_at: string;
  archived: 0 | 1;
  finished: 0 | 1;
  source: string;
  creation_mode: string;
  tdd_enabled: 0 | 1;
  has_active_graph_workflow: 0 | 1;
  workflow_envelopes: string | null;
  spawned_from: string | null;
}

export interface SessionsRepo {
  findByKey(projectPath: string, sessionName: string): SessionState | null;
  findByProject(projectPath: string): SessionState[];
  findListItemsByProject(projectPath: string): SessionListItemRow[];
  findAll(): { projectPath: string; session: SessionState }[];
  upsert(projectPath: string, session: SessionState): void;
  delete(projectPath: string, sessionName: string): void;
  /**
   * Per-column update of one existing session row in one statement. Writes only
   * the columns in `changedColumns` (column-name → already-serialized bind
   * value), so co-located large columns (`graph_workflow_execution`,
   * `workflow_lanes`, `workflow_envelopes`) are neither re-serialized nor
   * re-written when their source field did not change. Does NOT auto-restamp
   * `last_activity_at` — that column is mutator-owned on the session-mutate path
   * (config toggles like archive/tdd must not bump session activity); the caller
   * includes it in `changedColumns` only when the mutator changed it. The row
   * must already exist; a missing row or an empty change set writes nothing.
   * Bumps the findAll cache version. Returns whether a row was updated.
   */
  updateChangedColumns(
    projectPath: string,
    sessionName: string,
    changedColumns: ChangedSessionColumns,
  ): boolean;
  /**
   * Focused single-column write of the `from chat` origin tag (Pattern 2: no
   * whole-state read). Called once at chat-spawn creation. Returns whether a
   * row was updated.
   */
  setSpawnedFrom(
    projectPath: string,
    sessionName: string,
    spawnedFrom: SpawnedFrom | null,
  ): boolean;
  /**
   * Focused write of the `workflow_lanes` column plus `last_activity_at`
   * (Pattern 2: no whole-state read). Serializes the opaque lane map using the
   * same `jsonOrNull(session.workflowLanes)` serialization as the full-row
   * upsert, so there is no column-level drift, without deep-validating it —
   * validation stays in the primitive store layer.
   * Bumps the findAll cache version. Returns whether a row was updated.
   */
  setSessionWorkflowLanes(
    projectPath: string,
    sessionName: string,
    lanes: Record<string, unknown> | undefined,
    lastActivityAt: string,
  ): boolean;
  /**
   * Focused write of the `workflow_envelopes` column plus `last_activity_at`
   * (Pattern 2: no whole-state read). Serializes the opaque envelope map using
   * the same `jsonOrNull(session.workflowEnvelopes)` serialization as the
   * full-row upsert, so there is no column-level drift, without deep-validating
   * it — validation stays in the primitive store layer.
   * Bumps the findAll cache version. Returns whether a row was updated.
   */
  setSessionWorkflowEnvelopes(
    projectPath: string,
    sessionName: string,
    envelopes: Record<string, unknown> | undefined,
    lastActivityAt: string,
  ): boolean;
}

/**
 * Raw column shape for `SELECT * FROM sessions`. Validated through
 * `sessionsTableRowSchema` at the persistence boundary so corrupt values trip a
 * Zod safeParse failure rather than being silently coerced.
 */
const sessionsTableRowSchema = z.object({
  project_path: z.string(),
  session_name: z.string(),
  worktree_path: z.string(),
  branch_name: z.string(),
  created_at: z.string(),
  last_activity_at: z.string(),
  archived: z.union([z.literal(0), z.literal(1)]),
  finished: z.union([z.literal(0), z.literal(1)]),
  source: z.string(),
  objective: z.string().nullable(),
  creation_mode: z.string(),
  tdd_enabled: z.union([z.literal(0), z.literal(1)]),
  target_branch: z.string(),
  parent_session_name: z.string().nullable(),
  graph_workflow_execution: z.string().nullable(),
  workflow_envelopes: z.string().nullable(),
  workflow_lanes: z.string().nullable(),
  mcp_overrides: z.string().nullable(),
  agent_capability_overrides: z.string().nullable(),
  spawned_from: z.string().nullable(),
});
type SessionsTableRow = z.infer<typeof sessionsTableRowSchema>;

interface SqlBindRow {
  project_path: string;
  session_name: string;
  worktree_path: string;
  branch_name: string;
  created_at: string;
  last_activity_at: string;
  archived: number;
  finished: number;
  source: string;
  creation_mode: string;
  tdd_enabled: number;
  target_branch: string;
  parent_session_name: string | null;
  workflow_envelopes: string | null;
  workflow_lanes: string | null;
  mcp_overrides: string | null;
  agent_capability_overrides: string | null;
  spawned_from: string | null;
}

/**
 * Encode a validated SessionState as the column-name → SQLite-primitive bind
 * record used by both `domainToRow` and `canonicalRow`. JSON column values are
 * serialized with sorted-key recursion so that two domain values that are
 * deep-equal post-Zod-parse always produce identical bytes.
 */
function sessionToSqlBind(
  projectPath: string,
  session: SessionState,
): SqlBindRow {
  return {
    project_path: projectPath,
    session_name: session.sessionName,
    worktree_path: session.worktreePath,
    branch_name: session.branchName,
    created_at: session.createdAt,
    last_activity_at: session.lastActivityAt,
    archived: session.archived ? 1 : 0,
    finished: session.finished ? 1 : 0,
    source: session.source,
    creation_mode: session.creationMode,
    tdd_enabled: session.tddEnabled ? 1 : 0,
    target_branch: session.targetBranch,
    parent_session_name: session.parentSessionName,
    workflow_envelopes: jsonOrNull(session.workflowEnvelopes),
    workflow_lanes: jsonOrNull(session.workflowLanes),
    mcp_overrides: jsonOrNull(session.mcpOverrides),
    agent_capability_overrides: jsonOrNull(session.agentCapabilityOverrides),
    spawned_from: jsonOrNull(session.spawnedFrom ?? null),
  };
}

function domainToSessionRow(
  projectPath: string,
  session: SessionState,
): SqlBindRow {
  const validated = sessionStateSchema.parse(session);
  return sessionToSqlBind(projectPath, validated);
}

/**
 * Every persisted, mutable session column and the single domain field it
 * derives from, paired with the serializer that turns that field into its
 * SQLite-primitive bind value — the per-column write authority for the focused
 * `mutateSession` path. Each serializer is byte-identical to the one
 * `sessionToSqlBind` uses for the same column, so a per-column UPDATE and a
 * full-row upsert produce identical bytes (zero column drift).
 *
 * Deliberately omits the identity columns (`project_path`/`session_name`, never
 * updated through this path) and `last_activity_at` (excluded from the diff;
 * `mutateSession` adds it to `changedColumns` only when the mutator changed
 * `session.lastActivityAt` — config toggles like archive/tdd must not bump
 * session ordering). Strictly 1:1 — no column derives from more than one field.
 * The two non-column
 * top-level fields (`conversations`, `referenceDocuments`) are intentionally
 * absent: they have no column on the `sessions` table (they live in child
 * tables), so a mutate touching only them yields zero changed session columns
 * here and is persisted via the child repos instead.
 */
const SESSION_COLUMN_MAP = [
  ["worktreePath", "worktree_path", (s: SessionState) => s.worktreePath],
  ["branchName", "branch_name", (s: SessionState) => s.branchName],
  ["createdAt", "created_at", (s: SessionState) => s.createdAt],
  ["archived", "archived", (s: SessionState) => (s.archived ? 1 : 0)],
  ["finished", "finished", (s: SessionState) => (s.finished ? 1 : 0)],
  ["source", "source", (s: SessionState) => s.source],
  ["creationMode", "creation_mode", (s: SessionState) => s.creationMode],
  ["tddEnabled", "tdd_enabled", (s: SessionState) => (s.tddEnabled ? 1 : 0)],
  ["targetBranch", "target_branch", (s: SessionState) => s.targetBranch],
  [
    "parentSessionName",
    "parent_session_name",
    (s: SessionState) => s.parentSessionName,
  ],
  [
    "workflowEnvelopes",
    "workflow_envelopes",
    (s: SessionState) => jsonOrNull(s.workflowEnvelopes),
  ],
  [
    "workflowLanes",
    "workflow_lanes",
    (s: SessionState) => jsonOrNull(s.workflowLanes),
  ],
  [
    "mcpOverrides",
    "mcp_overrides",
    (s: SessionState) => jsonOrNull(s.mcpOverrides),
  ],
  [
    "agentCapabilityOverrides",
    "agent_capability_overrides",
    (s: SessionState) => jsonOrNull(s.agentCapabilityOverrides),
  ],
  [
    "spawnedFrom",
    "spawned_from",
    (s: SessionState) => jsonOrNull(s.spawnedFrom ?? null),
  ],
] as const satisfies ReadonlyArray<
  readonly [
    keyof SessionState,
    string,
    (s: SessionState) => string | number | null,
  ]
>;

export type ChangedSessionColumns = Record<string, string | number | null>;

/**
 * Compare `base` against `next` field-by-field (top-level reference equality)
 * and return only the columns whose source field changed, already serialized to
 * their SQLite-primitive bind values via the same serializers the full-row
 * encoder uses (zero column drift). Excludes `last_activity_at` and the identity
 * columns — `mutateSession` adds `last_activity_at` to `changedColumns` only
 * when the mutator changed `session.lastActivityAt`, so it is never
 * auto-restamped on this path.
 *
 * `base` and `next` must be distinct objects (the row loaded before the mutator
 * and the value Immer's `finishDraft` returns) so structural sharing makes
 * `next[field] !== base[field]` exactly "this field's persisted bytes may have
 * changed". Serialization happens lazily, only for changed fields, so an
 * untouched `graph_workflow_execution` blob is never re-stringified.
 */
export function diffChangedSessionColumns(
  base: SessionState,
  next: SessionState,
): ChangedSessionColumns {
  const changed: ChangedSessionColumns = {};
  for (const [field, column, encode] of SESSION_COLUMN_MAP) {
    if (next[field] !== base[field]) {
      changed[column] = encode(next);
    }
  }
  return changed;
}

export function canonicalSessionRow(
  projectPath: string,
  session: SessionState,
): string {
  const validated = sessionStateSchema.parse(session);
  return stableStringify(sessionToSqlBind(projectPath, validated));
}

interface JsonParseSuccess<T> {
  ok: true;
  value: T;
}
interface JsonParseFailure {
  ok: false;
  issues: unknown;
}

function parseJsonColumn<T>(
  field: string,
  raw: string | null,
  schema: z.ZodType<T>,
  treatNullAs: "absent" | "default",
  defaultValue?: T,
): JsonParseSuccess<T | undefined> | JsonParseFailure {
  if (raw === null) {
    if (treatNullAs === "absent") return { ok: true, value: undefined };
    return { ok: true, value: defaultValue };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return {
      ok: false,
      issues: [
        {
          code: "invalid_json",
          path: [field],
          message: getErrorMessage(err),
        },
      ],
    };
  }
  const result = schema.safeParse(parsed);
  if (!result.success) return { ok: false, issues: result.error.issues };
  return { ok: true, value: result.data };
}

function logAndThrowValidationFailure(
  projectPath: string,
  sessionName: string,
  issues: unknown,
): never {
  logger.error("state-store.sessions.schema_validation_failure", {
    projectPath,
    sessionName,
    issues,
  });
  throw new PersistenceError({
    kind: "validation",
    entity: "session",
    identifier: `${projectPath}::${sessionName}`,
    issues,
  });
}

/**
 * Loud-log a forward-incompatible / corrupt *nullable* workflow column and let
 * the caller substitute the column's null/default. A feature branch that
 * extends a persisted enum (e.g. a new graph-workflow halt-reason variant) and
 * writes into the shared database leaves rows the current schema cannot parse;
 * hard-throwing here would take down every full-state read (readState,
 * mutateState, getSession) for one bad row. Degrading the offending column
 * in-memory keeps the rest of the session — and the app — usable, while the
 * error log preserves the full diagnostic. The on-disk value is left intact, so
 * a schema that understands the value will parse it on a later read.
 */
function logColumnQuarantine(
  projectPath: string,
  sessionName: string,
  column: string,
  issues: unknown,
): void {
  logger.error("state-store.sessions.column_quarantined", {
    projectPath,
    sessionName,
    column,
    issues,
  });
}

const opaqueRecordSchema = z.record(z.string(), z.unknown());

function rowToDomain(rawRow: unknown): {
  projectPath: string;
  session: SessionState;
} {
  const fallbackProjectPath =
    typeof rawRow === "object" &&
    rawRow !== null &&
    typeof (rawRow as { project_path?: unknown }).project_path === "string"
      ? (rawRow as { project_path: string }).project_path
      : "<unknown>";
  const fallbackSessionName =
    typeof rawRow === "object" &&
    rawRow !== null &&
    typeof (rawRow as { session_name?: unknown }).session_name === "string"
      ? (rawRow as { session_name: string }).session_name
      : "<unknown>";

  const rowResult = sessionsTableRowSchema.safeParse(rawRow);
  if (!rowResult.success) {
    return logAndThrowValidationFailure(
      fallbackProjectPath,
      fallbackSessionName,
      rowResult.error.issues,
    );
  }
  const row: SessionsTableRow = rowResult.data;

  const sourceResult = sessionSourceSchema.safeParse(row.source);
  if (!sourceResult.success) {
    return logAndThrowValidationFailure(
      row.project_path,
      row.session_name,
      sourceResult.error.issues,
    );
  }

  const creationModeResult = sessionCreationModeSchema.safeParse(
    row.creation_mode,
  );
  if (!creationModeResult.success) {
    return logAndThrowValidationFailure(
      row.project_path,
      row.session_name,
      creationModeResult.error.issues,
    );
  }

  let workflowEnvelopes: z.infer<typeof opaqueRecordSchema> | undefined;
  const envelopes = parseJsonColumn(
    "workflowEnvelopes",
    row.workflow_envelopes,
    opaqueRecordSchema,
    "absent",
  );
  if (envelopes.ok) {
    workflowEnvelopes = envelopes.value;
  } else {
    logColumnQuarantine(
      row.project_path,
      row.session_name,
      "workflowEnvelopes",
      envelopes.issues,
    );
  }

  let workflowLanes: z.infer<typeof opaqueRecordSchema> | undefined;
  const lanes = parseJsonColumn(
    "workflowLanes",
    row.workflow_lanes,
    opaqueRecordSchema,
    "absent",
  );
  if (lanes.ok) {
    workflowLanes = lanes.value;
  } else {
    logColumnQuarantine(
      row.project_path,
      row.session_name,
      "workflowLanes",
      lanes.issues,
    );
  }

  let mcpOverrides: z.infer<typeof mcpOverridesSchema> | undefined;
  const mcp = parseJsonColumn(
    "mcpOverrides",
    row.mcp_overrides,
    mcpOverridesSchema,
    "absent",
  );
  if (mcp.ok) {
    mcpOverrides = mcp.value;
  } else {
    logColumnQuarantine(
      row.project_path,
      row.session_name,
      "mcpOverrides",
      mcp.issues,
    );
  }

  let agentCapabilityOverrides:
    | z.infer<typeof agentCapabilityOverridesSchema>
    | undefined;
  const agentCaps = parseJsonColumn(
    "agentCapabilityOverrides",
    row.agent_capability_overrides,
    agentCapabilityOverridesSchema,
    "absent",
  );
  if (agentCaps.ok) {
    agentCapabilityOverrides = agentCaps.value;
  } else {
    logColumnQuarantine(
      row.project_path,
      row.session_name,
      "agentCapabilityOverrides",
      agentCaps.issues,
    );
  }

  let spawnedFrom: z.infer<typeof spawnedFromSchema> | null = null;
  const spawnedFromResult = parseJsonColumn(
    "spawnedFrom",
    row.spawned_from,
    spawnedFromSchema,
    "default",
    null,
  );
  if (spawnedFromResult.ok) {
    spawnedFrom = spawnedFromResult.value ?? null;
  } else {
    logColumnQuarantine(
      row.project_path,
      row.session_name,
      "spawnedFrom",
      spawnedFromResult.issues,
    );
  }

  const candidate: Record<string, unknown> = {
    sessionName: row.session_name,
    worktreePath: row.worktree_path,
    branchName: row.branch_name,
    createdAt: row.created_at,
    lastActivityAt: row.last_activity_at,
    archived: row.archived === 1,
    finished: row.finished === 1,
    source: sourceResult.data,
    creationMode: creationModeResult.data,
    tddEnabled: row.tdd_enabled === 1,
    targetBranch: row.target_branch,
    parentSessionName: row.parent_session_name,
    graphWorkflowExecution: null,
    conversations: [],
    referenceDocuments: [],
    spawnedFrom,
  };
  if (workflowEnvelopes !== undefined)
    candidate.workflowEnvelopes = workflowEnvelopes;
  if (workflowLanes !== undefined) candidate.workflowLanes = workflowLanes;
  if (mcpOverrides !== undefined) candidate.mcpOverrides = mcpOverrides;
  if (agentCapabilityOverrides !== undefined) {
    candidate.agentCapabilityOverrides = agentCapabilityOverrides;
  }

  const result = sessionStateSchema.safeParse(candidate);
  if (!result.success) {
    return logAndThrowValidationFailure(
      row.project_path,
      row.session_name,
      result.error.issues,
    );
  }
  return {
    projectPath: row.project_path,
    session: result.data,
  };
}

function timed<T>(
  op: string,
  projectPath: string | undefined,
  sessionName: string | undefined,
  fn: () => T,
): T {
  const start = performance.now();
  try {
    return fn();
  } finally {
    const durationMs = +(performance.now() - start).toFixed(3);
    const payload: Record<string, unknown> = { durationMs };
    if (projectPath !== undefined) payload.projectPath = projectPath;
    if (sessionName !== undefined) payload.sessionName = sessionName;
    logger.info(`state-store.sessions.${op}.timing`, payload);
  }
}

const SESSION_COLUMN_KEYS = Object.keys(sessionsTableRowSchema.shape) as Array<
  keyof SessionsTableRow
>;

function rawSessionRowsEqual(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
): boolean {
  for (const key of SESSION_COLUMN_KEYS) {
    if (a[key] !== b[key]) return false;
  }
  return true;
}

export function createSessionsRepo(db: Db): SessionsRepo {
  type ParsedSessionRow = { projectPath: string; session: SessionState };
  const findAllCache = new Map<
    string,
    { rawRow: Record<string, unknown>; parsed: ParsedSessionRow }
  >();
  let cacheVersion = 0;
  let lastFindAllVersion = -1;
  let lastFindAllResult: ParsedSessionRow[] = [];
  const findByKeyStmt = db.prepare(
    `SELECT * FROM sessions
     WHERE project_path = ? AND session_name = ?
     LIMIT 1`,
  );
  const findByProjectStmt = db.prepare(
    `SELECT * FROM sessions
     WHERE project_path = ?
     ORDER BY created_at ASC, session_name ASC`,
  );
  const findListItemsByProjectStmt = db.prepare(
    `SELECT
       session_name, worktree_path, branch_name, target_branch,
       parent_session_name, created_at, last_activity_at,
       archived, finished, source, creation_mode, tdd_enabled,
       COALESCE((
         SELECT CASE WHEN e.status
                  NOT IN ('completed', 'failed', 'cancelled')
                THEN 1 ELSE 0 END
           FROM graph_workflow_executions e
          WHERE e.project_path = sessions.project_path
            AND e.session_name = sessions.session_name
       ), 0) AS has_active_graph_workflow,
       workflow_envelopes, spawned_from
     FROM sessions
     WHERE project_path = ?
     ORDER BY last_activity_at DESC`,
  );
  const findAllStmt = db.prepare(
    `SELECT * FROM sessions
     ORDER BY project_path ASC, created_at ASC, session_name ASC`,
  );
  const upsertStmt = db.prepare(
    `INSERT INTO sessions (
       project_path, session_name, worktree_path, branch_name,
       created_at, last_activity_at, archived, finished, source,
       creation_mode, tdd_enabled, target_branch,
       parent_session_name,
       workflow_envelopes,
       workflow_lanes, mcp_overrides, agent_capability_overrides,
       spawned_from
     ) VALUES (
       @project_path, @session_name, @worktree_path, @branch_name,
       @created_at, @last_activity_at, @archived, @finished, @source,
       @creation_mode, @tdd_enabled, @target_branch,
       @parent_session_name,
       @workflow_envelopes,
       @workflow_lanes, @mcp_overrides, @agent_capability_overrides,
       @spawned_from
     )
     ON CONFLICT(project_path, session_name) DO UPDATE SET
       worktree_path                    = excluded.worktree_path,
       branch_name                      = excluded.branch_name,
       created_at                       = excluded.created_at,
       last_activity_at                 = excluded.last_activity_at,
       archived                         = excluded.archived,
       finished                         = excluded.finished,
       source                           = excluded.source,
       creation_mode                    = excluded.creation_mode,
       tdd_enabled                      = excluded.tdd_enabled,
       target_branch                    = excluded.target_branch,
       parent_session_name              = excluded.parent_session_name,
       workflow_envelopes               = excluded.workflow_envelopes,
       workflow_lanes                   = excluded.workflow_lanes,
       mcp_overrides                    = excluded.mcp_overrides,
       agent_capability_overrides       = excluded.agent_capability_overrides,
       spawned_from                     = excluded.spawned_from`,
  );
  const deleteStmt = db.prepare(
    `DELETE FROM sessions WHERE project_path = ? AND session_name = ?`,
  );
  const setSpawnedFromStmt = db.prepare(
    `UPDATE sessions SET spawned_from = ?
     WHERE project_path = ? AND session_name = ?`,
  );
  const setSessionWorkflowLanesStmt = db.prepare(
    `UPDATE sessions
        SET workflow_lanes = ?, last_activity_at = ?
      WHERE project_path = ? AND session_name = ?`,
  );
  const setSessionWorkflowEnvelopesStmt = db.prepare(
    `UPDATE sessions
        SET workflow_envelopes = ?, last_activity_at = ?
      WHERE project_path = ? AND session_name = ?`,
  );

  // Per-column-set prepared statements for the focused update path, keyed by the
  // sorted, comma-joined changed-column list so repeated mutation shapes (flag
  // toggles, target-branch edits, override patches) reuse one prepared statement.
  // Bounded by the small number of distinct shapes seen in practice. Writes only
  // the changed columns; `last_activity_at`, when changed, is one of those
  // columns (the caller decides — it is mutator-owned, never auto-restamped on
  // this path). Bind params are named: the changed-column values plus
  // `@project_path`, `@session_name`.
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
    const assignments = sortedColumns
      .map((col) => `${col} = @${col}`)
      .join(", ");
    const stmt = db.prepare(
      `UPDATE sessions SET ${assignments}
       WHERE project_path = @project_path AND session_name = @session_name`,
    );
    updateColumnsStmtCache.set(cacheKey, stmt);
    return stmt;
  }

  return {
    findByKey(projectPath, sessionName) {
      return timed("findByKey", projectPath, sessionName, () => {
        const row: unknown = findByKeyStmt.get(projectPath, sessionName);
        if (row === undefined) return null;
        return rowToDomain(row).session;
      });
    },
    findByProject(projectPath) {
      return timed("findByProject", projectPath, undefined, () => {
        const rows = findByProjectStmt.all(projectPath) as unknown[];
        return rows.map((row) => rowToDomain(row).session);
      });
    },
    findListItemsByProject(projectPath) {
      return timed("findListItemsByProject", projectPath, undefined, () => {
        return findListItemsByProjectStmt.all(
          projectPath,
        ) as SessionListItemRow[];
      });
    },
    findAll() {
      return timed("findAll", undefined, undefined, () => {
        if (cacheVersion === lastFindAllVersion) {
          return lastFindAllResult;
        }
        const rows = findAllStmt.all() as Array<Record<string, unknown>>;
        const out: ParsedSessionRow[] = new Array(rows.length);
        const seenKeys = new Set<string>();
        for (let i = 0; i < rows.length; i += 1) {
          const row = rows[i]!;
          const key = `${row.project_path as string}\u0000${row.session_name as string}`;
          seenKeys.add(key);
          const cached = findAllCache.get(key);
          if (cached !== undefined && rawSessionRowsEqual(cached.rawRow, row)) {
            out[i] = cached.parsed;
            continue;
          }
          const result = rowToDomain(row);
          const parsed: ParsedSessionRow = {
            projectPath: result.projectPath,
            session: result.session,
          };
          findAllCache.set(key, { rawRow: row, parsed });
          out[i] = parsed;
        }
        if (findAllCache.size > seenKeys.size) {
          for (const key of findAllCache.keys()) {
            if (!seenKeys.has(key)) findAllCache.delete(key);
          }
        }
        lastFindAllVersion = cacheVersion;
        lastFindAllResult = out;
        return out;
      });
    },
    upsert(projectPath, session) {
      timed("upsert", projectPath, session.sessionName, () => {
        const bind = domainToSessionRow(projectPath, session);
        upsertStmt.run(bind);
        cacheVersion += 1;
      });
    },
    delete(projectPath, sessionName) {
      timed("delete", projectPath, sessionName, () => {
        deleteStmt.run(projectPath, sessionName);
        cacheVersion += 1;
      });
    },
    updateChangedColumns(projectPath, sessionName, changedColumns) {
      return timed("updateChangedColumns", projectPath, sessionName, () => {
        const sortedColumns = Object.keys(changedColumns).sort();
        if (sortedColumns.length === 0) return false;
        const stmt = getUpdateColumnsStmt(sortedColumns);
        const bind: Record<string, string | number | null> = {
          project_path: projectPath,
          session_name: sessionName,
        };
        for (const col of sortedColumns) {
          bind[col] = changedColumns[col]!;
        }
        const info = stmt.run(bind);
        if (info.changes > 0) cacheVersion += 1;
        return info.changes > 0;
      });
    },
    setSpawnedFrom(projectPath, sessionName, spawnedFrom) {
      return timed("setSpawnedFrom", projectPath, sessionName, () => {
        const info = setSpawnedFromStmt.run(
          jsonOrNull(spawnedFrom),
          projectPath,
          sessionName,
        );
        return info.changes > 0;
      });
    },
    setSessionWorkflowLanes(projectPath, sessionName, lanes, lastActivityAt) {
      return timed("setSessionWorkflowLanes", projectPath, sessionName, () => {
        const info = setSessionWorkflowLanesStmt.run(
          jsonOrNull(lanes),
          lastActivityAt,
          projectPath,
          sessionName,
        );
        cacheVersion += 1;
        return info.changes > 0;
      });
    },
    setSessionWorkflowEnvelopes(
      projectPath,
      sessionName,
      envelopes,
      lastActivityAt,
    ) {
      return timed(
        "setSessionWorkflowEnvelopes",
        projectPath,
        sessionName,
        () => {
          const info = setSessionWorkflowEnvelopesStmt.run(
            jsonOrNull(envelopes),
            lastActivityAt,
            projectPath,
            sessionName,
          );
          cacheVersion += 1;
          return info.changes > 0;
        },
      );
    },
  };
}
