import Database from "better-sqlite3";
import { existsSync, mkdirSync, mkdtempSync } from "node:fs";
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

const SCHEMA_DDL = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version     INTEGER PRIMARY KEY,
    description TEXT NOT NULL,
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
    creation_mode                      TEXT NOT NULL DEFAULT 'fast',
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

  CREATE TABLE IF NOT EXISTS notifications (
    id             TEXT PRIMARY KEY,
    type           TEXT NOT NULL,
    title          TEXT NOT NULL,
    message        TEXT NOT NULL,
    read           INTEGER NOT NULL DEFAULT 0,
    project_name   TEXT NOT NULL,
    session_name   TEXT NOT NULL,
    branch_name    TEXT NOT NULL,
    job_id         TEXT NOT NULL,
    job_type       TEXT NOT NULL,
    merge_hash     TEXT,
    commit_hash    TEXT,
    conflict_count INTEGER,
    conflict_files TEXT,
    target_branch  TEXT,
    error_message  TEXT,
    created_at     TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_notifications_read ON notifications(read);
  CREATE INDEX IF NOT EXISTS idx_notifications_created_at ON notifications(created_at);
  CREATE INDEX IF NOT EXISTS idx_notifications_project_session
    ON notifications(project_name, session_name);

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

  DROP INDEX IF EXISTS idx_roadmap_items_project;
  DROP TABLE IF EXISTS roadmap_items;
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
];

function ensureAdditiveColumns(db: Db): void {
  for (const { table, column, type } of ADDITIVE_COLUMNS) {
    const cols = db.pragma(`table_info(${table})`) as { name: string }[];
    const exists = cols.some((c) => c.name === column);
    if (!exists) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
    }
  }
}

function initializeSchema(db: Db, dbPath: string): void {
  db.exec(SCHEMA_DDL);
  ensureAdditiveColumns(db);
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
