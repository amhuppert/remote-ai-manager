import Database from "better-sqlite3";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { getConfigDirPath } from "../config/loader";
import { createLogger } from "@/lib/logging";
import {
  deleteGlobalValue,
  getGlobalSingleton,
  getGlobalValue,
  setGlobalValue,
} from "../shared/global-singleton";

const logger = createLogger("state-store/state-db");

type Db = InstanceType<typeof Database>;

const GLOBAL_KEY = "__cc_state_db" as const;
const DB_FILE_NAME = "command-center.db";

/**
 * Highest schema migration version this build understands. Forward-only rule:
 * if the on-disk DB records a version greater than this, the build refuses to
 * open the connection and emits a `state-store.fatal` log so an older build
 * cannot silently downgrade a newer database.
 */
export const KNOWN_SCHEMA_VERSION = 0;

/**
 * Marker id for the one-time legacy graph-workflow purge. Tracked in the
 * dedicated `applied_data_migrations` table — NOT in `schema_migrations` —
 * so it never advances `MAX(version)` and therefore cannot trip the
 * forward-only version gate. A new bookkeeping table is invisible to
 * other-branch builds (KNOWN_SCHEMA_VERSION stays 0 for everyone), so this
 * data reset does not brick older builds that share `command-center.db`.
 */
export const LEGACY_WORKFLOW_PURGE_MIGRATION_ID =
  "graph-workflow-charter-legacy-purge";

const NOTIFICATIONS_TABLE_DDL = `
  CREATE TABLE IF NOT EXISTS notifications (
    id                    TEXT PRIMARY KEY,
    source                TEXT NOT NULL DEFAULT 'job',
    type                  TEXT NOT NULL,
    title                 TEXT NOT NULL,
    message               TEXT NOT NULL,
    read                  INTEGER NOT NULL DEFAULT 0,
    project_name          TEXT NOT NULL,
    created_at            TEXT NOT NULL DEFAULT (datetime('now')),
    session_name          TEXT,
    branch_name           TEXT,
    job_id                TEXT,
    job_type              TEXT,
    merge_hash            TEXT,
    commit_hash           TEXT,
    conflict_count        INTEGER,
    conflict_files        TEXT,
    target_branch         TEXT,
    conversation_id       TEXT,
    conversation_name     TEXT,
    conversation_status   TEXT,
    dedupe_key            TEXT,
    error_message         TEXT,
    CHECK (
      (source = 'job'
        AND session_name IS NOT NULL
        AND branch_name IS NOT NULL
        AND job_id IS NOT NULL
        AND job_type IS NOT NULL
        AND conversation_id IS NULL)
      OR
      (source = 'project-conversation'
        AND conversation_id IS NOT NULL
        AND conversation_status IS NOT NULL
        AND session_name IS NULL
        AND branch_name IS NULL
        AND job_id IS NULL
        AND job_type IS NULL)
    )
  );
`;

const NOTIFICATIONS_INDEX_DDL = `
  CREATE INDEX IF NOT EXISTS idx_notifications_read ON notifications(read);
  CREATE INDEX IF NOT EXISTS idx_notifications_created_at ON notifications(created_at);
  CREATE INDEX IF NOT EXISTS idx_notifications_project_session
    ON notifications(project_name, session_name);
  CREATE INDEX IF NOT EXISTS idx_notifications_project_conversation
    ON notifications(project_name, conversation_id)
    WHERE source = 'project-conversation';
  CREATE UNIQUE INDEX IF NOT EXISTS idx_notifications_dedupe
    ON notifications(dedupe_key)
    WHERE dedupe_key IS NOT NULL;
`;

