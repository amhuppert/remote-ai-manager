import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  KNOWN_SCHEMA_VERSION,
  _createTestDb,
  _createTestDbAtPath,
  _resetForTesting,
  truncateAllTables,
} from "./state-db";

afterEach(() => {
  _resetForTesting();
});

const EXPECTED_TABLES = [
  "schema_migrations",
  "projects",
  "sessions",
  "conversations",
  "reference_documents",
  "notifications",
  "job_records",
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
});

describe("state-db additive column migrations", () => {
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

      const remaining = tableNames(db).filter(
        (n) => n !== "schema_migrations" && !n.startsWith("sqlite_"),
      );
      for (const t of remaining) {
        expect(countRows(db, t)).toBe(0);
      }
      expect(remaining).toContain("temp_extra_app_table");
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
