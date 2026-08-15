import type Database from "better-sqlite3";
import { z } from "zod";
import { createLogger } from "@/lib/logging";
import { emitOrDeferRepositoryLog } from "@/lib/state-store/deferred-repo-logging";
import { mcpOverridesSchema } from "@/lib/mcp/schemas";
import { agentCapabilityOverridesSchema } from "@/lib/agent-capabilities/schemas";
import {
  sessionCreationModeSchema,
  sessionSourceSchema,
  sessionStateSchema,
  spawnedFromSchema,
} from "@/lib/sessions/schemas";
import { PersistenceError, getErrorMessage } from "../shared/errors";
import { createVersionedRowCache } from "@/lib/shared/versioned-row-cache";
import { jsonOrNull, stableStringify } from "./serialization";
import { checkRowColumnSize, checkRowColumnSizes } from "./row-size-telemetry";
import type { SessionState, SpawnedFrom } from "@/lib/sessions/schemas";
type Db = InstanceType<typeof Database>;

const logger = createLogger("state-store.sessions");

/**
 * The serialized-JSON columns of a `sessions` row that can grow large enough to
 * matter. Row-size telemetry sweeps them on write; a ballooning column surfaces
 * as a `state-store.row_size.exceeded` finding. (`graph_workflow_execution` is
 * not here — the active execution was split into its own table and this column
 * is no longer written.)
 */
const SESSION_JSON_COLUMNS = [
  "workflow_lanes",
  "workflow_envelopes",
  "mcp_overrides",
  "agent_capability_overrides",
] as const;

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

/**
 * Camel-case domain projection of one session-list row: the slim column set
 * needed to derive a `SessionListItem`, mapped to domain vocabulary at the repo
 * boundary. The heavy JSON columns are parsed here (`workflowEnvelopes`,
 * `spawnedFrom`) so no snake_case row shape escapes into callers; the
 * cross-entity derivation (status/prompt-count over the session's
 * conversations) stays with the accessor that owns that data.
 */
export interface SessionListItemProjection {
  sessionName: string;
  worktreePath: string;
  branchName: string;
  targetBranch: string;
  parentSessionName: string | null;
  createdAt: string;
  lastActivityAt: string;
  archived: boolean;
  finished: boolean;
  source: SessionState["source"];
  creationMode: SessionState["creationMode"];
  tddEnabled: boolean;
  hasActiveGraphWorkflow: boolean;
  workflowEnvelopes: Record<string, unknown> | null;
  spawnedFrom: SpawnedFrom | null;
}