const SCHEMA_DDL = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version     INTEGER PRIMARY KEY,
    description TEXT NOT NULL,
    applied_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS applied_data_migrations (
    id          TEXT PRIMARY KEY,
    applied_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Ledger for the Umzug-driven migration runner (see migrator.ts): one row per
  -- applied migration, keyed by name. Distinct from schema_migrations (the
  -- forward-only compatibility-version gate for breaking changes) and from
  -- applied_data_migrations (the legacy one-off purge marker). New migrations
  -- go here.
  CREATE TABLE IF NOT EXISTS applied_migrations (
    name        TEXT PRIMARY KEY,
    applied_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS projects (
    root_path                  TEXT PRIMARY KEY,
    archived                   INTEGER NOT NULL DEFAULT 0,
    pinned                     INTEGER NOT NULL DEFAULT 0,
    pin_order                  INTEGER,
    mcp_overrides              TEXT,
    agent_capability_overrides TEXT,
    created_at                 TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at                 TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_projects_archived ON projects(archived);
  CREATE INDEX IF NOT EXISTS idx_projects_pinned ON projects(pinned, pin_order);

  CREATE TABLE IF NOT EXISTS sessions (
    project_path                       TEXT NOT NULL,
    session_name                       TEXT NOT NULL,
    worktree_path                      TEXT NOT NULL,
    branch_name                        TEXT NOT NULL,
    created_at                         TEXT NOT NULL,
    last_activity_at                   TEXT NOT NULL,
    archived                           INTEGER NOT NULL DEFAULT 0,
    finished                           INTEGER NOT NULL DEFAULT 0,
    source                             TEXT NOT NULL DEFAULT 'cc',
    objective                          TEXT,
    creation_mode                      TEXT NOT NULL DEFAULT 'normal',
    tdd_enabled                        INTEGER NOT NULL DEFAULT 1,
    target_branch                      TEXT NOT NULL DEFAULT 'main',
    parent_session_name                TEXT,
    graph_workflow_execution           TEXT,
    graph_workflow_execution_history   TEXT NOT NULL DEFAULT '[]',
    workflow_envelopes                 TEXT,
    workflow_lanes                     TEXT,
    mcp_overrides                      TEXT,
    agent_capability_overrides         TEXT,
    spawned_from                       TEXT,
    PRIMARY KEY (project_path, session_name),
    FOREIGN KEY (project_path) REFERENCES projects(root_path) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_path);
  CREATE INDEX IF NOT EXISTS idx_sessions_archived ON sessions(archived);
  CREATE INDEX IF NOT EXISTS idx_sessions_last_activity ON sessions(last_activity_at);

  CREATE TABLE IF NOT EXISTS conversations (
    id                    TEXT PRIMARY KEY,
    project_path          TEXT NOT NULL,
    session_name          TEXT NOT NULL,
    name                  TEXT,
    transcript_path       TEXT,
    status                TEXT NOT NULL,
    prompt_count          INTEGER NOT NULL DEFAULT 0,
    created_at            TEXT NOT NULL,
    last_activity_at      TEXT NOT NULL,
    source                TEXT NOT NULL DEFAULT 'cc',
    summary               TEXT,
    archived              INTEGER NOT NULL DEFAULT 0,
    total_cost_usd        REAL,
    total_duration_ms     INTEGER,
    total_turns           INTEGER,
    pending_question_id   TEXT,
    pending_questions     TEXT,
    pending_prompt_text   TEXT,
    forked_from           TEXT,
    role                  TEXT,
    context_tokens        INTEGER,
    context_window_max    INTEGER,
    debug_mode            TEXT,
    machine_snapshot      TEXT,
    agent_backend         TEXT NOT NULL DEFAULT 'claude',
    backend_ref           TEXT,
    mcp_overrides         TEXT,
    mcp_runtime           TEXT,
    agent_capability_overrides TEXT,
    agent_capabilities_runtime TEXT,
    unread                INTEGER NOT NULL DEFAULT 0,
    pending_queue         TEXT,
    FOREIGN KEY (project_path, session_name)
      REFERENCES sessions(project_path, session_name) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_conversations_session
    ON conversations(project_path, session_name);
  CREATE INDEX IF NOT EXISTS idx_conversations_last_activity
    ON conversations(last_activity_at);

  CREATE TABLE IF NOT EXISTS project_conversations (
    id                    TEXT PRIMARY KEY,
    project_path          TEXT NOT NULL,
    name                  TEXT,
    transcript_path       TEXT,
    status                TEXT NOT NULL,
    prompt_count          INTEGER NOT NULL DEFAULT 0,
    created_at            TEXT NOT NULL,
    last_activity_at      TEXT NOT NULL,
    source                TEXT NOT NULL DEFAULT 'cc',
    summary               TEXT,
    archived              INTEGER NOT NULL DEFAULT 0,
    open                  INTEGER NOT NULL DEFAULT 1,
    total_cost_usd        REAL,
    total_duration_ms     INTEGER,
    total_turns           INTEGER,
    pending_question_id   TEXT,
    pending_questions     TEXT,
    pending_prompt_text   TEXT,
    forked_from           TEXT,
    role                  TEXT,
    context_tokens        INTEGER,
    context_window_max    INTEGER,
    debug_mode            TEXT,
    machine_snapshot      TEXT,
    agent_backend         TEXT NOT NULL DEFAULT 'claude',
    backend_ref           TEXT,
    mcp_overrides         TEXT,
    mcp_runtime           TEXT,
    agent_capability_overrides TEXT,
    agent_capabilities_runtime TEXT,
    unread                INTEGER NOT NULL DEFAULT 0,
    spawned_session_ids   TEXT,
    FOREIGN KEY (project_path) REFERENCES projects(root_path) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_project_conversations_project
    ON project_conversations(project_path);
  CREATE INDEX IF NOT EXISTS idx_project_conversations_last_activity
    ON project_conversations(last_activity_at);

  CREATE TABLE IF NOT EXISTS reference_documents (
    id            TEXT PRIMARY KEY,
    project_path  TEXT NOT NULL,
    session_name  TEXT NOT NULL,
    file_path     TEXT NOT NULL,
    description   TEXT NOT NULL,
    created_at    TEXT NOT NULL,
    FOREIGN KEY (project_path, session_name)
      REFERENCES sessions(project_path, session_name) ON DELETE CASCADE,
    UNIQUE (project_path, session_name, file_path)
  );

  ${NOTIFICATIONS_TABLE_DDL}

  CREATE TABLE IF NOT EXISTS job_records (
    job_id         TEXT PRIMARY KEY,
    job_type       TEXT NOT NULL,
    status         TEXT NOT NULL,
    project_name   TEXT NOT NULL,
    session_name   TEXT NOT NULL,
    branch_name    TEXT NOT NULL,
    started_at     TEXT NOT NULL,
    completed_at   TEXT,
    merge_hash     TEXT,
    commit_hash    TEXT,
    conflict_count INTEGER,
    conflict_files TEXT,
    error_message  TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_job_records_status ON job_records(status);

  CREATE TABLE IF NOT EXISTS graph_workflow_events (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    project_path  TEXT NOT NULL,
    session_name  TEXT NOT NULL,
    execution_id  TEXT NOT NULL,
    occurred_at   TEXT NOT NULL,
    event_type    TEXT NOT NULL,
    context_id    TEXT,
    pre_reset     INTEGER NOT NULL DEFAULT 0,
    event_json    TEXT NOT NULL,
    FOREIGN KEY (project_path, session_name)
      REFERENCES sessions(project_path, session_name) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_graph_workflow_events_execution
    ON graph_workflow_events(execution_id, id);
  CREATE INDEX IF NOT EXISTS idx_graph_workflow_events_context
    ON graph_workflow_events(execution_id, context_id, event_type);

  CREATE TABLE IF NOT EXISTS graph_workflow_archived_executions (
    project_path    TEXT NOT NULL,
    session_name    TEXT NOT NULL,
    execution_id    TEXT NOT NULL,
    archived_at     TEXT NOT NULL,
    status          TEXT NOT NULL,
    started_at      TEXT NOT NULL,
    completed_at    TEXT,
    execution_json  TEXT NOT NULL,
    PRIMARY KEY (project_path, session_name, execution_id),
    FOREIGN KEY (project_path, session_name)
      REFERENCES sessions(project_path, session_name) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_graph_workflow_archived_executions_session
    ON graph_workflow_archived_executions(project_path, session_name, archived_at);

  CREATE TABLE IF NOT EXISTS graph_workflow_executions (
    project_path              TEXT NOT NULL,
    session_name              TEXT NOT NULL,
    execution_id              TEXT NOT NULL,
    seed_definition_id        TEXT NOT NULL,
    seed_definition_revision  INTEGER NOT NULL,
    started_at                TEXT NOT NULL,
    status                    TEXT NOT NULL,
    completed_at              TEXT,
    definition_json           TEXT NOT NULL,
    runtime_json              TEXT NOT NULL,
    updated_at                TEXT NOT NULL,
    PRIMARY KEY (project_path, session_name),
    FOREIGN KEY (project_path, session_name)
      REFERENCES sessions(project_path, session_name) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_graph_workflow_executions_status
    ON graph_workflow_executions(project_path, session_name, status);

  CREATE TABLE IF NOT EXISTS session_alignment_versions (
    id                     TEXT PRIMARY KEY,
    project_path           TEXT NOT NULL,
    session_name           TEXT NOT NULL,
    version                INTEGER,
    content                TEXT NOT NULL DEFAULT '',
    content_hash           TEXT NOT NULL DEFAULT '',
    status                 TEXT NOT NULL,
    source                 TEXT NOT NULL,
    author_conversation_id TEXT,
    auto_activate          INTEGER NOT NULL DEFAULT 0,
    linked_decision_ids    TEXT NOT NULL DEFAULT '[]',
    approver               TEXT,
    created_at             TEXT NOT NULL,
    activated_at           TEXT,
    FOREIGN KEY (project_path, session_name)
      REFERENCES sessions(project_path, session_name) ON DELETE CASCADE,
    UNIQUE (project_path, session_name, version)
  );

  CREATE INDEX IF NOT EXISTS idx_session_alignment_versions_status
    ON session_alignment_versions(project_path, session_name, status);

  CREATE TABLE IF NOT EXISTS session_alignment_decisions (
    id                     TEXT PRIMARY KEY,
    project_path           TEXT NOT NULL,
    session_name           TEXT NOT NULL,
    statement              TEXT NOT NULL,
    rationale              TEXT,
    origin_conversation_id TEXT NOT NULL,
    origin_message_id      TEXT,
    produced_version       INTEGER,
    approved_at            TEXT NOT NULL,
    approver               TEXT,
    created_at             TEXT NOT NULL,
    FOREIGN KEY (project_path, session_name)
      REFERENCES sessions(project_path, session_name) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_session_alignment_decisions_approved_at
    ON session_alignment_decisions(project_path, session_name, approved_at);

  CREATE TABLE IF NOT EXISTS session_alignment_decision_proposals (
    id                     TEXT PRIMARY KEY,
    project_path           TEXT NOT NULL,
    session_name           TEXT NOT NULL,
    conversation_id        TEXT NOT NULL,
    batch_id               TEXT NOT NULL,
    statement              TEXT NOT NULL,
    rationale              TEXT,
    context                TEXT,
    origin_message_id      TEXT,
    created_at             TEXT NOT NULL,
    FOREIGN KEY (project_path, session_name)
      REFERENCES sessions(project_path, session_name) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_session_alignment_decision_proposals_batch
    ON session_alignment_decision_proposals(project_path, session_name, batch_id);
`;

class SchemaVersionConflictError extends Error {
  constructor(
    public readonly recordedVersion: number,
    public readonly knownVersion: number,
  ) {
    super(
      `Refusing to open command-center.db: recorded schema version ${recordedVersion} is greater than known build version ${knownVersion}`,
    );
    this.name = "SchemaVersionConflictError";
  }
}

function applyPragmas(db: Db): void {
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("synchronous = FULL");
}

function enforceForwardOnlyVersion(db: Db, dbPath: string): void {
  const row = db
    .prepare("SELECT MAX(version) AS maxVersion FROM schema_migrations")
    .get() as { maxVersion: number | null };
  const recorded = row.maxVersion ?? 0;
  if (recorded > KNOWN_SCHEMA_VERSION) {
    logger.error("state-store.fatal", {
      reason: "schema_version_conflict",
      dbPath,
      recordedVersion: recorded,
      knownVersion: KNOWN_SCHEMA_VERSION,
    });
    throw new SchemaVersionConflictError(recorded, KNOWN_SCHEMA_VERSION);
  }
}

/**
 * Idempotent column additions for tables that already existed before a column
 * was added to the DDL. `CREATE TABLE IF NOT EXISTS` is a no-op when the table
 * is already present, so new columns must be added explicitly. Each entry
 * encodes the table, column name, and full column type spec; `PRAGMA
 * table_info` decides whether the column already exists. Safe to run on a
 * freshly-created DB — it just finds the column and skips.
 */
const ADDITIVE_COLUMNS: ReadonlyArray<{
  table: string;
  column: string;
  type: string;
}> = [
  { table: "conversations", column: "pending_prompt_text", type: "TEXT" },
  { table: "projects", column: "agent_capability_overrides", type: "TEXT" },
  { table: "sessions", column: "agent_capability_overrides", type: "TEXT" },
  {
    table: "conversations",
    column: "agent_capability_overrides",
    type: "TEXT",
  },
  {
    table: "conversations",
    column: "agent_capabilities_runtime",
    type: "TEXT",
  },
  {
    table: "conversations",
    column: "unread",
    type: "INTEGER NOT NULL DEFAULT 0",
  },
  {
    table: "project_conversations",
    column: "open",
    type: "INTEGER NOT NULL DEFAULT 1",
  },
  { table: "sessions", column: "spawned_from", type: "TEXT" },
  {
    table: "project_conversations",
    column: "spawned_session_ids",
    type: "TEXT",
  },
  { table: "conversations", column: "pending_queue", type: "TEXT" },
  {
    table: "conversations",
    column: "last_seen_alignment_version",
    type: "INTEGER",
  },
];

function columnExists(db: Db, table: string, column: string): boolean {
  const cols = db.pragma(`table_info(${table})`) as { name: string }[];
  return cols.some((c) => c.name === column);
}

function isDuplicateColumnError(err: unknown): boolean {
  return (
    err instanceof Error &&
    err.message.toLowerCase().includes("duplicate column name")
  );
}

/**
 * Add `column` to `table`, tolerating a concurrent winner. The existence check
 * and the `ALTER` are not atomic across connections: when several processes open
 * the same DB file at once (e.g. `next build`'s parallel page-data workers) and
 * a newly-introduced additive column is still missing, they each decide to add
 * it and then race the `ALTER`. SQLite reports the losers' attempts as
 * "duplicate column name". That race outcome is benign, so swallow it — but only
 * once the column is confirmed present, so a genuine failure (or a duplicate
 * error that somehow left the column absent) still propagates.
 */
export function addColumnToleratingRace(
  db: Db,
  table: string,
  column: string,
  type: string,
): void {
  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  } catch (err) {
    if (isDuplicateColumnError(err) && columnExists(db, table, column)) {
      logger.debug("state-store.additive_column_race", { table, column });
      return;
    }
    throw err;
  }
}

function ensureAdditiveColumns(db: Db): void {
  for (const { table, column, type } of ADDITIVE_COLUMNS) {
    if (columnExists(db, table, column)) continue;
    addColumnToleratingRace(db, table, column, type);
  }
}

interface TableColumnInfo {
  name: string;
  notnull: 0 | 1;
}

function getTableColumns(db: Db, table: string): TableColumnInfo[] {
  return db.pragma(`table_info(${table})`) as TableColumnInfo[];
}

function notificationColumnExpression(
  existingColumnNames: Set<string>,
  column: string,
  fallback: string,
): string {
  if (existingColumnNames.has(column)) return column;
  return fallback;
}

function migrateNotificationsTable(db: Db): void {
  const columns = getTableColumns(db, "notifications");
  if (columns.length === 0) return;

  const columnNames = new Set(columns.map((column) => column.name));
  const requiredColumns = [
    "source",
    "conversation_id",
    "conversation_name",
    "conversation_status",
    "dedupe_key",
  ];
  const missingRequiredColumns = requiredColumns.some(
    (column) => !columnNames.has(column),
  );
  const jobContextIsStrict = columns.some(
    (column) =>
      ["session_name", "branch_name", "job_id", "job_type"].includes(
        column.name,
      ) && column.notnull === 1,
  );

  if (!missingRequiredColumns && !jobContextIsStrict) return;

  db.exec(`
    DROP INDEX IF EXISTS idx_notifications_read;
    DROP INDEX IF EXISTS idx_notifications_created_at;
    DROP INDEX IF EXISTS idx_notifications_project_session;
    DROP INDEX IF EXISTS idx_notifications_project_conversation;
    DROP INDEX IF EXISTS idx_notifications_dedupe;
    ALTER TABLE notifications RENAME TO notifications_legacy_migration;
  `);
  db.exec(NOTIFICATIONS_TABLE_DDL);

  const legacyColumns = getTableColumns(db, "notifications_legacy_migration");
  const legacyColumnNames = new Set(legacyColumns.map((column) => column.name));

  db.exec(`
    INSERT INTO notifications (
      id,
      source,
      type,
      title,
      message,
      read,
      project_name,
      created_at,
      session_name,
      branch_name,
      job_id,
      job_type,
      merge_hash,
      commit_hash,
      conflict_count,
      conflict_files,
      target_branch,
      conversation_id,
      conversation_name,
      conversation_status,
      dedupe_key,
      error_message
    )
    SELECT
      id,
      ${notificationColumnExpression(legacyColumnNames, "source", "'job'")},
      type,
      title,
      message,
      read,
      project_name,
      ${notificationColumnExpression(
        legacyColumnNames,
        "created_at",
        "datetime('now')",
      )},
      session_name,
      branch_name,
      job_id,
      job_type,
      ${notificationColumnExpression(legacyColumnNames, "merge_hash", "NULL")},
      ${notificationColumnExpression(legacyColumnNames, "commit_hash", "NULL")},
      ${notificationColumnExpression(
        legacyColumnNames,
        "conflict_count",
        "NULL",
      )},
      ${notificationColumnExpression(
        legacyColumnNames,
        "conflict_files",
        "NULL",
      )},
      ${notificationColumnExpression(
        legacyColumnNames,
        "target_branch",
        "NULL",
      )},
      ${notificationColumnExpression(
        legacyColumnNames,
        "conversation_id",
        "NULL",
      )},
      ${notificationColumnExpression(
        legacyColumnNames,
        "conversation_name",
        "NULL",
      )},
      ${notificationColumnExpression(
        legacyColumnNames,
        "conversation_status",
        "NULL",
      )},
      ${notificationColumnExpression(legacyColumnNames, "dedupe_key", "NULL")},
      ${notificationColumnExpression(
        legacyColumnNames,
        "error_message",
        "NULL",
      )}
    FROM notifications_legacy_migration;

    DROP TABLE notifications_legacy_migration;
  `);
  db.exec(NOTIFICATIONS_INDEX_DDL);
}

/**
 * One-time global purge of pre-charter graph-workflow records. The Workflow
 * Charter feature makes a charter required on every workflow definition and
 * execution, so legacy charter-less records cannot satisfy the schema. This
 * runs once at app start — before any sessions-repo reader that would
 * otherwise quarantine charter-less rows — and:
 *   - nulls the embedded `graph_workflow_execution` and resets the history to
 *     `'[]'` on every persisted session (executions live inside SessionState,
 *     so a table drop is insufficient),
 *   - deletes every workflow definition file under `<configDir>/workflows/`,
 *   - records its marker so a repeat run is a no-op.
 *
 * `configDir` is derived from the open DB path by the caller (its directory),
 * NOT from `getConfigDirPath()`, so tests over a temp DB never touch the real
 * config dir. In production `path.dirname(dbPath) === getConfigDirPath()`. A
 * `null` configDir (in-memory DB) skips the file-deletion step only; the
 * SQLite-side reset still runs.
 *
 * Shared-database blast radius: `command-center.db` is shared across all
 * branches/worktrees, so this delete removes definitions and executions for
 * every session and branch. The operator confirmed this global reset is
 * intended (see design.md "Migration Strategy").
 */
export function runLegacyWorkflowPurgeMigration(
  db: Db,
  configDir: string | null,
): void {
  // The marker insert IS the claim: `command-center.db` is shared across
  // branches/worktrees and opened concurrently (Next.js build spawns many
  // workers), so a SELECT-then-INSERT guard races — two connections both see
  // the marker absent and the second INSERT violates the PRIMARY KEY. Claiming
  // atomically with INSERT OR IGNORE lets only the winner (changes === 1) run
  // the purge; losers (changes === 0) skip without touching files or logging.
  const purge = db.transaction(() => {
    const claim = db
      .prepare("INSERT OR IGNORE INTO applied_data_migrations (id) VALUES (?)")
      .run(LEGACY_WORKFLOW_PURGE_MIGRATION_ID);
    if (claim.changes === 0) {
      return null;
    }
    const result = db
      .prepare(
        `UPDATE sessions
           SET graph_workflow_execution = NULL,
               graph_workflow_execution_history = '[]'
         WHERE graph_workflow_execution IS NOT NULL
            OR graph_workflow_execution_history <> '[]'`,
      )
      .run();
    return result.changes;
  });

  const sessionsCleared = purge();
  if (sessionsCleared === null) {
    return;
  }

  const workflowsDir = configDir ? path.join(configDir, "workflows") : null;
  const workflowsDirRemoved = workflowsDir !== null && existsSync(workflowsDir);
  if (workflowsDir !== null && workflowsDirRemoved) {
    rmSync(workflowsDir, { recursive: true, force: true });
  }

  logger.info("state-store.legacy_workflow_purge", {
    migrationId: LEGACY_WORKFLOW_PURGE_MIGRATION_ID,
    sessionsCleared,
    workflowsDirRemoved,
    workflowsDir,
  });
}

function initializeSchema(db: Db, dbPath: string): void {
  db.exec(SCHEMA_DDL);
  migrateNotificationsTable(db);
  db.exec(NOTIFICATIONS_INDEX_DDL);
  ensureAdditiveColumns(db);
  // `:memory:` has no on-disk config dir; skip the file-deleting purge there.
  // The SQLite-side reset still runs against the in-memory sessions table.
  const configDir = dbPath === ":memory:" ? null : path.dirname(dbPath);
  runLegacyWorkflowPurgeMigration(db, configDir);
  enforceForwardOnlyVersion(db, dbPath);
}

function openStateDb(dbPath: string): Db {
  const db = new Database(dbPath);
  applyPragmas(db);
  try {
    initializeSchema(db, dbPath);
  } catch (err) {
    db.close();
    throw err;
  }
  return db;
}

/**
 * Get-or-open the singleton `command-center.db` connection. HMR-safe.
 *
 * The first call resolves the config dir, ensures it exists, opens the
 * `better-sqlite3` connection, applies pragmas, and runs schema initialization
 * (including the forward-only schema_migrations conflict check).
 */
export function getDb(): Db {
  return getGlobalSingleton(GLOBAL_KEY, () => {
    const configDir = getConfigDirPath();
    if (!existsSync(configDir)) {
      mkdirSync(configDir, { recursive: true });
    }
    const dbPath = path.join(configDir, DB_FILE_NAME);
    return openStateDb(dbPath);
  });
}

/** Reset the singleton for testing — closes any open connection. */
export function _resetForTesting(): void {
  const db = getGlobalValue<Db>(GLOBAL_KEY);
  if (db) {
    db.close();
    deleteGlobalValue(GLOBAL_KEY);
  }
}

/**
 * Create a fresh `Database` for tests via DI. Does NOT touch the singleton.
 *
 * `inMemory: true` opens `:memory:`; otherwise a fresh temp directory is used
 * so each call yields an isolated file-backed DB.
 */
export function _createTestDb(opts: { inMemory?: boolean } = {}): Db {
  if (opts.inMemory === true) {
    return openStateDb(":memory:");
  }
  const dir = mkdtempSync(path.join(os.tmpdir(), "cc-state-db-"));
  return openStateDb(path.join(dir, DB_FILE_NAME));
}

/**
 * Test helper: open a state DB at an explicit path. Used by tests that need to
 * reopen the same file (e.g. forward-only conflict regression).
 */
export function _createTestDbAtPath(dbPath: string): Db {
  return openStateDb(dbPath);
}

/**
 * Bookkeeping table excluded from {@link truncateAllTables} so the forward-only
 * version check still passes after a reset.
 */
const SCHEMA_VERSION_TABLE = "schema_migrations";

/**
 * Test helper: empty every application data table, deriving the table set from
 * the live schema (`sqlite_master`) so a newly added table is cleared with no
 * code change. Excludes SQLite internals (`sqlite_%`) and the schema-version
 * bookkeeping table (`schema_migrations`) so the forward-only version check
 * still passes after reset.
 *
 * Foreign-key enforcement is disabled for the duration of the deletes so order
 * is irrelevant, then restored to its prior state.
 */
export function truncateAllTables(db: Db): void {
  const rows = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all();
  const tables: string[] = [];
  for (const row of rows) {
    if (typeof row !== "object" || row === null || !("name" in row)) {
      continue;
    }
    const name = (row as { name: unknown }).name;
    if (typeof name !== "string") {
      continue;
    }
    if (name.startsWith("sqlite_") || name === SCHEMA_VERSION_TABLE) {
      continue;
    }
    tables.push(name);
  }

  const fkRows = db.pragma("foreign_keys") as { foreign_keys: number }[];
  const fkWasOn = fkRows[0]?.foreign_keys === 1;

  db.pragma("foreign_keys = OFF");
  try {
    const truncate = db.transaction(() => {
      for (const table of tables) {
        db.exec(`DELETE FROM "${table}"`);
      }
    });
    truncate();
  } finally {
    if (fkWasOn) {
      db.pragma("foreign_keys = ON");
    }
  }
}

/**
 * Test helper: install a `Database` instance into the singleton slot so that
 * subsequent calls to `getDb()` return it. Closes any previously-installed
 * test connection first. Used by test suites whose subject still consumes the
 * shared singleton (e.g. `notifications/repo.test.ts`).
 */
export function _installTestDb(db: Db): void {
  const existing = getGlobalValue<Db>(GLOBAL_KEY);
  if (existing) {
    existing.close();
  }
  setGlobalValue(GLOBAL_KEY, db);
}
