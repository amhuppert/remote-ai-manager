import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import os from "node:os";
import {
  KNOWN_SCHEMA_VERSION,
  SPEC_EXECUTIONS_SCHEMA_DDL,
  _createTestDb,
  _createTestDbAtPath,
  _resetForTesting,
  _setStateDbBeforeLockedInitializationHookForTesting,
  truncateAllTables,
} from "./state-db";
import {
  enforceCurrentSchemaCompatibility,
  publishSchemaCompatibilityBarrier,
  schemaCompatibilityBarrierPath,
} from "./schema-compatibility";
import { NATIVE_SDD_ATTENTION_CITATIONS_SCHEMA_VERSION } from "./migrations/0034-native-sdd-attention-citations";

afterEach(() => {
  _setStateDbBeforeLockedInitializationHookForTesting(null);
  _resetForTesting();
});

const EXPECTED_TABLES = [
  "schema_migrations",
  "applied_migrations",
  "projects",
  "sessions",
  "conversations",
  "reference_documents",
  "session_markdown_documents",
  "document_comments",
  "notifications",
  "job_records",
  "graph_workflow_result_deliveries",
] as const;

describe("state-db pragmas", () => {
  it("applies WAL, foreign_keys=ON, synchronous=FULL on a file-backed DB", () => {
    const db = _createTestDb();
    try {
      const journalRows = db.pragma("journal_mode") as {
        journal_mode: string;
      }[];
      expect(journalRows[0]?.journal_mode).toBe("wal");

      const fkRows = db.pragma("foreign_keys") as { foreign_keys: number }[];
      expect(fkRows[0]?.foreign_keys).toBe(1);

      const syncRows = db.pragma("synchronous") as { synchronous: number }[];
      expect(syncRows[0]?.synchronous).toBe(2);
    } finally {
      db.close();
    }
  });

  it("applies foreign_keys=ON and synchronous=FULL on an in-memory DB", () => {
    const db = _createTestDb({ inMemory: true });
    try {
      const fkRows = db.pragma("foreign_keys") as { foreign_keys: number }[];
      expect(fkRows[0]?.foreign_keys).toBe(1);

      const syncRows = db.pragma("synchronous") as { synchronous: number }[];
      expect(syncRows[0]?.synchronous).toBe(2);
    } finally {
      db.close();
    }
  });
});