export interface SessionsRepo {
  findByKey(projectPath: string, sessionName: string): SessionState | null;
  findByProject(projectPath: string): SessionState[];
  findListItemsByProject(projectPath: string): SessionListItemProjection[];
  findAllListItems(): Array<{
    projectPath: string;
    session: SessionListItemProjection;
  }>;
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
  /**
   * Point every direct child of any parent in `parentSessionNames` at `main`
   * and clear its parent link, in one statement (Pattern 2: a focused write
   * that reads no aggregate). Non-cascading — only direct children are
   * affected, never grandchildren. `target_branch`/`parent_session_name` are
   * plain scalar columns, so the direct UPDATE serializes them identically to
   * the per-column setter (`main` / NULL). An empty parent list writes nothing.
   * Bumps the findAll cache version when any row changed. Does NOT restamp
   * `last_activity_at` (a retarget must not bump session ordering).
   */
  retargetChildrenOfParents(
    projectPath: string,
    parentSessionNames: readonly string[],
  ): void;
  /**
   * Invalidate the parsed-row cache after session rows were removed out-of-band
   * — an FK `ON DELETE CASCADE` from a project delete drops the rows at the SQL
   * layer without routing through this repo's own `delete`. Bumps the version
   * so `findAll` re-reads from SQLite instead of serving evicted rows.
   */
  invalidateCache(): void;
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
  // Deferred with this repository's timing lines: the lease reservation looks a
  // session up inside the serialized write section, so a malformed row would
  // otherwise put a synchronous filesystem write under the write queue. A
  // throwing section releases it as an orphan rather than dropping it.
  emitOrDeferRepositoryLog(() =>
    logger.error("state-store.sessions.schema_validation_failure", {
      projectPath,
      sessionName,
      issues,
    }),
  );
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
  emitOrDeferRepositoryLog(() =>
    logger.error("state-store.sessions.column_quarantined", {
      projectPath,
      sessionName,
      column,
      issues,
    }),
  );
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

/**
 * Map one raw session-list SQL row to its camel-case domain projection. Parses
 * the two JSON columns here so a snake_case row shape never crosses the repo
 * boundary; a malformed `workflow_envelopes`/`spawned_from` value is logged and
 * degraded to `null` rather than failing the whole list read (these columns are
 * advisory for the slim list projection).
 */
function sessionListRowToProjection(
  projectPath: string,
  row: SessionListItemRow,
): SessionListItemProjection {
  let workflowEnvelopes: Record<string, unknown> | null = null;
  if (row.workflow_envelopes !== null) {
    try {
      const candidate: unknown = JSON.parse(row.workflow_envelopes);
      if (
        candidate !== null &&
        typeof candidate === "object" &&
        !Array.isArray(candidate)
      ) {
        workflowEnvelopes = candidate as Record<string, unknown>;
      }
    } catch {
      emitOrDeferRepositoryLog(() =>
        logger.warn("state-store.sessions.workflow_envelopes_parse_failed", {
          projectPath,
          sessionName: row.session_name,
        }),
      );
    }
  }

  let spawnedFrom: SpawnedFrom | null = null;
  if (row.spawned_from !== null) {
    try {
      const parsed = spawnedFromSchema.safeParse(JSON.parse(row.spawned_from));
      if (parsed.success) spawnedFrom = parsed.data;
    } catch {
      emitOrDeferRepositoryLog(() =>
        logger.warn("state-store.sessions.spawned_from_parse_failed", {
          projectPath,
          sessionName: row.session_name,
        }),
      );
    }
  }

  return {
    sessionName: row.session_name,
    worktreePath: row.worktree_path,
    branchName: row.branch_name,
    targetBranch: row.target_branch,
    parentSessionName: row.parent_session_name,
    createdAt: row.created_at,
    lastActivityAt: row.last_activity_at,
    archived: row.archived === 1,
    finished: row.finished === 1,
    source: row.source as SessionState["source"],
    creationMode: row.creation_mode as SessionState["creationMode"],
    tddEnabled: row.tdd_enabled === 1,
    hasActiveGraphWorkflow: row.has_active_graph_workflow === 1,
    workflowEnvelopes,
    spawnedFrom,
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
    // Deferred when a serialized section is open. The session lookup a write
    // runs before it touches SQLite is inside that section, and `createLogger`
    // appends to disk synchronously — so emitting here holds the write queue
    // (the whole system's launch bottleneck) across filesystem I/O.
    emitOrDeferRepositoryLog(() =>
      logger.info(`state-store.sessions.${op}.timing`, payload),
    );
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
  const cache = createVersionedRowCache<
    string,
    Record<string, unknown>,
    ParsedSessionRow
  >({
    keyOf: (row) =>
      `${row.project_path as string} ${row.session_name as string}`,
    rowsEqual: rawSessionRowsEqual,
    parse: rowToDomain,
  });
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
  // The ambient "this session has live workflow work" signal is lease tenure,
  // read from the derived `lease_held` column the executions repository writes
  // on every `setActive`. The status list this replaces named statuses this
  // domain does not have (`failed`, `cancelled`), so `aborted` counted as
  // active — and no status list can see halt resumability or abandonment, the
  // two facts that decide whether a halted run still holds anything.
  const findListItemsByProjectStmt = db.prepare(
    `SELECT
       session_name, worktree_path, branch_name, target_branch,
       parent_session_name, created_at, last_activity_at,
       archived, finished, source, creation_mode, tdd_enabled,
       COALESCE((
         SELECT e.lease_held
           FROM graph_workflow_executions e
          WHERE e.project_path = sessions.project_path
            AND e.session_name = sessions.session_name
       ), 0) AS has_active_graph_workflow,
       workflow_envelopes, spawned_from
     FROM sessions
     WHERE project_path = ?
     ORDER BY last_activity_at DESC`,
  );
  const findAllListItemsStmt = db.prepare(
    `SELECT
       project_path,
       session_name, worktree_path, branch_name, target_branch,
       parent_session_name, created_at, last_activity_at,
       archived, finished, source, creation_mode, tdd_enabled,
       COALESCE((
         SELECT e.lease_held
           FROM graph_workflow_executions e
          WHERE e.project_path = sessions.project_path
            AND e.session_name = sessions.session_name
       ), 0) AS has_active_graph_workflow,
       workflow_envelopes, spawned_from
     FROM sessions
     ORDER BY project_path ASC, last_activity_at DESC`,
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
        const rows = findListItemsByProjectStmt.all(
          projectPath,
        ) as SessionListItemRow[];
        return rows.map((row) => sessionListRowToProjection(projectPath, row));
      });
    },
    findAllListItems() {
      return timed("findAllListItems", undefined, undefined, () => {
        const rows = findAllListItemsStmt.all() as Array<
          SessionListItemRow & { project_path: string }
        >;
        return rows.map((row) => ({
          projectPath: row.project_path,
          session: sessionListRowToProjection(row.project_path, row),
        }));
      });
    },
    findAll() {
      return timed("findAll", undefined, undefined, () =>
        cache.readAll(
          () => findAllStmt.all() as Array<Record<string, unknown>>,
        ),
      );
    },
    upsert(projectPath, session) {
      timed("upsert", projectPath, session.sessionName, () => {
        const bind = domainToSessionRow(projectPath, session);
        checkRowColumnSizes({
          logger,
          table: "sessions",
          id: session.sessionName,
          bind: { ...bind },
          columns: SESSION_JSON_COLUMNS,
        });
        upsertStmt.run(bind);
        cache.bump();
      });
    },
    delete(projectPath, sessionName) {
      timed("delete", projectPath, sessionName, () => {
        deleteStmt.run(projectPath, sessionName);
        cache.bump();
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
        checkRowColumnSizes({
          logger,
          table: "sessions",
          id: sessionName,
          bind,
          columns: SESSION_JSON_COLUMNS,
        });
        const info = stmt.run(bind);
        if (info.changes > 0) cache.bump();
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
        if (info.changes > 0) cache.bump();
        return info.changes > 0;
      });
    },
    setSessionWorkflowLanes(projectPath, sessionName, lanes, lastActivityAt) {
      return timed("setSessionWorkflowLanes", projectPath, sessionName, () => {
        const value = jsonOrNull(lanes);
        checkRowColumnSize({
          logger,
          table: "sessions",
          column: "workflow_lanes",
          id: sessionName,
          value,
        });
        const info = setSessionWorkflowLanesStmt.run(
          value,
          lastActivityAt,
          projectPath,
          sessionName,
        );
        cache.bump();
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
          const value = jsonOrNull(envelopes);
          checkRowColumnSize({
            logger,
            table: "sessions",
            column: "workflow_envelopes",
            id: sessionName,
            value,
          });
          const info = setSessionWorkflowEnvelopesStmt.run(
            value,
            lastActivityAt,
            projectPath,
            sessionName,
          );
          cache.bump();
          return info.changes > 0;
        },
      );
    },
    retargetChildrenOfParents(projectPath, parentSessionNames) {
      timed("retargetChildrenOfParents", projectPath, undefined, () => {
        if (parentSessionNames.length === 0) return;
        const placeholders = parentSessionNames.map(() => "?").join(", ");
        const stmt = db.prepare(
          `UPDATE sessions
              SET target_branch = 'main', parent_session_name = NULL
            WHERE project_path = ?
              AND parent_session_name IN (${placeholders})`,
        );
        const info = stmt.run(projectPath, ...parentSessionNames);
        if (info.changes > 0) cache.bump();
      });
    },
    invalidateCache() {
      cache.bump();
    },
  };
}