describe("state-db schema initialization", () => {
  it("opens and upgrades a schema-10 attention database before current DDL reads schema-11 columns", () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "cc-attention-floor-"));
    const dbPath = path.join(tempDir, "command-center.db");
    const legacy = new Database(dbPath);
    legacy.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        description TEXT NOT NULL,
        applied_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO schema_migrations (version, description)
      VALUES (10, 'candidate-unstable halt vocabulary');

      CREATE TABLE projects (
        root_path TEXT PRIMARY KEY,
        archived INTEGER NOT NULL DEFAULT 0,
        pinned INTEGER NOT NULL DEFAULT 0,
        pin_order INTEGER,
        mcp_overrides TEXT,
        agent_capability_overrides TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE specs (
        id TEXT PRIMARY KEY,
        project_path TEXT NOT NULL,
        slug TEXT NOT NULL,
        name TEXT NOT NULL,
        gate_policy_json TEXT NOT NULL,
        abandoned_at TEXT,
        abandoned_reason TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE spec_aliases (
        project_path TEXT NOT NULL,
        slug TEXT NOT NULL,
        spec_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (project_path, slug)
      );
      CREATE TABLE spec_counters (
        spec_id TEXT NOT NULL,
        scope_key TEXT NOT NULL,
        last_number INTEGER NOT NULL,
        PRIMARY KEY (spec_id, scope_key)
      );
      CREATE TABLE spec_elements (
        id TEXT PRIMARY KEY,
        spec_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        number INTEGER,
        parent_element_id TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE spec_revisions (
        id TEXT PRIMARY KEY,
        spec_id TEXT NOT NULL,
        number INTEGER NOT NULL,
        state TEXT NOT NULL,
        authoring_stage TEXT NOT NULL,
        based_on_revision_id TEXT,
        content_hash TEXT,
        proposed_at TEXT,
        approved_at TEXT,
        external_delivery_json TEXT,
        created_at TEXT NOT NULL,
        UNIQUE (spec_id, number)
      );
      CREATE TABLE spec_element_versions (
        revision_id TEXT NOT NULL,
        element_id TEXT NOT NULL,
        position INTEGER NOT NULL,
        payload_json TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        element_version INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (revision_id, element_id)
      );
      CREATE TABLE spec_questions (
        id TEXT PRIMARY KEY,
        spec_id TEXT NOT NULL,
        number INTEGER NOT NULL,
        element_id TEXT,
        text TEXT NOT NULL,
        provenance_json TEXT NOT NULL,
        status TEXT NOT NULL,
        answer TEXT,
        answered_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (spec_id, number)
      );
      CREATE TABLE spec_assumptions (
        id TEXT PRIMARY KEY,
        spec_id TEXT NOT NULL,
        number INTEGER NOT NULL,
        element_id TEXT,
        text TEXT NOT NULL,
        proposed_by_json TEXT NOT NULL,
        disposition TEXT NOT NULL,
        disposed_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (spec_id, number)
      );

      INSERT INTO projects (root_path) VALUES ('/repos/attention-floor');
      INSERT INTO specs (
        id, project_path, slug, name, gate_policy_json, created_at, updated_at
      ) VALUES (
        'spec-floor', '/repos/attention-floor', 'attention-floor',
        'Attention floor', '{"preset":"contract-bearing"}',
        '2026-08-23T12:00:00.000Z', '2026-08-23T12:00:00.000Z'
      );
      INSERT INTO spec_revisions (
        id, spec_id, number, state, authoring_stage, created_at
      ) VALUES (
        'revision-floor', 'spec-floor', 1, 'draft', 'requirements',
        '2026-08-23T12:00:00.000Z'
      );
      INSERT INTO spec_questions (
        id, spec_id, number, element_id, text, provenance_json, status,
        answer, answered_at, created_at, updated_at
      ) VALUES (
        'question-floor', 'spec-floor', 1, NULL, 'Which validator?',
        '{"kind":"agent","conversationId":"conversation-floor"}',
        'open', NULL, NULL, '2026-08-23T12:00:00.000Z',
        '2026-08-23T12:00:00.000Z'
      );
      INSERT INTO spec_assumptions (
        id, spec_id, number, element_id, text, proposed_by_json,
        disposition, disposed_at, created_at, updated_at
      ) VALUES (
        'assumption-floor', 'spec-floor', 1, NULL, 'The validator is local.',
        '{"kind":"agent","conversationId":"conversation-floor"}',
        'proposed', NULL, '2026-08-23T12:00:00.000Z',
        '2026-08-23T12:00:00.000Z'
      );
    `);
    legacy.close();

    try {
      const upgraded = _createTestDbAtPath(dbPath);
      expect(
        upgraded
          .prepare(
            `SELECT record_version, withdrawn_at
             FROM spec_questions WHERE id = 'question-floor'`,
          )
          .get(),
      ).toEqual({ record_version: 1, withdrawn_at: null });
      expect(
        upgraded
          .prepare(
            `SELECT record_version, withdrawn_at, supersedes_assumption_id
             FROM spec_assumptions WHERE id = 'assumption-floor'`,
          )
          .get(),
      ).toEqual({
        record_version: 1,
        withdrawn_at: null,
        supersedes_assumption_id: null,
      });
      expect(
        upgraded
          .prepare(
            `SELECT citation_contract_version, citation_version
             FROM spec_revisions WHERE id = 'revision-floor'`,
          )
          .get(),
      ).toEqual({ citation_contract_version: 2, citation_version: 1 });
      expect(
        upgraded
          .prepare(
            `SELECT name FROM sqlite_master
             WHERE type = 'table'
               AND name = 'spec_revision_assumption_citations'`,
          )
          .get(),
      ).toEqual({ name: "spec_revision_assumption_citations" });
      expect(
        upgraded
          .prepare(
            "SELECT description FROM schema_migrations WHERE version = 11",
          )
          .get(),
      ).toEqual({
        description:
          "native-SDD attention lifecycle and revision-owned assumption citations",
      });
      expect(
        JSON.parse(
          readFileSync(
            schemaCompatibilityBarrierPath(
              tempDir,
              NATIVE_SDD_ATTENTION_CITATIONS_SCHEMA_VERSION,
            ),
            "utf8",
          ),
        ),
      ).toEqual({ version: NATIVE_SDD_ATTENTION_CITATIONS_SCHEMA_VERSION });
      upgraded.close();

      const reopened = _createTestDbAtPath(dbPath);
      expect(reopened.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      reopened.close();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("rebuilds legacy spec launch storage without a saved-definition projection", () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "cc-direct-launch-"));
    const dbPath = path.join(tempDir, "command-center.db");
    const legacy = new Database(dbPath);
    legacy.exec(`
      CREATE TABLE spec_executions (
        id TEXT PRIMARY KEY,
        spec_id TEXT NOT NULL,
        revision_id TEXT NOT NULL,
        scope_json TEXT NOT NULL,
        state TEXT NOT NULL,
        cleanup_phase TEXT,
        linked_workflow_execution_id TEXT,
        cleanup_last_error TEXT,
        cleanup_last_error_at TEXT,
        execution_start_dial TEXT,
        workflow_definition_id TEXT NOT NULL,
        workflow_definition_revision INTEGER,
        workflow_execution_id TEXT,
        session_name TEXT,
        delivered_at TEXT,
        abandoned_reason TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE spec_delivery_plan_candidates (
        id TEXT PRIMARY KEY,
        attempt_id TEXT NOT NULL,
        snapshot_id TEXT NOT NULL UNIQUE,
        compiled_definition_hash TEXT NOT NULL,
        launch_json TEXT NOT NULL,
        binding_json TEXT NOT NULL,
        materialized_at TEXT NOT NULL
      );
      CREATE TABLE spec_delivery_plan_snapshots (
        id TEXT PRIMARY KEY,
        attempt_id TEXT NOT NULL,
        draft_revision INTEGER NOT NULL,
        plan_hash TEXT NOT NULL,
        content_json TEXT NOT NULL,
        pinned_revision_id TEXT NOT NULL,
        proposed_at TEXT NOT NULL,
        proposed_by_json TEXT NOT NULL
      );
    `);
    legacy.close();

    const db = _createTestDbAtPath(dbPath);
    try {
      const executionColumns = db.pragma(
        "table_info(spec_executions)",
      ) as Array<{
        name: string;
        notnull: number;
      }>;
      expect(
        executionColumns.find(
          (column) => column.name === "workflow_definition_id",
        ),
      ).toMatchObject({ notnull: 0 });
      expect(
        executionColumns.find(
          (column) => column.name === "workflow_seed_source_json",
        ),
      ).toBeDefined();

      // The compiled candidate was a second artifact an approval could have
      // meant. Version 2 signs the snapshot bytes themselves, so the table and
      // the plan hash beside it are gone rather than merely unread.
      const tables = (
        db
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
          .all() as Array<{ name: string }>
      ).map((row) => row.name);
      expect(tables).not.toContain("spec_delivery_plan_candidates");

      const snapshotColumns = db.pragma(
        "table_info(spec_delivery_plan_snapshots)",
      ) as Array<{ name: string; notnull: number }>;
      expect(snapshotColumns.map((column) => column.name)).not.toContain(
        "plan_hash",
      );
      expect(
        snapshotColumns.find((column) => column.name === "candidate_hash"),
      ).toMatchObject({ notnull: 1 });
    } finally {
      db.close();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("preserves child links while rebuilding legacy spec executions", () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "cc-direct-launch-fk-"));
    const dbPath = path.join(tempDir, "command-center.db");
    const seeded = _createTestDbAtPath(dbPath);
    seeded.exec(`
      INSERT INTO projects (root_path) VALUES ('/repos/direct-launch-fk');
      INSERT INTO specs (
        id, project_path, slug, name, gate_policy_json, created_at, updated_at
      ) VALUES (
        'spec-direct-launch-fk', '/repos/direct-launch-fk', 'direct-launch-fk',
        'Direct launch FK', '{"preset":"balanced"}',
        '2026-08-15T12:00:00.000Z', '2026-08-15T12:00:00.000Z'
      );
      INSERT INTO spec_revisions (
        id, spec_id, number, state, authoring_stage, created_at
      ) VALUES (
        'revision-direct-launch-fk', 'spec-direct-launch-fk', 1, 'approved',
        'plan', '2026-08-15T12:00:00.000Z'
      );
      INSERT INTO spec_executions (
        id, spec_id, revision_id, scope_json, state, workflow_definition_id,
        created_at, updated_at
      ) VALUES (
        'execution-direct-launch-fk', 'spec-direct-launch-fk',
        'revision-direct-launch-fk', '{}', 'running', 'definition-legacy',
        '2026-08-15T12:00:00.000Z', '2026-08-15T12:00:00.000Z'
      );
      INSERT INTO spec_gate_admissions (
        id, spec_id, gate, basis, revision_id, execution_id, actor_json,
        created_at
      ) VALUES (
        'admission-direct-launch-fk', 'spec-direct-launch-fk',
        'execution_start', 'off_policy', 'revision-direct-launch-fk',
        'execution-direct-launch-fk', '{}', '2026-08-15T12:00:00.000Z'
      );
    `);
    seeded.close();

    const legacy = new Database(dbPath);
    legacy.pragma("foreign_keys = OFF");
    legacy.pragma("legacy_alter_table = ON");
    legacy.exec(`
      DROP INDEX IF EXISTS idx_spec_executions_spec_state;
      DROP INDEX IF EXISTS uq_spec_executions_workflow_execution;
      ALTER TABLE spec_executions RENAME TO spec_executions_current;
    `);
    legacy.exec(
      SPEC_EXECUTIONS_SCHEMA_DDL.replace(
        "workflow_definition_id TEXT,",
        "workflow_definition_id TEXT NOT NULL,",
      ),
    );
    legacy.exec(`
      INSERT INTO spec_executions SELECT * FROM spec_executions_current;
      DROP TABLE spec_executions_current;
    `);
    legacy.close();

    const migrated = _createTestDbAtPath(dbPath);
    try {
      expect(
        migrated
          .prepare("SELECT execution_id FROM spec_gate_admissions WHERE id = ?")
          .get("admission-direct-launch-fk"),
      ).toEqual({ execution_id: "execution-direct-launch-fk" });
      expect(
        migrated.pragma("foreign_key_check") as Array<Record<string, unknown>>,
      ).toEqual([]);
      expect(migrated.pragma("foreign_keys", { simple: true })).toBe(1);
      expect(migrated.pragma("legacy_alter_table", { simple: true })).toBe(0);
    } finally {
      migrated.close();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("creates every required table", () => {
    const db = _createTestDb({ inMemory: true });
    try {
      const rows = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all() as { name: string }[];
      const tableNames = new Set(rows.map((r) => r.name));
      for (const expected of EXPECTED_TABLES) {
        expect(tableNames.has(expected)).toBe(true);
      }
    } finally {
      db.close();
    }
  });

  it("exposes the document_comments table and its lookup index on a fresh in-memory DB", () => {
    const db = _createTestDb({ inMemory: true });
    try {
      const table = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'document_comments'",
        )
        .get() as { name: string } | undefined;
      expect(table?.name).toBe("document_comments");

      const index = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_document_comments_doc'",
        )
        .get() as { name: string } | undefined;
      expect(index?.name).toBe("idx_document_comments_doc");
    } finally {
      db.close();
    }
  });

  it("is idempotent across repeated opens against the same file", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cc-state-db-test-"));
    const dbPath = path.join(dir, "command-center.db");

    const first = _createTestDbAtPath(dbPath);
    first.close();

    const second = _createTestDbAtPath(dbPath);
    try {
      const rows = second
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all() as { name: string }[];
      const tableNames = new Set(rows.map((r) => r.name));
      for (const expected of EXPECTED_TABLES) {
        expect(tableNames.has(expected)).toBe(true);
      }
    } finally {
      second.close();
    }
  });

  it("rebuilds the previous notification schema for spec notifications without losing rows", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cc-state-db-test-"));
    const dbPath = path.join(dir, "command-center.db");
    const legacy = new Database(dbPath);
    legacy.exec(`
      CREATE TABLE notifications (
        id TEXT PRIMARY KEY,
        source TEXT NOT NULL DEFAULT 'job',
        type TEXT NOT NULL,
        title TEXT NOT NULL,
        message TEXT NOT NULL,
        read INTEGER NOT NULL DEFAULT 0,
        project_name TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        session_name TEXT,
        branch_name TEXT,
        job_id TEXT,
        job_type TEXT,
        merge_hash TEXT,
        commit_hash TEXT,
        conflict_count INTEGER,
        conflict_files TEXT,
        target_branch TEXT,
        conversation_id TEXT,
        conversation_name TEXT,
        conversation_status TEXT,
        dedupe_key TEXT,
        error_message TEXT
      )
    `);
    legacy
      .prepare(
        `INSERT INTO notifications (
           id, source, type, title, message, project_name, session_name,
           branch_name, job_id, job_type
         ) VALUES (?, 'job', ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "legacy-notification",
        "merge-completed",
        "Merge complete",
        "Done",
        "cc",
        "session",
        "branch",
        "job-1",
        "merge",
      );
    legacy.close();

    const reopened = _createTestDbAtPath(dbPath);
    try {
      const columns = reopened.pragma("table_info(notifications)") as {
        name: string;
      }[];
      expect(columns.map((column) => column.name)).toEqual(
        expect.arrayContaining([
          "spec_id",
          "spec_gate_request_id",
          "spec_deep_link_id",
        ]),
      );
      expect(
        reopened
          .prepare("SELECT id FROM notifications WHERE id = ?")
          .get("legacy-notification"),
      ).toEqual({ id: "legacy-notification" });
      expect(() =>
        reopened
          .prepare(
            `INSERT INTO notifications (
               id, source, type, title, message, project_name, spec_id,
               spec_slug, spec_name, spec_gate, spec_gate_request_id,
               spec_deep_link_id
             ) VALUES (?, 'spec', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            "spec-notification",
            "spec-approval-requested",
            "Review needed",
            "Approve design",
            "cc",
            "spec-1",
            "native-sdd",
            "Native SDD",
            "design",
            "request-1",
            "D2",
          ),
      ).not.toThrow();
    } finally {
      reopened.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("state-db additive column migrations", () => {
  it("adds validation session attribution on reopen without disturbing retained rows", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cc-state-db-test-"));
    const dbPath = path.join(dir, "command-center.db");

    const first = _createTestDbAtPath(dbPath);
    first
      .prepare(
        `INSERT INTO validation_runs (
           run_id, source, command_name, cost, queue_order, status, nonce,
           project_path, worktree_path, conversation_id, submitted_at,
           scoped, scoped_path_count, timed_out
         ) VALUES (
           'vr-legacy', 'agent_cli', 'test', 8, 0, 'passed', 'nonce-legacy',
           '/p', '/p/.worktrees/s', 'conversation-preserved',
           '2026-08-05T10:00:00.000Z', 0, 0, 0
         )`,
      )
      .run();
    first.close();

    const legacy = new Database(dbPath);
    legacy.exec("ALTER TABLE validation_runs DROP COLUMN session_name");
    const legacyColumns = legacy.pragma(
      "table_info(validation_runs)",
    ) as Array<{
      name: string;
    }>;
    expect(legacyColumns.some((column) => column.name === "session_name")).toBe(
      false,
    );
    legacy.close();

    const reopened = _createTestDbAtPath(dbPath);
    try {
      const columns = reopened.pragma("table_info(validation_runs)") as Array<{
        name: string;
      }>;
      expect(columns.some((column) => column.name === "session_name")).toBe(
        true,
      );
      expect(
        reopened
          .prepare(
            "SELECT session_name, conversation_id FROM validation_runs WHERE run_id = 'vr-legacy'",
          )
          .get(),
      ).toEqual({
        session_name: null,
        conversation_id: "conversation-preserved",
      });
    } finally {
      reopened.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("adds pending_prompt_text to a pre-existing conversations table that lacks it", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cc-state-db-test-"));
    const dbPath = path.join(dir, "command-center.db");

    const legacy = new Database(dbPath);
    legacy.exec(`
      CREATE TABLE conversations (
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
        forked_from           TEXT,
        role                  TEXT,
        context_tokens        INTEGER,
        context_window_max    INTEGER,
        debug_mode            TEXT,
        machine_snapshot      TEXT,
        agent_backend         TEXT NOT NULL DEFAULT 'claude',
        backend_ref           TEXT,
        mcp_overrides         TEXT,
        mcp_runtime           TEXT
      )
    `);
    const preCols = legacy.pragma("table_info(conversations)") as {
      name: string;
    }[];
    expect(preCols.some((c) => c.name === "pending_prompt_text")).toBe(false);
    legacy.close();

    const reopened = _createTestDbAtPath(dbPath);
    try {
      const postCols = reopened.pragma("table_info(conversations)") as {
        name: string;
      }[];
      expect(postCols.some((c) => c.name === "pending_prompt_text")).toBe(true);
    } finally {
      reopened.close();
    }
  });

  it("is a no-op when pending_prompt_text already exists (idempotent)", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cc-state-db-test-"));
    const dbPath = path.join(dir, "command-center.db");

    const first = _createTestDbAtPath(dbPath);
    first.close();

    expect(() => {
      const second = _createTestDbAtPath(dbPath);
      second.close();
    }).not.toThrow();
  });

  it("adds final_publish to a pre-existing job_records table", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cc-state-db-test-"));
    const dbPath = path.join(dir, "command-center.db");
    const legacy = new Database(dbPath);
    legacy.exec(`
      CREATE TABLE job_records (
        job_id TEXT PRIMARY KEY,
        job_type TEXT NOT NULL,
        status TEXT NOT NULL,
        project_name TEXT NOT NULL,
        session_name TEXT NOT NULL,
        branch_name TEXT NOT NULL,
        started_at TEXT NOT NULL,
        completed_at TEXT,
        merge_hash TEXT,
        commit_hash TEXT,
        conflict_count INTEGER,
        conflict_files TEXT,
        error_message TEXT,
        owner_pid INTEGER,
        execution_id TEXT,
        candidate_validation TEXT
      )
    `);
    legacy.close();

    const reopened = _createTestDbAtPath(dbPath);
    try {
      const columns = reopened.pragma("table_info(job_records)") as {
        name: string;
        notnull: number;
        dflt_value: string | null;
      }[];
      expect(columns).toContainEqual(
        expect.objectContaining({
          name: "final_publish",
          notnull: 1,
          dflt_value: "0",
        }),
      );
    } finally {
      reopened.close();
    }
  });
});

describe("truncateAllTables", () => {
  function tableNames(db: InstanceType<typeof Database>): string[] {
    const rows = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as { name: string }[];
    return rows.map((r) => r.name);
  }

  function countRows(db: InstanceType<typeof Database>, table: string): number {
    const row = db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get() as {
      n: number;
    };
    return row.n;
  }

  function seedFkChain(db: InstanceType<typeof Database>): void {
    db.prepare("INSERT INTO projects (root_path) VALUES (?)").run("/p1");
    db.prepare(
      `INSERT INTO sessions
         (project_path, session_name, worktree_path, branch_name, created_at, last_activity_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      "/p1",
      "s1",
      "/wt/s1",
      "csm/s1",
      "2026-01-01T00:00:00Z",
      "2026-01-01T00:00:00Z",
    );
    db.prepare(
      `INSERT INTO conversations
         (id, project_path, session_name, status, created_at, last_activity_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      "c1",
      "/p1",
      "s1",
      "active",
      "2026-01-01T00:00:00Z",
      "2026-01-01T00:00:00Z",
    );
    db.prepare(
      `INSERT INTO reference_documents
         (id, project_path, session_name, file_path, description, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      "rd1",
      "/p1",
      "s1",
      "memory-bank/focus.md",
      "focus",
      "2026-01-01T00:00:00Z",
    );
    db.prepare(
      `INSERT INTO notifications
         (id, type, title, message, project_name, session_name, branch_name, job_id, job_type)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run("n1", "merge", "t", "m", "/p1", "s1", "csm/s1", "j1", "merge");
    db.prepare(
      `INSERT INTO job_records
         (job_id, job_type, status, project_name, session_name, branch_name, started_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "j1",
      "merge",
      "running",
      "/p1",
      "s1",
      "csm/s1",
      "2026-01-01T00:00:00Z",
    );
  }

  it("empties every application table while leaving schema_migrations and its row intact", () => {
    const db = _createTestDb({ inMemory: true });
    try {
      seedFkChain(db);
      db.prepare(
        "INSERT INTO schema_migrations (version, description) VALUES (?, ?)",
      ).run(KNOWN_SCHEMA_VERSION, "baseline");

      const appTables = [
        "projects",
        "sessions",
        "conversations",
        "reference_documents",
        "notifications",
        "job_records",
      ] as const;
      for (const t of appTables) {
        expect(countRows(db, t)).toBeGreaterThan(0);
      }

      truncateAllTables(db);

      for (const t of appTables) {
        expect(countRows(db, t)).toBe(0);
      }
      expect(tableNames(db)).toContain("schema_migrations");
      expect(countRows(db, "schema_migrations")).toBe(1);
    } finally {
      db.close();
    }
  });

  it("clears a runtime-created application table without a hand-maintained list (Req 4.3)", () => {
    const db = _createTestDb({ inMemory: true });
    try {
      db.exec(
        "CREATE TABLE temp_extra_app_table (id TEXT PRIMARY KEY, value TEXT)",
      );
      db.prepare(
        "INSERT INTO temp_extra_app_table (id, value) VALUES (?, ?)",
      ).run("x", "y");
      expect(countRows(db, "temp_extra_app_table")).toBe(1);

      truncateAllTables(db);

      // A virtual table's shadow tables (`memory_notes_fts_data` and friends)
      // hold SQLite's own structural records, never application rows, and
      // refuse direct modification: the reset clears the virtual table and
      // leaves its shadows to SQLite.
      const shadowTables = new Set(
        (
          db.pragma("table_list") as Array<{
            schema: string;
            name: string;
            type: string;
          }>
        )
          .filter((row) => row.schema === "main" && row.type === "shadow")
          .map((row) => row.name),
      );
      const remaining = tableNames(db).filter(
        (n) =>
          n !== "schema_migrations" &&
          !n.startsWith("sqlite_") &&
          !shadowTables.has(n),
      );
      for (const t of remaining) {
        expect(countRows(db, t)).toBe(0);
      }
      expect(remaining).toContain("temp_extra_app_table");
      expect(remaining).toContain("memory_notes_fts");
    } finally {
      db.close();
    }
  });

  it("leaves a freshly reset DB able to reopen and pass the forward-only version check", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cc-state-db-test-"));
    const dbPath = path.join(dir, "command-center.db");

    const db = _createTestDbAtPath(dbPath);
    seedFkChain(db);
    truncateAllTables(db);
    db.close();

    const reopened = _createTestDbAtPath(dbPath);
    try {
      expect(reopened.open).toBe(true);
    } finally {
      reopened.close();
    }
  });
});

describe("state-db forward-only schema_migrations conflict policy", () => {
  it("rechecks a barrier published after preflight under the initialization lock", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cc-state-db-test-"));
    const dbPath = path.join(dir, "command-center.db");
    const bootstrap = new Database(dbPath);
    bootstrap.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        description TEXT NOT NULL
      );
    `);
    bootstrap.close();

    const futureVersion = KNOWN_SCHEMA_VERSION + 1;
    _setStateDbBeforeLockedInitializationHookForTesting(() => {
      writeFileSync(
        schemaCompatibilityBarrierPath(dir, futureVersion),
        JSON.stringify({ version: futureVersion }),
      );
    });

    try {
      expect(() => _createTestDbAtPath(dbPath)).toThrow(
        /schema version|refus/i,
      );

      const probe = new Database(dbPath);
      try {
        const journalRows = probe.pragma("journal_mode") as Array<{
          journal_mode: string;
        }>;
        expect(journalRows[0]?.journal_mode).toBe("delete");
        const tables = probe
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
          .pluck()
          .all();
        expect(tables).toEqual(["schema_migrations"]);
      } finally {
        probe.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not change journal mode when a future version wins before the locked recheck", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cc-state-db-test-"));
    const dbPath = path.join(dir, "command-center.db");
    const bootstrap = new Database(dbPath);
    bootstrap.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        description TEXT NOT NULL
      );
    `);
    bootstrap.close();

    _setStateDbBeforeLockedInitializationHookForTesting(() => {
      const newer = new Database(dbPath);
      newer
        .prepare(
          "INSERT INTO schema_migrations (version, description) VALUES (?, ?)",
        )
        .run(KNOWN_SCHEMA_VERSION + 1, "newer build won startup race");
      newer.close();
    });

    try {
      expect(() => _createTestDbAtPath(dbPath)).toThrow(
        /schema version|refus/i,
      );

      const probe = new Database(dbPath);
      try {
        const journalRows = probe.pragma("journal_mode") as Array<{
          journal_mode: string;
        }>;
        expect(journalRows[0]?.journal_mode).toBe("delete");
      } finally {
        probe.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses a future version committed only in WAL without changing any DB or sidecar bytes", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cc-state-db-test-"));
    const dbPath = path.join(dir, "command-center.db");
    const workflowsDir = path.join(dir, "workflows");
    const workflowPath = path.join(workflowsDir, "future-workflow.json");
    mkdirSync(workflowsDir);
    writeFileSync(workflowPath, '{"from":"future-build"}');

    const futureVersion = KNOWN_SCHEMA_VERSION + 1;
    const futureDb = new Database(dbPath);
    futureDb.pragma("journal_mode = WAL");
    futureDb.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        description TEXT NOT NULL,
        applied_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
    futureDb.pragma("wal_checkpoint(TRUNCATE)");
    futureDb
      .prepare(
        "INSERT INTO schema_migrations (version, description) VALUES (?, ?)",
      )
      .run(futureVersion, "future migration in WAL");
    await publishSchemaCompatibilityBarrier(dir, futureVersion);

    const snapshotBytes = (): Record<string, string> =>
      Object.fromEntries(
        readdirSync(dir)
          .sort()
          .filter((name) => name !== "workflows")
          .map((name) => {
            const bytes = readFileSync(path.join(dir, name));
            return [name, createHash("sha256").update(bytes).digest("hex")];
          }),
      );

    try {
      expect(existsSync(`${dbPath}-wal`)).toBe(true);
      expect(existsSync(`${dbPath}-shm`)).toBe(true);
      expect(
        existsSync(schemaCompatibilityBarrierPath(dir, futureVersion)),
      ).toBe(true);
      const before = snapshotBytes();

      expect(() => _createTestDbAtPath(dbPath)).toThrow(
        /schema version|refus/i,
      );

      expect(snapshotBytes()).toEqual(before);
      expect(readFileSync(workflowPath, "utf-8")).toBe(
        '{"from":"future-build"}',
      );
    } finally {
      futureDb.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects a future-version database before changing its schema, data, or workflow files", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cc-state-db-test-"));
    const dbPath = path.join(dir, "command-center.db");
    const workflowsDir = path.join(dir, "workflows");
    const workflowPath = path.join(workflowsDir, "future-workflow.json");
    mkdirSync(workflowsDir);
    writeFileSync(workflowPath, '{"from":"future-build"}');

    const futureDb = new Database(dbPath);
    futureDb.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        description TEXT NOT NULL,
        applied_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO schema_migrations (version, description)
      VALUES (${KNOWN_SCHEMA_VERSION + 1}, 'future migration');
    `);
    futureDb.close();

    try {
      expect(() => _createTestDbAtPath(dbPath)).toThrow(
        /schema version|refus/i,
      );

      const probe = new Database(dbPath);
      try {
        const tables = probe
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
          )
          .all() as Array<{ name: string }>;
        expect(tables.map((row) => row.name)).toEqual(["schema_migrations"]);
        expect(
          probe
            .prepare("SELECT description FROM schema_migrations")
            .pluck()
            .all(),
        ).toEqual(["future migration"]);
      } finally {
        probe.close();
      }
      expect(existsSync(workflowPath)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses to open when schema_migrations records a version greater than KNOWN_SCHEMA_VERSION", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cc-state-db-test-"));
    const dbPath = path.join(dir, "command-center.db");

    const initial = _createTestDbAtPath(dbPath);
    initial
      .prepare(
        "INSERT INTO schema_migrations (version, description) VALUES (?, ?)",
      )
      .run(KNOWN_SCHEMA_VERSION + 1, "future migration");
    initial.close();

    expect(() => _createTestDbAtPath(dbPath)).toThrow(/schema version|refus/i);
  });

  it("opens cleanly when no migration row records a version greater than KNOWN_SCHEMA_VERSION", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cc-state-db-test-"));
    const dbPath = path.join(dir, "command-center.db");

    const initial = _createTestDbAtPath(dbPath);
    if (KNOWN_SCHEMA_VERSION > 0) {
      initial
        .prepare(
          "INSERT INTO schema_migrations (version, description) VALUES (?, ?)",
        )
        .run(KNOWN_SCHEMA_VERSION, "current migration");
    }
    initial.close();

    const reopened = _createTestDbAtPath(dbPath);
    try {
      expect(reopened.open).toBe(true);
    } finally {
      reopened.close();
    }
  });

  it("closes the underlying connection when refusing to open", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cc-state-db-test-"));
    const dbPath = path.join(dir, "command-center.db");

    const initial = _createTestDbAtPath(dbPath);
    initial
      .prepare(
        "INSERT INTO schema_migrations (version, description) VALUES (?, ?)",
      )
      .run(KNOWN_SCHEMA_VERSION + 5, "future");
    initial.close();

    expect(() => _createTestDbAtPath(dbPath)).toThrow();

    const probe = new Database(dbPath);
    try {
      probe.prepare("SELECT 1 AS ok").get();
    } finally {
      probe.close();
    }
  });
});

describe("state-db breaking-cutover versions", () => {
  it("this build fences continuous spec review at schema version 23", () => {
    expect(KNOWN_SCHEMA_VERSION).toBe(23);
  });

  it("refuses a version-12 binary after ticket relationships stamp version 13", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cc-state-db-test-"));
    const dbPath = path.join(dir, "command-center.db");
    const current = new Database(dbPath);
    current.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        description TEXT NOT NULL,
        applied_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO schema_migrations (version, description)
      VALUES (13, 'ticket relationships and append-only status updates');
    `);
    current.close();

    const oldBinaryConnection = new Database(dbPath);
    try {
      expect(() =>
        enforceCurrentSchemaCompatibility(oldBinaryConnection, dbPath, 12),
      ).toThrow(/recorded schema version 13.*known build version 12/i);
    } finally {
      oldBinaryConnection.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses a version-13 binary after managed definitions stamp version 14", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cc-state-db-test-"));
    const dbPath = path.join(dir, "command-center.db");
    const current = new Database(dbPath);
    current.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        description TEXT NOT NULL,
        applied_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO schema_migrations (version, description)
      VALUES (14, 'native SDD managed workflow definitions');
    `);
    current.close();

    const oldBinaryConnection = new Database(dbPath);
    try {
      expect(() =>
        enforceCurrentSchemaCompatibility(oldBinaryConnection, dbPath, 13),
      ).toThrow(/recorded schema version 14.*known build version 13/i);
    } finally {
      oldBinaryConnection.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses a version-14 binary after conversation checkpoints stamp version 15", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cc-state-db-test-"));
    const dbPath = path.join(dir, "command-center.db");
    const current = new Database(dbPath);
    current.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        description TEXT NOT NULL,
        applied_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO schema_migrations (version, description)
      VALUES (15, 'durable conversation checkpoint operations');
    `);
    current.close();

    const oldBinaryConnection = new Database(dbPath);
    try {
      expect(() =>
        enforceCurrentSchemaCompatibility(oldBinaryConnection, dbPath, 14),
      ).toThrow(/recorded schema version 15.*known build version 14/i);
    } finally {
      oldBinaryConnection.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("opens a DB stamped at this build's version but refuses one stamped above it (an older build's DB advanced past this)", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cc-state-db-test-"));
    const dbPath = path.join(dir, "command-center.db");

    const stamped = _createTestDbAtPath(dbPath);
    stamped
      .prepare(
        "INSERT OR IGNORE INTO schema_migrations (version, description) VALUES (?, ?)",
      )
      .run(KNOWN_SCHEMA_VERSION, "this build's newest breaking cutover");
    stamped.close();

    // A build that knows this version reopens cleanly.
    const reopened = _createTestDbAtPath(dbPath);
    expect(reopened.open).toBe(true);
    reopened
      .prepare(
        "INSERT INTO schema_migrations (version, description) VALUES (?, ?)",
      )
      .run(KNOWN_SCHEMA_VERSION + 1, "a future breaking migration");
    reopened.close();

    // Now the recorded MAX(version) exceeds what this build knows, so the
    // forward-only gate refuses to open — the cutover's whole point.
    expect(() => _createTestDbAtPath(dbPath)).toThrow(/schema version|refus/i);
  });
});
